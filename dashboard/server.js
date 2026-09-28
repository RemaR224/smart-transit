#!/usr/bin/env node
// Operator dashboard server: serves the web page and a small JSON API.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const mqtt = require('mqtt');
const { ROUTES } = require('../route');

// Options
const args = {
  port: 3000,
  iotEndpoint: 'a2eupkg9muh4ko-ats.iot.us-east-1.amazonaws.com',
  table: 'TransitVehicleState',
  cacheMs: 2000,
  source: 'dynamodb',
  broker: '',
};
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}
args.port = parseInt(process.env.PORT || args.port, 10);
args.cacheMs = parseInt(args.cacheMs, 10);

const ROOT = path.join(__dirname, '..');
const credFile = path.join(ROOT, 'certs', 'aws-credentials.txt');
if (!process.env.AWS_SHARED_CREDENTIALS_FILE && fs.existsSync(credFile)) {
  process.env.AWS_SHARED_CREDENTIALS_FILE = credFile;
}
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const HOST = os.hostname();

// Data sources
let scanVehicles; // async () => array of vehicle state items
const memoryState = new Map();

async function setupDynamo() {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
  scanVehicles = async () => {
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await ddb.send(new ScanCommand({ TableName: args.table, ExclusiveStartKey }));
      items.push(...(res.Items || []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };
}

async function setupMemory(client) {
  const { processTelemetry, validate } = await import('../processing/index.mjs');
  client.subscribe('transit/+/vehicle/+/telemetry', { qos: 0 });
  client.on('message', (topic, payload) => {
    if (!topic.endsWith('/telemetry')) return;
    try {
      const msg = JSON.parse(payload.toString());
      if (validate(msg)) return;
      const { state, alerts } = processTelemetry(msg, memoryState.get(msg.vehicle_id), Date.now(), 'memory');
      memoryState.set(msg.vehicle_id, state);
      alerts.forEach(addAlert);
    } catch {}
  });
  scanVehicles = async () => [...memoryState.values()];
}

// Alerts: keep the latest 50 in memory
const alerts = [];
function addAlert(a) {
  alerts.unshift(a);
  if (alerts.length > 50) alerts.length = 50;
}

function connectMqtt() {
  const useAws = !args.broker;
  const url = args.broker || `mqtts://${args.iotEndpoint}:8883`;
  const opts = { clientId: `dashboard-${HOST}-${Math.random().toString(16).slice(2, 6)}`, reconnectPeriod: 3000 };
  if (useAws) {
    if (!(args.cert && args.key && args.ca)) {
      console.log('[dashboard] no --cert/--key/--ca given: live alerts feed disabled');
      return null;
    }
    opts.cert = fs.readFileSync(path.resolve(args.cert));
    opts.key = fs.readFileSync(path.resolve(args.key));
    opts.ca = fs.readFileSync(path.resolve(args.ca));
  }
  const client = mqtt.connect(url, opts);
  client.on('connect', () => {
    console.log(`[dashboard] MQTT connected to ${url}`);
    client.subscribe('transit/alerts/#', { qos: 1 }); // AWS IoT Core does not support QoS 2
  });
  client.on('error', (e) => console.error('[dashboard] MQTT error:', e.message));
  client.on('message', (topic, payload) => {
    if (!topic.startsWith('transit/alerts/')) return;
    try { addAlert(JSON.parse(payload.toString())); } catch {}
  });
  return client;
}

// Summary maths
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarise(vehicles) {
  const now = Date.now();
  const live = vehicles.filter((v) => now - (v.processed_at_ms || 0) < 60000);
  const inService = live.filter((v) => v.delay_status !== 'layover');
  const count = (arr, key, val) => arr.filter((v) => v[key] === val).length;
  const lat = live.map((v) => v.latency_ms).filter((x) => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  const onTime = count(inService, 'delay_status', 'on_time') + count(inService, 'delay_status', 'early');
  return {
    vehicles_total: vehicles.length,
    vehicles_live: live.length,
    on_time_pct: inService.length ? Math.round((onTime / inService.length) * 100) : null,
    delay: {
      on_time: onTime,
      minor_delay: count(inService, 'delay_status', 'minor_delay'),
      major_delay: count(inService, 'delay_status', 'major_delay'),
      layover: count(live, 'delay_status', 'layover'),
    },
    crowd: {
      low: count(live, 'crowd_level', 'low'),
      moderate: count(live, 'crowd_level', 'moderate'),
      high: count(live, 'crowd_level', 'high'),
      full: count(live, 'crowd_level', 'full'),
    },
    latency_ms: {
      avg: lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) : null,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
    },
    missed_messages: vehicles.reduce((s, v) => s + (v.missed_messages || 0), 0),
    messages_processed: vehicles.reduce((s, v) => s + (v.messages_processed || 0), 0),
    per_route: ROUTES.map((r) => {
      const rv = inService.filter((v) => v.route_id === r.routeId);
      const ok = rv.filter((v) => v.delay_status === 'on_time' || v.delay_status === 'early').length;
      return {
        route_id: r.routeId,
        route_name: r.routeName,
        vehicles: live.filter((v) => v.route_id === r.routeId).length,
        on_time_pct: rv.length ? Math.round((ok / rv.length) * 100) : null,
        avg_delay_s: rv.length ? Math.round(rv.reduce((s, v) => s + (v.delay_seconds || 0), 0) / rv.length) : null,
      };
    }),
    generated_at: new Date(now).toISOString(),
  };
}

let cache = { at: 0, body: null };
async function vehiclesPayload() {
  if (cache.body && Date.now() - cache.at < args.cacheMs) return cache.body;
  const vehicles = await scanVehicles();
  vehicles.sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id));
  const body = JSON.stringify({ served_by: HOST, summary: summarise(vehicles), vehicles });
  cache = { at: Date.now(), body };
  return body;
}

// HTTP server
const routesBody = JSON.stringify(ROUTES.map((r) => ({
  route_id: r.routeId, route_name: r.routeName, mode: r.mode,
  stops: r.waypoints.map((w) => ({ name: w.stopName, lat: w.lat, lon: w.lon })),
})));

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'X-Served-By': HOST, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (url.startsWith('/vendor/leaflet/')) {
      const file = path.basename(url);
      const types = { 'leaflet.js': 'application/javascript', 'leaflet.css': 'text/css' };
      if (types[file]) return send(res, 200, fs.readFileSync(path.join(ROOT, 'node_modules', 'leaflet', 'dist', file)), types[file]);
    }
    if (url === '/api/vehicles') return send(res, 200, await vehiclesPayload());
    if (url === '/api/alerts') return send(res, 200, JSON.stringify({ served_by: HOST, alerts }));
    if (url === '/api/routes') return send(res, 200, routesBody);
    if (url === '/health') return send(res, 200, JSON.stringify({ ok: true, host: HOST, uptime_s: Math.round(process.uptime()) }));
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error('[dashboard] request failed:', err.message);
    return send(res, 500, JSON.stringify({ error: err.message }));
  }
});

(async () => {
  const client = connectMqtt();
  if (args.source === 'memory') {
    if (!client) { console.error('[dashboard] --source=memory needs --broker or AWS certs'); process.exit(1); }
    await setupMemory(client);
    console.log('[dashboard] data source: in-memory processing of live telemetry (offline demo mode)');
  } else {
    await setupDynamo();
    console.log(`[dashboard] data source: DynamoDB table ${args.table} (${process.env.AWS_REGION})`
      + (process.env.AWS_SHARED_CREDENTIALS_FILE ? ` using ${path.relative(ROOT, process.env.AWS_SHARED_CREDENTIALS_FILE)}` : ''));
  }
  server.listen(args.port, () => console.log(`[dashboard] open http://localhost:${args.port}  (host ${HOST})`));
})();
