#!/usr/bin/env node
// Baseline (single-server) processor used for the before-scaling load test.
// Runs the same processing code as the Lambda function, one message at a time.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';

const args = {
  endpoint: 'a2eupkg9muh4ko-ats.iot.us-east-1.amazonaws.com',
  topic: 'transit/+/vehicle/+/telemetry',
};
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}

// Same environment as the Lambda function, set before the module loads.
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
process.env.PIPELINE = 'baseline';
process.env.LOG_METRICS = 'false'; // per-message metrics are measured from DynamoDB instead
process.env.IOT_ENDPOINT = process.env.IOT_ENDPOINT || args.endpoint;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const credFile = path.join(ROOT, 'certs', 'aws-credentials.txt');
if (!process.env.AWS_SHARED_CREDENTIALS_FILE && fs.existsSync(credFile)) {
  process.env.AWS_SHARED_CREDENTIALS_FILE = credFile; // only used when not on EC2
}
const { handleMessage } = await import('../processing/index.mjs');

// --broker=mqtt://localhost:1883 is only for local testing without AWS IoT Core.
const client = args.broker
  ? mqtt.connect(args.broker, { reconnectPeriod: 2000 })
  : mqtt.connect(`mqtts://${args.endpoint}:8883`, {
    clientId: `baseline-${os.hostname()}-${Math.random().toString(16).slice(2, 6)}`,
    cert: fs.readFileSync(path.resolve(args.cert)),
    key: fs.readFileSync(path.resolve(args.key)),
    ca: fs.readFileSync(path.resolve(args.ca)),
    reconnectPeriod: 2000,
  });

const queue = [];
const stats = { received: 0, processed: 0, errors: 0, busyMs: 0, maxQueue: 0 };
let working = false;

client.on('connect', () => {
  console.log(`[baseline] connected on ${os.hostname()}, subscribing to ${args.topic}`);
  client.subscribe(args.topic, { qos: 0 });
});
client.on('error', (e) => console.error('[baseline] MQTT error:', e.message));
client.on('message', (_topic, payload) => {
  stats.received += 1;
  try { queue.push(JSON.parse(payload.toString())); } catch { stats.errors += 1; }
  stats.maxQueue = Math.max(stats.maxQueue, queue.length);
  if (!working) work();
});

// Single worker: exactly one message is being processed at any time.
async function work() {
  working = true;
  while (queue.length) {
    const msg = queue.shift();
    const t0 = Date.now();
    try { await handleMessage(msg, 'baseline'); stats.processed += 1; } catch (e) {
      stats.errors += 1;
      if (stats.errors < 5) console.error('[baseline] processing error:', e.message);
    }
    stats.busyMs += Date.now() - t0;
  }
  working = false;
}

let last = { t: Date.now(), received: 0, processed: 0, busyMs: 0 };
setInterval(() => {
  const now = Date.now();
  const secs = (now - last.t) / 1000;
  const inRate = (stats.received - last.received) / secs;
  const outRate = (stats.processed - last.processed) / secs;
  const n = stats.processed - last.processed;
  const avgMs = n ? (stats.busyMs - last.busyMs) / n : 0;
  console.log(`[baseline] in ${inRate.toFixed(1)} msg/s | processed ${outRate.toFixed(1)} msg/s | avg ${avgMs.toFixed(1)} ms/msg`
    + ` | queue ${queue.length} (max ${stats.maxQueue}) | total ${stats.processed}/${stats.received} errors ${stats.errors}`);
  last = { t: now, received: stats.received, processed: stats.processed, busyMs: stats.busyMs };
}, 10000);

process.on('SIGINT', () => {
  console.log(`[baseline] stopping. processed ${stats.processed}/${stats.received}, max queue ${stats.maxQueue}, errors ${stats.errors}`);
  client.end(false, {}, () => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
