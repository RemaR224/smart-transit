// Simulator test against an in-memory MQTT broker (no AWS needed).

const aedes = require('aedes')();
const net = require('net');
const mqtt = require('mqtt');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18830;
const TEST_DURATION_MS = 12000;
const EXPECTED_VEHICLES = 4; // one per route (round-robin)
const EXPECTED_ROUTES = ['route-888', 'route-857', 'vline-traralgon', 'vline-ballarat'];
const EXPECTED_TICKS = 2; // require at least 2 full rounds from every vehicle

const REQUIRED_FIELDS = [
  'vehicle_id', 'route_id', 'timestamp', 'lat', 'lon',
  'speed_kmh', 'occupancy_count', 'occupancy_pct', 'capacity',
  'distance_to_next_stop_km', 'next_stop', 'direction',
  'route_name', 'mode', 'trip_id', 'seq', 'sent_at_ms', 'scheduled_arrival_next_stop',
];

// Bounding box covering all four corridors in route.js (Ballarat in the west
// to Traralgon in the east).
const BOUNDS = { latMin: -38.30, latMax: -37.50, lonMin: 143.80, lonMax: 146.60 };
const lastSeq = new Map();

const messagesByVehicle = new Map();
const errors = [];

const broker = net.createServer(aedes.handle);

broker.listen(PORT, () => {
  console.log(`[test] mock broker listening on mqtt://localhost:${PORT}`);

  const subscriber = mqtt.connect(`mqtt://localhost:${PORT}`);
  subscriber.on('connect', () => {
    subscriber.subscribe('transit/+/vehicle/+/telemetry');
    console.log('[test] subscribed to transit/+/vehicle/+/telemetry');
    startSimulator();
  });

  subscriber.on('message', (topic, payload) => {
    let msg;
    try {
      msg = JSON.parse(payload.toString());
    } catch (e) {
      errors.push(`Invalid JSON on ${topic}: ${e.message}`);
      return;
    }
    validateMessage(msg, topic);
    const list = messagesByVehicle.get(msg.vehicle_id) || [];
    list.push(msg);
    messagesByVehicle.set(msg.vehicle_id, list);
  });

  setTimeout(finish, TEST_DURATION_MS);
});

function validateMessage(msg, topic) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in msg)) errors.push(`${topic}: missing field "${field}"`);
  }
  if (typeof msg.lat === 'number' && (msg.lat < BOUNDS.latMin || msg.lat > BOUNDS.latMax)) {
    errors.push(`${topic}: lat ${msg.lat} outside expected bounds`);
  }
  if (typeof msg.lon === 'number' && (msg.lon < BOUNDS.lonMin || msg.lon > BOUNDS.lonMax)) {
    errors.push(`${topic}: lon ${msg.lon} outside expected bounds`);
  }
  if (typeof msg.speed_kmh === 'number' && (msg.speed_kmh < 0 || msg.speed_kmh > 170)) {
    errors.push(`${topic}: speed_kmh ${msg.speed_kmh} out of sane range`);
  }
  if (typeof msg.occupancy_pct === 'number' && (msg.occupancy_pct < 0 || msg.occupancy_pct > 100)) {
    errors.push(`${topic}: occupancy_pct ${msg.occupancy_pct} out of range`);
  }
  if (Number.isNaN(Date.parse(msg.scheduled_arrival_next_stop))) {
    errors.push(`${topic}: scheduled_arrival_next_stop is not a valid date`);
  }
  const prev = lastSeq.get(msg.vehicle_id) || 0;
  if (msg.seq !== prev + 1) errors.push(`${topic}: seq jumped from ${prev} to ${msg.seq}`);
  lastSeq.set(msg.vehicle_id, msg.seq);
}

let simProc;
function startSimulator() {
  simProc = spawn('node', [
    path.join(__dirname, '..', 'simulator.js'),
    `--vehicles=${EXPECTED_VEHICLES}`,
    '--interval=2000',
    `--broker=mqtt://localhost:${PORT}`,
    `--durationMs=${TEST_DURATION_MS - 1000}`,
  ]);
  simProc.stdout.on('data', (d) => process.stdout.write(`[sim] ${d}`));
  simProc.stderr.on('data', (d) => process.stderr.write(`[sim:err] ${d}`));
}

function finish() {
  console.log('\n[test] ---- results ----');
  let pass = errors.length === 0;

  if (messagesByVehicle.size !== EXPECTED_VEHICLES) {
    pass = false;
    errors.push(`Expected messages from ${EXPECTED_VEHICLES} vehicles, got ${messagesByVehicle.size}`);
  }

  const routesSeen = new Set([...messagesByVehicle.values()].flat().map((m) => m.route_id));
  for (const r of EXPECTED_ROUTES) {
    if (!routesSeen.has(r)) { pass = false; errors.push(`No messages for route ${r}`); }
  }
  console.log(`  routes seen: ${[...routesSeen].join(', ')}`);

  for (const [vehicleId, msgs] of messagesByVehicle.entries()) {
    console.log(`  ${vehicleId}: ${msgs.length} messages received`);
    if (msgs.length < EXPECTED_TICKS) {
      pass = false;
      errors.push(`${vehicleId}: only received ${msgs.length} messages, expected >= ${EXPECTED_TICKS}`);
    }
  }

  if (errors.length) {
    console.log('\n[test] issues found:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  console.log(`\n[test] RESULT: ${pass ? 'PASS' : 'FAIL'}`);

  if (simProc && !simProc.killed) simProc.kill();
  broker.close();
  process.exit(pass ? 0 : 1);
}
