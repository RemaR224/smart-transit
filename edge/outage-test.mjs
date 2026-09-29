// Cloud outage test
// usage: node edge/outage-test.mjs --vehicles=500 --outageS=30
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import Aedes from 'aedes';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { vehicles: 500, modes: 'passthrough,edge', durationMs: 90000, outageFromS: 30, outageS: 30, port: 18890 };
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}
const V = Number(args.vehicles); const DUR = Number(args.durationMs);
const OUT_FROM = Number(args.outageFromS) * 1000; const OUT_LEN = Number(args.outageS) * 1000;
const EDGE_PORT = Number(args.port); const CLOUD_PORT = EDGE_PORT + 1;
const OUT = path.join(ROOT, 'results', 'edge');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBroker(port) {
  const aedes = await Aedes.createBroker?.() ?? Aedes();
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); aedes.handle(s); });
  await new Promise((r) => server.listen(port, r));
  return {
    stop: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => aedes.close(r)); }),
  };
}

function runChild(file, childArgs, onLine) {
  const child = spawn(process.execPath, [path.join(ROOT, file), ...childArgs], { cwd: ROOT });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    lines.forEach((l) => { if (l.startsWith('[edge] upstream')) console.log(`  ${l}`); onLine && onLine(l); });
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return new Promise((resolve) => child.on('exit', resolve));
}

async function runOne(mode) {
  const edgeBroker = await startBroker(EDGE_PORT);
  let cloudBroker = await startBroker(CLOUD_PORT);
  const t0 = Date.now();
  const outStart = t0 + 1500 + OUT_FROM; const outEnd = outStart + OUT_LEN;

  // local alerts
  let alertsDuringOutage = 0; let alertsTotal = 0;
  const local = mqtt.connect(`mqtt://localhost:${EDGE_PORT}`, { clientId: `outage-local-${mode}` });
  local.on('connect', () => local.subscribe('transit/alerts/#'));
  local.on('message', () => { const now = Date.now(); alertsTotal += 1; if (now >= outStart && now < outEnd) alertsDuringOutage += 1; });

  // cloud side
  const perSecond = new Map();
  let cloudMsgs = 0; let cloudRecords = 0; let outageRecordsDelivered = 0; let lastBacklogArrival = 0;
  const cloudAlerts = { during: 0 };
  const attachCloudObserver = () => {
    const c = mqtt.connect(`mqtt://localhost:${CLOUD_PORT}`, { clientId: `outage-cloud-${mode}`, reconnectPeriod: 500 });
    c.on('connect', () => c.subscribe(['cloud/#', 'transit/edge/+/batch']));
    c.on('message', (topic, payload) => {
      const now = Date.now();
      const sec = Math.floor((now - t0) / 1000);
      perSecond.set(sec, (perSecond.get(sec) || 0) + 1);
      cloudMsgs += 1;
      const body = JSON.parse(payload.toString());
      const recs = topic.startsWith('cloud/') ? [body] : body.records;
      cloudRecords += recs.length;
      for (const r of recs) {
        if (r.sent_at_ms >= outStart && r.sent_at_ms < outEnd) { outageRecordsDelivered += 1; lastBacklogArrival = Math.max(lastBacklogArrival, now); }
      }
      if (!topic.startsWith('cloud/')) cloudAlerts.during += (body.alerts || []).filter((a) => a.sent_at_ms >= outStart && a.sent_at_ms < outEnd).length;
    });
    return c;
  };
  let cloudObs = attachCloudObserver();

  let summary = {};
  const gw = runChild('edge/edge-gateway.mjs', [`--broker=mqtt://localhost:${EDGE_PORT}`, `--upstream=mqtt://localhost:${CLOUD_PORT}`,
    `--mode=${mode}`, `--durationMs=${DUR + 6000}`, '--gateway=edge-lab'],
  (l) => { if (l.startsWith('EDGE_SUMMARY ')) summary = JSON.parse(l.slice(13)); });
  await sleep(1500);
  const sim = runChild('simulator.js', [`--vehicles=${V}`, '--interval=1000', `--connections=${Math.ceil(V / 250)}`,
    `--durationMs=${DUR}`, `--broker=mqtt://localhost:${EDGE_PORT}`, `--runId=outage-${mode}`]);

  await sleep(outStart - Date.now());
  console.log(`  [outage] cloud link down for ${OUT_LEN / 1000} s`);
  cloudObs.end(true); await cloudBroker.stop();
  await sleep(outEnd - Date.now());
  cloudBroker = await startBroker(CLOUD_PORT);
  cloudObs = attachCloudObserver();
  console.log('  [outage] cloud link restored');

  await sim; await gw; await sleep(1000);
  cloudObs.end(true); local.end(true);
  await cloudBroker.stop(); await edgeBroker.stop();

  const ts = ['second,cloud_messages', ...[...perSecond.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s},${n}`)];
  fs.writeFileSync(path.join(OUT, `outage-${mode}-timeseries.csv`), ts.join('\n') + '\n');
  const afterSec = Math.floor((outEnd - t0) / 1000);
  const burst = Math.max(0, ...[...perSecond.entries()].filter(([s]) => s >= afterSec && s <= afterSec + 10).map(([, n]) => n));
  return {
    mode, vehicles: V, outage_s: OUT_LEN / 1000,
    raw_messages: summary.received,
    sent_by_gateway: summary.forwarded_records,
    records_at_cloud: cloudRecords,
    records_lost_pct: summary.forwarded_records ? Number((100 * (1 - cloudRecords / summary.forwarded_records)).toFixed(2)) : null,
    outage_records_delivered_late: outageRecordsDelivered,
    backlog_cleared_after_s: lastBacklogArrival ? Number(((lastBacklogArrival - outEnd) / 1000).toFixed(1)) : null,
    reconnect_burst_msg_s: burst,
    alerts_during_outage_local: alertsDuringOutage,
    alerts_total_local: alertsTotal,
  };
}

const rows = [];
for (const m of String(args.modes).split(',')) {
  console.log(`[outage] running ${m} with ${V} vehicles`);
  rows.push(await runOne(m));
}
const cols = Object.keys(rows[0]);
fs.writeFileSync(path.join(OUT, 'outage_summary.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n');
console.table(rows);
console.log(`Saved ${path.join('results', 'edge', 'outage_summary.csv')}`);
process.exit(0);
