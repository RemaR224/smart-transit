#!/usr/bin/env node
// Load-test analysis: reads TransitTelemetry by run_id and calculates
// throughput, message loss and latency percentiles.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const args = { table: 'TransitTelemetry', runs: '' };
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}
const runs = args.runs.split(',').map((s) => s.trim()).filter(Boolean);
if (!runs.length) { console.error('Give runs, e.g. --runs=base-20,lambda-20'); process.exit(1); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const credFile = path.join(ROOT, 'certs', 'aws-credentials.txt');
if (!process.env.AWS_SHARED_CREDENTIALS_FILE && fs.existsSync(credFile)) process.env.AWS_SHARED_CREDENTIALS_FILE = credFile;
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

// One scan of the table, keeping only records from the requested runs.
const byRun = new Map(runs.map((r) => [r, []]));
const names = {}; const values = {};
runs.forEach((r, i) => { values[`:r${i}`] = r; });
names['#run'] = 'run_id';
let ExclusiveStartKey; let scanned = 0;
process.stdout.write('Scanning TransitTelemetry');
do {
  const res = await ddb.send(new ScanCommand({
    TableName: args.table,
    FilterExpression: `#run IN (${runs.map((_, i) => `:r${i}`).join(', ')})`,
    ExpressionAttributeNames: { ...names, '#ts': 'ts', '#seq': 'seq', '#lat': 'latency_ms', '#p': 'processed_at_ms', '#v': 'vehicle_id', '#pl': 'pipeline' },
    ExpressionAttributeValues: values,
    ProjectionExpression: '#v, #ts, #seq, #lat, #p, #run, #pl',
    ExclusiveStartKey,
  }));
  scanned += res.ScannedCount || 0;
  for (const it of res.Items || []) byRun.get(it.run_id)?.push(it);
  ExclusiveStartKey = res.LastEvaluatedKey;
  process.stdout.write('.');
} while (ExclusiveStartKey);
console.log(` scanned ${scanned} items\n`);

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null;
const outDir = path.join(ROOT, 'results');
fs.mkdirSync(outDir, { recursive: true });

const rows = [];
for (const run of runs) {
  const items = byRun.get(run);
  if (!items.length) { rows.push({ run, note: 'no records found' }); continue; }
  const maxSeq = new Map(); const minSeq = new Map();
  items.forEach((it) => {
    maxSeq.set(it.vehicle_id, Math.max(maxSeq.get(it.vehicle_id) || 0, it.seq));
    minSeq.set(it.vehicle_id, Math.min(minSeq.get(it.vehicle_id) ?? Infinity, it.seq));
  });
  const expected = [...maxSeq.entries()].reduce((s, [v, mx]) => s + (mx - minSeq.get(v) + 1), 0);
  const lat = items.map((i) => i.latency_ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const t0 = Math.min(...items.map((i) => i.ts));
  const t1 = Math.max(...items.map((i) => i.processed_at_ms));
  const durationS = Math.max(1, (t1 - t0) / 1000);
  const row = {
    run,
    pipeline: items[0].pipeline,
    vehicles: maxSeq.size,
    sent: expected,
    processed: items.length,
    loss_pct: Number((((expected - items.length) / expected) * 100).toFixed(2)),
    throughput_msg_s: Number((items.length / durationS).toFixed(1)),
    latency_avg_ms: Math.round(lat.reduce((s, x) => s + x, 0) / lat.length),
    latency_p50_ms: pct(lat, 50),
    latency_p95_ms: pct(lat, 95),
    latency_p99_ms: pct(lat, 99),
    latency_max_ms: lat[lat.length - 1],
  };
  rows.push(row);

  // per-second time series (by send time) for charts
  const buckets = new Map();
  items.forEach((it) => {
    const s = Math.floor((it.ts - t0) / 1000);
    const b = buckets.get(s) || []; b.push(it.latency_ms); buckets.set(s, b);
  });
  const ts = ['second,messages,latency_p50_ms,latency_p95_ms,latency_max_ms'];
  [...buckets.keys()].sort((a, b) => a - b).forEach((s) => {
    const l = buckets.get(s).sort((a, b) => a - b);
    ts.push([s, l.length, pct(l, 50), pct(l, 95), l[l.length - 1]].join(','));
  });
  fs.writeFileSync(path.join(outDir, `${run}-timeseries.csv`), ts.join('\n') + '\n');
}

console.table(rows);
const cols = ['run', 'pipeline', 'vehicles', 'sent', 'processed', 'loss_pct', 'throughput_msg_s',
  'latency_avg_ms', 'latency_p50_ms', 'latency_p95_ms', 'latency_p99_ms', 'latency_max_ms'];
const csvPath = path.join(outDir, 'summary.csv');
const existing = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1) : [];
const keep = existing.filter((line) => !runs.includes(line.split(',')[0]));
const lines = [cols.join(','), ...keep, ...rows.filter((r) => !r.note).map((r) => cols.map((c) => r[c]).join(','))];
fs.writeFileSync(csvPath, lines.join('\n') + '\n');
console.log(`\nSaved results/summary.csv and results/<run>-timeseries.csv files.`);
