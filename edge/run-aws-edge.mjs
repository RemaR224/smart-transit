// Run the edge gateway against AWS IoT Core
// usage: node edge/run-aws-edge.mjs --endpoint=<iot-endpoint> --vehicles=200
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import Aedes from 'aedes';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {
  endpoint: '', mode: 'edge', vehicles: 200, durationMs: 180000, port: 1883, gateway: 'edge-dandenong',
  cert: 'certs/edge.cert.pem', key: 'certs/edge.private.key', ca: 'certs/AmazonRootCA1.pem',
};
for (const raw of process.argv.slice(2)) {
  const [k, ...rest] = raw.replace(/^--/, '').split('=');
  if (rest.length) args[k] = rest.join('=');
}
if (!args.endpoint) {
  console.error('Please add --endpoint=<your AWS IoT device data endpoint> (AWS IoT Core > Settings)');
  process.exit(1);
}
const V = Number(args.vehicles); const DUR = Number(args.durationMs);
const runId = `aws-${args.mode}-${V}`;

function runChild(file, childArgs, onLine) {
  const child = spawn(process.execPath, [path.join(ROOT, file), ...childArgs], { cwd: ROOT });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { if (!l.startsWith('EDGE_SUMMARY')) console.log(l); if (onLine) onLine(l); }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return new Promise((resolve) => child.on('exit', resolve));
}

const aedes = await Aedes.createBroker?.() ?? Aedes();
const server = net.createServer(aedes.handle);
await new Promise((r) => server.listen(Number(args.port), r));
console.log(`[aws-run] depot broker on mqtt://localhost:${args.port}, sending batches to ${args.endpoint}`);
console.log(`[aws-run] start time ${new Date().toISOString()} (use this to find the run in CloudWatch)`);

let summary = null;
const gw = runChild('edge/edge-gateway.mjs', [
  `--broker=mqtt://localhost:${args.port}`, `--upstream=mqtts://${args.endpoint}:8883`,
  `--cert=${args.cert}`, `--key=${args.key}`, `--ca=${args.ca}`,
  `--mode=${args.mode}`, `--gateway=${args.gateway}`, `--durationMs=${DUR + 5000}`,
], (l) => { if (l.startsWith('EDGE_SUMMARY ')) summary = JSON.parse(l.slice(13)); });
await new Promise((r) => setTimeout(r, 3000)); // wait for AWS connection
await runChild('simulator.js', [`--vehicles=${V}`, '--interval=1000', `--connections=${Math.ceil(V / 250)}`,
  `--durationMs=${DUR}`, `--broker=mqtt://localhost:${args.port}`, `--runId=${runId}`]);
await gw;
server.close(); aedes.close();

if (summary) {
  console.log('\n[aws-run] Edge gateway summary (real AWS IoT Core upstream)');
  console.table([{
    vehicles: V, seconds: summary.seconds, raw_messages: summary.received,
    records_sent: summary.forwarded_records, batches_to_aws: summary.upstream_messages,
    batches_per_s: Number((summary.upstream_messages / summary.seconds).toFixed(2)),
    reduction: `${summary.reduction_pct}%`, kb_to_aws: Number((summary.upstream_bytes / 1024).toFixed(1)),
    local_alerts: summary.local_alerts, edge_cpu: `${summary.cpu_pct}%`,
  }]);
}
process.exit(0);
