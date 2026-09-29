// Cloud-only vs edge load experiment
// usage: node edge/run-experiment.mjs --vehicles=200,500,1000,2000
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import Aedes from 'aedes';
import { processTelemetry } from '../processing/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { vehicles: '200,500,1000,2000', modes: 'passthrough,edge', durationMs: 120000, port: 18883 };
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}
const LOADS = String(args.vehicles).split(',').map(Number);
const MODES = String(args.modes).split(',');
const DUR = Number(args.durationMs);
const OUT = path.join(ROOT, 'results', 'edge');
fs.mkdirSync(OUT, { recursive: true });

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runChild(file, childArgs, onLine) {
  const child = spawn(process.execPath, [path.join(ROOT, file), ...childArgs], { cwd: ROOT });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    lines.forEach((l) => onLine && onLine(l));
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return new Promise((resolve) => child.on('exit', () => resolve()));
}

async function runOne(vehicles, mode) {
  const aedes = await Aedes.createBroker?.() ?? Aedes();
  const server = net.createServer(aedes.handle);
  await new Promise((r) => server.listen(args.port, r));
  const broker = `mqtt://localhost:${args.port}`;

  const truth = new Map(); // ground truth
  const view = new Map(); // cloud copy
  const cloudLatency = []; const alertLatency = []; const perSecond = new Map();
  let upstreamMsgs = 0; let upstreamBytes = 0; let records = 0;
  const samples = { total: 0, statusMatch: 0, crowdMatch: 0, delayErr: [], staleness: [], crit: 0, critMatch: 0, critStale: [] };
  const tStart = Date.now();

  const obs = mqtt.connect(broker, { clientId: `observer-${mode}-${vehicles}` });
  await new Promise((r) => obs.on('connect', r));
  obs.subscribe(['transit/+/vehicle/+/telemetry', 'cloud/#', 'transit/edge/+/batch', 'transit/alerts/#']);
  obs.on('message', (topic, payload) => {
    const now = Date.now();
    const sec = Math.floor((now - tStart) / 1000);
    if (topic.startsWith('transit/alerts/')) {
      const a = JSON.parse(payload.toString());
      if (a.sent_at_ms) alertLatency.push(now - a.sent_at_ms);
      return;
    }
    if (topic.endsWith('/telemetry') && topic.startsWith('transit/')) {
      const m = JSON.parse(payload.toString());
      truth.set(m.vehicle_id, processTelemetry(m, truth.get(m.vehicle_id), now, 'truth').state);
      return;
    }
    // upstream traffic
    upstreamMsgs += 1; upstreamBytes += payload.length;
    perSecond.set(sec, (perSecond.get(sec) || 0) + 1);
    const body = JSON.parse(payload.toString());
    if (topic.startsWith('cloud/')) { // passthrough
      view.set(body.vehicle_id, processTelemetry(body, view.get(body.vehicle_id), now, 'cloud').state);
      cloudLatency.push(now - body.sent_at_ms); records += 1;
    } else {
      for (const r of body.records) { view.set(r.vehicle_id, r); cloudLatency.push(now - r.sent_at_ms); records += 1; }
    }
  });

  // accuracy every second
  const sampler = setInterval(() => {
    const now = Date.now();
    for (const [id, t] of truth) {
      const v = view.get(id);
      samples.total += 1;
      if (!v) continue;
      if (v.delay_status === t.delay_status) samples.statusMatch += 1;
      if (v.crowd_level === t.crowd_level) samples.crowdMatch += 1;
      if (t.delay_status !== 'layover') samples.delayErr.push(Math.abs((v.delay_seconds || 0) - t.delay_seconds));
      samples.staleness.push(now - v.sent_at_ms);
      // late or crowded vehicles
      if (['minor_delay', 'major_delay'].includes(t.delay_status) || ['high', 'full'].includes(t.crowd_level)) {
        samples.crit += 1;
        if (v.delay_status === t.delay_status && v.crowd_level === t.crowd_level) samples.critMatch += 1;
        samples.critStale.push(now - v.sent_at_ms);
      }
    }
  }, 1000);

  let edgeSummary = {};
  // e.g. edge-hb10
  const [gwMode, hb] = mode.split('-hb');
  const gwArgs = [`--broker=${broker}`, `--mode=${gwMode}`, `--durationMs=${DUR + 4000}`, '--gateway=edge-lab'];
  if (hb) gwArgs.push(`--heartbeatS=${hb}`);
  const gw = runChild('edge/edge-gateway.mjs', gwArgs,
    (l) => { if (l.startsWith('EDGE_SUMMARY ')) edgeSummary = JSON.parse(l.slice(13)); });
  await sleep(1500);
  const conns = Math.max(1, Math.ceil(vehicles / 250));
  let simSummary = '';
  await runChild('simulator.js', [`--vehicles=${vehicles}`, '--interval=1000', `--connections=${conns}`, `--durationMs=${DUR}`,
    `--broker=${broker}`, `--runId=${mode}-${vehicles}`], (l) => { if (l.includes('Summary')) simSummary = l; });
  await gw;
  clearInterval(sampler);
  obs.end(true);
  await new Promise((r) => { server.close(r); aedes.close(); });

  const secs = DUR / 1000;
  const ts = ['second,upstream_messages', ...[...perSecond.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s},${n}`)];
  fs.writeFileSync(path.join(OUT, `${mode}-${vehicles}-timeseries.csv`), ts.join('\n') + '\n');

  const row = {
    mode, vehicles,
    raw_messages: edgeSummary.received,
    upstream_messages: upstreamMsgs,
    upstream_msg_s: Number((upstreamMsgs / secs).toFixed(1)),
    records_to_cloud: records,
    message_reduction_pct: Number((100 * (1 - upstreamMsgs / edgeSummary.received)).toFixed(2)),
    upstream_kb_s: Number((upstreamBytes / 1024 / secs).toFixed(1)),
    cloud_latency_p50_ms: pct(cloudLatency, 50), cloud_latency_p95_ms: pct(cloudLatency, 95),
    alert_latency_p50_ms: pct(alertLatency, 50), alert_latency_p95_ms: pct(alertLatency, 95),
    status_accuracy_pct: Number((100 * samples.statusMatch / samples.total).toFixed(2)),
    crowd_accuracy_pct: Number((100 * samples.crowdMatch / samples.total).toFixed(2)),
    delay_error_p95_s: pct(samples.delayErr, 95),
    staleness_p95_s: Number(((pct(samples.staleness, 95) || 0) / 1000).toFixed(1)),
    critical_accuracy_pct: samples.crit ? Number((100 * samples.critMatch / samples.crit).toFixed(2)) : null,
    critical_staleness_p95_s: Number(((pct(samples.critStale, 95) || 0) / 1000).toFixed(1)),
    edge_cpu_pct: edgeSummary.cpu_pct, edge_rss_mb: edgeSummary.rss_mb, edge_avg_proc_ms: edgeSummary.avg_proc_ms,
    local_alerts: edgeSummary.local_alerts,
  };
  console.log(`[experiment] ${mode} ${vehicles}: ${JSON.stringify(row)}`);
  if (simSummary) console.log(`  ${simSummary.trim()}`);
  return row;
}

const rows = [];
for (const v of LOADS) for (const m of MODES) rows.push(await runOne(v, m));
const cols = Object.keys(rows[0]);
const SUMMARY = args.out || 'edge_summary.csv';
fs.writeFileSync(path.join(OUT, SUMMARY), [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n');
console.table(rows.map((r) => ({ mode: r.mode, vehicles: r.vehicles, upstream_msg_s: r.upstream_msg_s, reduction: `${r.message_reduction_pct}%`,
  kb_s: r.upstream_kb_s, alert_p95_ms: r.alert_latency_p95_ms, status_acc: `${r.status_accuracy_pct}%`, crowd_acc: `${r.crowd_accuracy_pct}%`,
  stale_p95_s: r.staleness_p95_s, crit_acc: `${r.critical_accuracy_pct}%`, crit_stale_s: r.critical_staleness_p95_s, cpu: `${r.edge_cpu_pct}%` })));
console.log(`Saved ${path.join('results', 'edge', SUMMARY)}`);
process.exit(0);
