// Multi-depot scaling and gateway failure test
// usage: node edge/multi-gateway-test.mjs --vehicles=4000 --gateways=1,2,4
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import Aedes from 'aedes';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { vehicles: 4000, gateways: '1,2,4', durationMs: 120000, failAtS: 40, downS: 20, port: 18900 };
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}
const N = Number(args.vehicles); const DUR = Number(args.durationMs);
const FAIL_AT = Number(args.failAtS) * 1000; const DOWN = Number(args.downS) * 1000;
const OUT = path.join(ROOT, 'results', 'edge');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBroker(port) {
  const aedes = await Aedes.createBroker?.() ?? Aedes();
  const server = net.createServer(aedes.handle);
  await new Promise((r) => server.listen(port, r));
  return () => new Promise((r) => server.close(() => aedes.close(r)));
}

function startGateway(depot, depotPort, cloudPort, durationMs, onSummary) {
  const child = spawn(process.execPath, [path.join(ROOT, 'edge/edge-gateway.mjs'),
    `--broker=mqtt://localhost:${depotPort}`, `--upstream=mqtt://localhost:${cloudPort}`,
    '--mode=edge', `--gateway=edge-depot${depot}`, `--durationMs=${durationMs}`], { cwd: ROOT });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) if (l.startsWith('EDGE_SUMMARY ')) onSummary(JSON.parse(l.slice(13)));
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  const done = new Promise((r) => child.on('exit', r));
  return { child, done };
}

function runSimulator(vehicles, depotPort, runId) {
  const child = spawn(process.execPath, [path.join(ROOT, 'simulator.js'), `--vehicles=${vehicles}`, '--interval=1000',
    `--connections=${Math.max(1, Math.ceil(vehicles / 250))}`, `--durationMs=${DUR}`,
    `--broker=mqtt://localhost:${depotPort}`, `--runId=${runId}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  return new Promise((r) => child.on('exit', r));
}

async function runOne(G) {
  const cloudPort = Number(args.port);
  const stops = [await startBroker(cloudPort)];
  const depotPorts = [];
  for (let i = 0; i < G; i += 1) { depotPorts.push(cloudPort + 1 + i); stops.push(await startBroker(cloudPort + 1 + i)); }

  // cloud side counts
  const t0 = Date.now();
  const perSec = new Map();
  let rawMessages = 0;
  let cloudMsgs = 0; let cloudRecords = 0; let cloudBytes = 0;
  const obs = mqtt.connect(`mqtt://localhost:${cloudPort}`, { clientId: `multi-obs-${G}` });
  await new Promise((r) => obs.on('connect', r));
  obs.subscribe('transit/edge/+/batch');
  obs.on('message', (topic, payload) => {
    const body = JSON.parse(payload.toString());
    const depot = Number(topic.split('/')[2].replace('edge-depot', ''));
    const sec = Math.floor((Date.now() - t0) / 1000);
    if (!perSec.has(sec)) perSec.set(sec, { msgs: 0, recs: Array(G).fill(0), batches: Array(G).fill(0) });
    const row = perSec.get(sec);
    row.msgs += 1; row.recs[depot] += body.records.length; row.batches[depot] += 1;
    cloudMsgs += 1; cloudRecords += body.records.length; cloudBytes += payload.length;
  });

  // count raw messages
  const depotObs = await Promise.all(depotPorts.map((p, i) => new Promise((r) => {
    const c = mqtt.connect(`mqtt://localhost:${p}`, { clientId: `multi-depot-obs-${G}-${i}` });
    c.on('connect', () => { c.subscribe('transit/+/vehicle/+/telemetry'); r(c); });
    c.on('message', () => { rawMessages += 1; });
  })));
  const summaries = [];
  const gws = depotPorts.map((p, i) => startGateway(i, p, cloudPort, DUR + 4000, (s) => summaries.push({ depot: i, ...s })));
  await sleep(1500);
  const perDepot = Math.floor(N / G);
  const sims = depotPorts.map((p, i) => runSimulator(perDepot, p, `multi-${G}-d${i}`));

  // stop and restart depot 1
  let failure = null;
  if (G > 1) {
    await sleep(FAIL_AT);
    const failSec = Math.floor((Date.now() - t0) / 1000);
    gws[1].child.kill('SIGKILL');
    console.log(`  [multi] depot 1 gateway stopped at ${failSec} s`);
    await sleep(DOWN);
    const backSec = Math.floor((Date.now() - t0) / 1000);
    const remaining = Math.max(5000, DUR - FAIL_AT - DOWN + 4000);
    gws[1] = startGateway(1, depotPorts[1], cloudPort, remaining, (s) => summaries.push({ depot: 1, restarted: true, ...s }));
    console.log(`  [multi] depot 1 gateway restarted at ${backSec} s`);
    failure = { failSec, backSec };
  }

  await Promise.all(sims);
  await Promise.all(gws.map((g) => g.done));
  await sleep(500);
  obs.end(true); depotObs.forEach((c) => c.end(true));
  for (const s of stops) await s();

  // timeseries for chart
  const secs = [...perSec.keys()].sort((a, b) => a - b);
  const header = ['second', 'cloud_messages', ...Array.from({ length: G }, (_, i) => `records_depot${i}`)];
  fs.writeFileSync(path.join(OUT, `multi-${G}-timeseries.csv`),
    [header.join(','), ...secs.map((s) => [s, perSec.get(s).msgs, ...perSec.get(s).recs].join(','))].join('\n') + '\n');

  let isolation = {};
  if (failure) {
    // other depots during failure
    const healthy = [...Array(G).keys()].filter((d) => d !== 1);
    const batchRate = (from, to) => {
      const xs = secs.filter((s) => s >= from && s < to);
      if (!xs.length) return 0;
      return healthy.reduce((a, d) => a + xs.reduce((b, s) => b + perSec.get(s).batches[d], 0) / xs.length, 0) / healthy.length;
    };
    const recovered = secs.find((s) => s >= failure.backSec && perSec.get(s).recs[1] > 0);
    isolation = {
      fail_sec: failure.failSec, restart_sec: failure.backSec,
      healthy_batches_s_before: Number(batchRate(failure.failSec - 20, failure.failSec).toFixed(2)),
      healthy_batches_s_during: Number(batchRate(failure.failSec + 1, failure.backSec).toFixed(2)),
      failed_depot_batches_during: secs.filter((s) => s > failure.failSec && s < failure.backSec).reduce((a, s) => a + perSec.get(s).batches[1], 0),
      recovery_s: recovered !== undefined ? recovered - failure.backSec : null,
    };
  }

  const first = summaries.filter((s) => !s.restarted);
  const secsRun = DUR / 1000;
  const row = {
    gateways: G, vehicles: perDepot * G, vehicles_per_gateway: perDepot,
    raw_messages: rawMessages,
    cloud_messages: cloudMsgs, cloud_msg_s: Number((cloudMsgs / secsRun).toFixed(2)),
    records_to_cloud: cloudRecords, records_s: Number((cloudRecords / secsRun).toFixed(1)),
    cloud_kb_s: Number((cloudBytes / 1024 / secsRun).toFixed(1)),
    max_gateway_cpu_pct: Math.max(...first.map((s) => s.cpu_pct)),
    avg_gateway_cpu_pct: Number((first.reduce((a, s) => a + s.cpu_pct, 0) / first.length).toFixed(1)),
    max_gateway_rss_mb: Math.max(...first.map((s) => s.rss_mb)),
    ...isolation,
  };
  row.reduction_pct = Number((100 * (1 - row.cloud_messages / row.raw_messages)).toFixed(2));
  console.log(`[multi] ${G} gateway(s): ${JSON.stringify(row)}`);
  return row;
}

const rows = [];
for (const g of String(args.gateways).split(',').map(Number)) rows.push(await runOne(g));
const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
fs.writeFileSync(path.join(OUT, 'multigateway_summary.csv'),
  [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n');
console.table(rows.map((r) => ({
  gateways: r.gateways, vehicles: r.vehicles, per_gw: r.vehicles_per_gateway, cloud_msg_s: r.cloud_msg_s,
  records_s: r.records_s, reduction: `${r.reduction_pct}%`, max_cpu: `${r.max_gateway_cpu_pct}%`,
  healthy_batch_s_before: r.healthy_batches_s_before ?? '-', healthy_batch_s_during: r.healthy_batches_s_during ?? '-',
  recovery_s: r.recovery_s ?? '-',
})));
console.log(`Saved ${path.join('results', 'edge', 'multigateway_summary.csv')}`);
process.exit(0);
