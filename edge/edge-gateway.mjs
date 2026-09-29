// Edge gateway for Smart Transit
// modes: edge, adaptive, passthrough (cloud-only baseline)
import fs from 'fs';
import os from 'os';
import mqtt from 'mqtt';
import { validate, processTelemetry } from '../processing/index.mjs';

const args = {
  broker: 'mqtt://localhost:1883',
  upstream: '',
  mode: 'edge',
  gateway: `edge-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')}`,
  batchMs: 1000,
  heartbeatS: 30,
  delayDeltaS: 60,
  occDeltaPct: 10,
  durationMs: 0,
};
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}
for (const k of ['batchMs', 'heartbeatS', 'delayDeltaS', 'occDeltaPct', 'durationMs']) args[k] = Number(args[k]);
const EDGE = args.mode === 'edge' || args.mode === 'adaptive';
const ADAPTIVE = args.mode === 'adaptive';

const t0 = Date.now();
const local = mqtt.connect(args.broker, { clientId: `${args.gateway}-in`, reconnectPeriod: 2000 });
const upstream = args.upstream
  ? mqtt.connect(args.upstream, {
    clientId: `${args.gateway}-up`,
    ...(args.cert ? { cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key), ca: fs.readFileSync(args.ca) } : {}),
    reconnectPeriod: 2000,
  })
  : local; // no upstream given: use local broker
if (upstream !== local) {
  upstream.on('connect', () => console.log(`[edge] upstream connected at ${Date.now() - t0} ms`));
  upstream.on('offline', () => console.log(`[edge] upstream offline at ${Date.now() - t0} ms, buffering batches`));
}
const UP_TOPIC = EDGE ? `transit/edge/${args.gateway}/batch` : null;

const vehicles = new Map();
let buffer = [];
let alertBuffer = [];
const stats = {
  mode: args.mode, received: 0, rejected: 0, forwarded_records: 0, upstream_messages: 0,
  upstream_bytes: 0, local_alerts: 0, proc_ms_total: 0,
  reasons: { first: 0, status: 0, crowd: 0, delay: 0, occupancy: 0, heartbeat: 0 },
  tiers: { priority: 0, normal: 0, quiet: 0 }, congested_batches: 0, urgent_flushes: 0,
};

// adaptive tiers
const TIERS = {
  priority: { delay: 30, occ: 5, hb: 10 },
  normal: { delay: 60, occ: 10, hb: 30 },
  quiet: { delay: 90, occ: 15, hb: 60 },
};
let congested = false;
let urgentTimer = null;
function tierOf(state) {
  if (['minor_delay', 'major_delay'].includes(state.delay_status) || ['high', 'full'].includes(state.crowd_level)
    || (state.status !== 'layover' && state.distance_to_next_stop_km < 0.3)) return 'priority';
  if (['on_time', 'early', 'layover'].includes(state.delay_status) && state.crowd_level === 'low') return 'quiet';
  return 'normal';
}
function limitsFor(state) {
  if (!ADAPTIVE) return { tier: 'fixed', delay: args.delayDeltaS, occ: args.occDeltaPct, hb: args.heartbeatS };
  const tier = tierOf(state);
  const t = TIERS[tier];
  const k = congested && tier !== 'priority' ? 1.5 : 1;
  return { tier, delay: t.delay * k, occ: t.occ * k, hb: t.hb * k };
}
const cpuStart = process.cpuUsage();

function forwardReason(state, fwd, now, lim) {
  if (!fwd) return 'first';
  if (state.delay_status !== fwd.delay_status) return 'status';
  if (state.crowd_level !== fwd.crowd_level) return 'crowd';
  if (state.delay_status !== 'layover' && Math.abs(state.delay_seconds - fwd.delay_seconds) >= lim.delay) return 'delay';
  if (Math.abs(state.smoothed_occupancy_pct - fwd.smoothed_occupancy_pct) >= lim.occ) return 'occupancy';
  if (now - fwd.at >= lim.hb * 1000) return 'heartbeat';
  return null;
}

function compact(s, reason, now, tier) {
  return {
    vehicle_id: s.vehicle_id, route_id: s.route_id, trip_id: s.trip_id, seq: s.seq,
    lat: s.lat, lon: s.lon, speed_kmh: s.speed_kmh,
    smoothed_occupancy_pct: s.smoothed_occupancy_pct, crowd_level: s.crowd_level,
    delay_seconds: s.delay_seconds, delay_status: s.delay_status, next_stop: s.next_stop,
    sent_at_ms: s.sent_at_ms, edge_at_ms: now, reason, tier,
  };
}

function publish(topic, obj) {
  const body = JSON.stringify(obj);
  stats.upstream_messages += 1;
  stats.upstream_bytes += Buffer.byteLength(body);
  upstream.publish(topic, body, { qos: 0 });
}

local.on('connect', () => {
  local.subscribe('transit/+/vehicle/+/telemetry', { qos: 0 });
  console.log(`[edge] ${args.gateway} mode=${args.mode} listening on ${args.broker}`
    + (args.upstream ? `, upstream ${args.upstream}` : ', upstream = local broker'));
});

local.on('message', (topic, payload) => {
  if (!topic.endsWith('/telemetry')) return;
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { stats.rejected += 1; return; }
  stats.received += 1;

  if (!EDGE) { // baseline: send everything
    publish(`cloud/${topic}`, msg);
    stats.forwarded_records += 1;
    return;
  }

  const p0 = process.hrtime.bigint();
  if (validate(msg)) { stats.rejected += 1; return; }
  const now = Date.now();
  const v = vehicles.get(msg.vehicle_id) || {};
  const { state, alerts } = processTelemetry(msg, v.state, now, 'edge');
  v.state = state;

  for (const a of alerts) { // local alerts
    const alert = { ...a, sent_at_ms: msg.sent_at_ms, edge_at_ms: now, gateway: args.gateway };
    local.publish(`transit/alerts/${a.route_id}`, JSON.stringify(alert), { qos: 0 });
    alertBuffer.push(alert);
    stats.local_alerts += 1;
  }

  const lim = limitsFor(state);
  const reason = forwardReason(state, v.fwd, now, lim);
  if (reason) {
    buffer.push(compact(state, reason, now, lim.tier));
    if (ADAPTIVE) {
      stats.tiers[lim.tier] += 1;
      // send priority changes early
      if (lim.tier === 'priority' && (reason === 'status' || reason === 'crowd') && !urgentTimer) {
        urgentTimer = setTimeout(() => { urgentTimer = null; stats.urgent_flushes += 1; flush(); }, 100);
      }
    }
    v.fwd = { delay_status: state.delay_status, crowd_level: state.crowd_level, delay_seconds: state.delay_seconds,
      smoothed_occupancy_pct: state.smoothed_occupancy_pct, at: now };
    stats.reasons[reason] += 1;
    stats.forwarded_records += 1;
  }
  vehicles.set(msg.vehicle_id, v);
  stats.proc_ms_total += Number(process.hrtime.bigint() - p0) / 1e6;
});

function flush() {
  if (!EDGE || (!buffer.length && !alertBuffer.length)) return;
  // link busy check
  const budget = Math.max(50, 0.1 * vehicles.size);
  congested = ADAPTIVE && (buffer.length > budget || (upstream !== local && !upstream.connected));
  if (congested) stats.congested_batches += 1;
  // keep batches under 128 KB
  const CHUNK = 250;
  for (let i = 0; i < Math.max(buffer.length, 1); i += CHUNK) {
    publish(UP_TOPIC, {
      gateway: args.gateway, batch_sent_at_ms: Date.now(),
      records: buffer.slice(i, i + CHUNK), alerts: i === 0 ? alertBuffer : [],
    });
  }
  buffer = [];
  alertBuffer = [];
}
const flushTimer = setInterval(flush, args.batchMs);

const reporter = setInterval(() => {
  const s = (Date.now() - t0) / 1000;
  console.log(`[edge] ${s.toFixed(0)}s received=${stats.received} (${(stats.received / s).toFixed(0)}/s) `
    + `forwarded=${stats.forwarded_records} upstream_msgs=${stats.upstream_messages} (${(stats.upstream_messages / s).toFixed(1)}/s) `
    + `alerts=${stats.local_alerts}`);
}, 10000);

function finish() {
  flush();
  clearInterval(flushTimer); clearInterval(reporter);
  const secs = (Date.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const summary = {
    ...stats,
    seconds: Number(secs.toFixed(1)),
    reduction_pct: stats.received ? Number((100 * (1 - stats.upstream_messages / stats.received)).toFixed(2)) : 0,
    record_reduction_pct: stats.received ? Number((100 * (1 - stats.forwarded_records / stats.received)).toFixed(2)) : 0,
    avg_proc_ms: stats.received ? Number((stats.proc_ms_total / stats.received).toFixed(4)) : 0,
    cpu_pct: Number((100 * (cpu.user + cpu.system) / 1000 / (secs * 1000)).toFixed(1)),
    rss_mb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
  };
  console.log(`EDGE_SUMMARY ${JSON.stringify(summary)}`);
  setTimeout(() => process.exit(0), 300);
}
if (args.durationMs > 0) setTimeout(finish, args.durationMs);
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
