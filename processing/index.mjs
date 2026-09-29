// Telemetry processor: validation, delay prediction, crowd classification,
// DynamoDB storage and alerts. Deployed as the Lambda function transit-processor.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

// Tunable settings
export const SETTINGS = {
  EMA_ALPHA: 0.3,          // weight of the newest reading in the moving average
  MIN_SPEED_KMH: 3,        // avoid divide-by-zero / silly ETAs when stopped
  DELAY_BANDS: { early: -60, minor: 120, major: 300 }, // seconds
  CROWD_BANDS: { moderate: 50, high: 75, full: 95 },   // smoothed occupancy %
  HISTORY_TTL_DAYS: 7,
};

const REQUIRED = ['vehicle_id', 'route_id', 'timestamp', 'sent_at_ms', 'seq',
  'lat', 'lon', 'speed_kmh', 'occupancy_pct', 'distance_to_next_stop_km',
  'scheduled_arrival_next_stop'];

// Processing logic (no AWS calls)

export function validate(msg) {
  if (!msg || typeof msg !== 'object') return 'not an object';
  for (const f of REQUIRED) {
    if (msg[f] === undefined || msg[f] === null || msg[f] === '') return `missing ${f}`;
  }
  if (msg.lat < -90 || msg.lat > 90 || msg.lon < -180 || msg.lon > 180) return 'lat/lon out of range';
  if (msg.speed_kmh < 0 || msg.speed_kmh > 200) return 'speed out of range';
  if (msg.occupancy_pct < 0 || msg.occupancy_pct > 100) return 'occupancy out of range';
  if (Number.isNaN(Date.parse(msg.scheduled_arrival_next_stop))) return 'bad scheduled_arrival_next_stop';
  return null;
}

export function ema(previous, current, alpha = SETTINGS.EMA_ALPHA) {
  if (previous === undefined || previous === null) return current;
  return alpha * current + (1 - alpha) * previous;
}

export function classifyCrowd(pct) {
  const b = SETTINGS.CROWD_BANDS;
  if (pct >= b.full) return 'full';
  if (pct >= b.high) return 'high';
  if (pct >= b.moderate) return 'moderate';
  return 'low';
}

export function classifyDelay(delaySeconds) {
  const b = SETTINGS.DELAY_BANDS;
  if (delaySeconds >= b.major) return 'major_delay';
  if (delaySeconds >= b.minor) return 'minor_delay';
  if (delaySeconds < b.early) return 'early';
  return 'on_time';
}

export function etaSeconds(distanceKm, speedKmh) {
  if (distanceKm <= 0.02) return 0; // effectively at the stop
  return (distanceKm / Math.max(speedKmh, SETTINGS.MIN_SPEED_KMH)) * 3600;
}

export function processTelemetry(msg, prev, nowMs = Date.now(), pipeline = 'lambda') {
  const newTrip = !prev || prev.trip_id !== msg.trip_id;
  const smoothedSpeed = newTrip ? msg.speed_kmh : ema(prev.smoothed_speed_kmh, msg.speed_kmh);
  const smoothedOcc = prev ? ema(prev.smoothed_occupancy_pct, msg.occupancy_pct) : msg.occupancy_pct;

  let delaySeconds = 0;
  let delayStatus = 'layover';
  let etaSec = 0;
  if (msg.status !== 'layover') {
    etaSec = etaSeconds(msg.distance_to_next_stop_km, smoothedSpeed);
    const predictedArrivalMs = nowMs + etaSec * 1000;
    delaySeconds = Math.round((predictedArrivalMs - Date.parse(msg.scheduled_arrival_next_stop)) / 1000);
    delayStatus = classifyDelay(delaySeconds);
  }
  const crowdLevel = classifyCrowd(smoothedOcc);

  const gap = prev && typeof prev.seq === 'number' ? Math.max(0, msg.seq - prev.seq - 1) : 0;
  const latencyMs = nowMs - msg.sent_at_ms;

  const state = {
    vehicle_id: msg.vehicle_id,
    route_id: msg.route_id,
    route_name: msg.route_name,
    mode: msg.mode,
    trip_id: msg.trip_id,
    seq: msg.seq,
    lat: msg.lat,
    lon: msg.lon,
    speed_kmh: msg.speed_kmh,
    smoothed_speed_kmh: Number(smoothedSpeed.toFixed(2)),
    occupancy_pct: msg.occupancy_pct,
    smoothed_occupancy_pct: Number(smoothedOcc.toFixed(2)),
    crowd_level: crowdLevel,
    next_stop: msg.next_stop,
    distance_to_next_stop_km: msg.distance_to_next_stop_km,
    scheduled_arrival_next_stop: msg.scheduled_arrival_next_stop,
    predicted_arrival_next_stop: new Date(nowMs + etaSec * 1000).toISOString(),
    delay_seconds: delaySeconds,
    delay_status: delayStatus,
    direction: msg.direction,
    status: msg.status || 'in_service',
    last_seen: msg.timestamp,
    sent_at_ms: msg.sent_at_ms,
    processed_at_ms: nowMs,
    latency_ms: latencyMs,
    missed_messages: (prev?.missed_messages || 0) + gap,
    messages_processed: (prev?.messages_processed || 0) + 1,
    pipeline,
  };

  const history = {
    ...state,
    ts: msg.sent_at_ms, // sort key
    run_id: msg.run_id || 'none',
    expires_at: Math.floor(nowMs / 1000) + SETTINGS.HISTORY_TTL_DAYS * 86400,
  };
  delete history.missed_messages;
  delete history.messages_processed;

  const alerts = [];
  if (delayStatus === 'major_delay' && prev?.delay_status !== 'major_delay') {
    alerts.push({
      type: 'DELAY', severity: 'high', vehicle_id: msg.vehicle_id, route_id: msg.route_id,
      message: `${msg.vehicle_id} on ${msg.route_name || msg.route_id} is running about ${Math.round(delaySeconds / 60)} min late to ${msg.next_stop}`,
      delay_seconds: delaySeconds, at: new Date(nowMs).toISOString(),
    });
  }
  if (crowdLevel === 'full' && prev?.crowd_level !== 'full') {
    alerts.push({
      type: 'CROWD', severity: 'medium', vehicle_id: msg.vehicle_id, route_id: msg.route_id,
      message: `${msg.vehicle_id} on ${msg.route_name || msg.route_id} is full (${Math.round(smoothedOcc)}%) - next service recommended`,
      occupancy_pct: Number(smoothedOcc.toFixed(1)), at: new Date(nowMs).toISOString(),
    });
  }

  return { state, history, alerts, latencyMs, gap };
}

// AWS I/O
const REGION = process.env.AWS_REGION || 'us-east-1';
const STATE_TABLE = process.env.STATE_TABLE || 'TransitVehicleState';
const HISTORY_TABLE = process.env.HISTORY_TABLE || 'TransitTelemetry';
const IOT_ENDPOINT = process.env.IOT_ENDPOINT || '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const iot = IOT_ENDPOINT
  ? new IoTDataPlaneClient({ region: REGION, endpoint: `https://${IOT_ENDPOINT}` })
  : null;

export async function handleMessage(msg, pipeline = process.env.PIPELINE || 'lambda') {
  const startedMs = Date.now();
  const invalid = validate(msg);
  if (invalid) {
    console.log(JSON.stringify({ level: 'warn', event: 'rejected', reason: invalid, vehicle_id: msg?.vehicle_id }));
    return { rejected: invalid };
  }

  const prevRes = await ddb.send(new GetCommand({ TableName: STATE_TABLE, Key: { vehicle_id: msg.vehicle_id } }));
  const prev = prevRes.Item;

  // Ignore messages that arrive out of order (older than what we already have).
  if (prev && typeof prev.sent_at_ms === 'number' && msg.sent_at_ms <= prev.sent_at_ms) {
    return { skipped: 'out_of_order' };
  }

  const nowMs = Date.now();
  const { state, history, alerts, latencyMs } = processTelemetry(msg, prev, nowMs, pipeline);

  await Promise.all([
    ddb.send(new PutCommand({ TableName: STATE_TABLE, Item: state })),
    ddb.send(new PutCommand({ TableName: HISTORY_TABLE, Item: history })),
    ...alerts.map((a) => publishAlert(a)),
  ]);

  const processingMs = Date.now() - startedMs;
  // CloudWatch Embedded Metric Format: CloudWatch turns this log line into
  // the metrics SmartTransit/EndToEndLatency and SmartTransit/ProcessingTime.
  // (The baseline server sets LOG_METRICS=false so its console stays readable.)
  if (process.env.LOG_METRICS !== 'false') console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'SmartTransit',
        Dimensions: [['Pipeline']],
        Metrics: [
          { Name: 'EndToEndLatency', Unit: 'Milliseconds' },
          { Name: 'ProcessingTime', Unit: 'Milliseconds' },
          { Name: 'MessagesProcessed', Unit: 'Count' },
        ],
      }],
    },
    Pipeline: pipeline,
    EndToEndLatency: latencyMs,
    ProcessingTime: processingMs,
    MessagesProcessed: 1,
    vehicle_id: msg.vehicle_id,
    route_id: msg.route_id,
    run_id: msg.run_id || 'none',
    delay_status: state.delay_status,
    crowd_level: state.crowd_level,
  }));

  return { state, alerts, latencyMs, processingMs };
}

async function publishAlert(alert) {
  console.log(JSON.stringify({ level: 'info', event: 'alert', ...alert }));
  if (!iot) return;
  try {
    await iot.send(new PublishCommand({
      topic: `transit/alerts/${alert.route_id}`,
      qos: 1,
      payload: Buffer.from(JSON.stringify(alert)),
    }));
  } catch (err) {
    console.log(JSON.stringify({ level: 'error', event: 'alert_publish_failed', error: err.message }));
  }
}

// HD edge design: the edge gateway sends one batch per second containing only
// the vehicles whose state changed significantly. The records are already
// processed at the edge, so the cloud only stores them (25 items per write).
export async function handleEdgeBatch(batch) {
  const startedMs = Date.now();
  const records = batch.records || [];
  const latest = new Map(); // one row per vehicle
  const items = [];
  for (const r of records) {
    latest.set(r.vehicle_id, r);
    items.push({ TableName: HISTORY_TABLE, Item: { ...r, ts: r.sent_at_ms, pipeline: 'edge' } });
  }
  for (const r of latest.values()) items.push({ TableName: STATE_TABLE, Item: { ...r, updated_at_ms: startedMs, pipeline: 'edge' } });
  for (let i = 0; i < items.length; i += 25) {
    let RequestItems = {};
    for (const { TableName, Item } of items.slice(i, i + 25)) (RequestItems[TableName] ||= []).push({ PutRequest: { Item } });
    for (let attempt = 0; attempt < 3 && Object.keys(RequestItems).length; attempt += 1) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems }));
      RequestItems = res.UnprocessedItems || {}; // retry
    }
  }
  for (const a of batch.alerts || []) console.log(JSON.stringify({ level: 'info', event: 'edge_alert', ...a }));
  const latencies = records.map((r) => startedMs - r.sent_at_ms);
  if (process.env.LOG_METRICS !== 'false') console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'SmartTransit', Dimensions: [['Pipeline']],
      Metrics: [{ Name: 'RecordsPerBatch', Unit: 'Count' }, { Name: 'BatchProcessingTime', Unit: 'Milliseconds' },
        { Name: 'EdgeToCloudLatency', Unit: 'Milliseconds' }] }] },
    Pipeline: 'edge', gateway: batch.gateway, RecordsPerBatch: records.length,
    BatchProcessingTime: Date.now() - startedMs,
    EdgeToCloudLatency: latencies.length ? Math.max(...latencies) : 0,
  }));
  return { stored: records.length };
}

export const handler = async (event) => {
  if (event && Array.isArray(event.records)) return handleEdgeBatch(event);
  const messages = Array.isArray(event) ? event : [event];
  const results = [];
  for (const m of messages) results.push(await handleMessage(m));
  return { processed: results.length };
};
