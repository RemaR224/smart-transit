#!/usr/bin/env node
/**
 * Vehicle telemetry simulator — Smart Transit: Real-Time Delay Prediction &
 * Crowd Management System (Project Plan section 7.1).
 *
 * Simulates a small fleet of buses running route-888 (see route.js),
 * publishing one JSON telemetry message per vehicle per tick over MQTT:
 *   { vehicle_id, route_id, timestamp, lat, lon, speed_kmh, occupancy_pct,
 *     capacity, distance_to_next_stop_km, next_stop }
 * matching the "Example Fields" in the plan's Data Design table (section 8).
 *
 * Works two ways:
 *   1. Local / test mode  — point --broker at a local MQTT broker
 *      (mqtt://localhost:1883), no auth. Good for developing without AWS.
 *   2. AWS IoT Core mode  — point --broker at your IoT Core endpoint
 *      (mqtts://xxxx-ats.iot.<region>.amazonaws.com:8883) and pass
 *      --cert/--key/--ca for the X.509 device certificate AWS IoT Core
 *      requires. See simulator/README.md for the full setup walkthrough.
 *
 * Usage:
 *   node simulator.js --vehicles=5 --interval=5000 --broker=mqtt://localhost:1883
 *   node simulator.js --vehicles=20 --broker=mqtts://xxxx-ats.iot.ap-southeast-2.amazonaws.com:8883 \
 *        --cert=certs/device.cert.pem --key=certs/device.private.key --ca=certs/AmazonRootCA1.pem
 */

const fs = require('fs');
const mqtt = require('mqtt');
const { ROUTE_888, buildCumulativeDistances, positionAtDistance } = require('./route');

// ---------------------------------------------------------------------------
// CLI args (kept dependency-free on purpose — no minimist needed for this).
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { vehicles: 5, interval: 5000, broker: 'mqtt://localhost:1883', durationMs: 0 };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (value === undefined) continue;
    args[key] = value;
  }
  args.vehicles = parseInt(args.vehicles, 10);
  args.interval = parseInt(args.interval, 10);
  args.durationMs = parseInt(args.durationMs, 10) || 0; // 0 = run forever
  return args;
}

const args = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// MQTT connection (TLS device-cert auth for AWS IoT Core, plain for local).
// ---------------------------------------------------------------------------
function buildMqttOptions(args) {
  const options = { clientId: `vehicle-sim-${Math.random().toString(16).slice(2)}`, reconnectPeriod: 2000 };
  if (args.cert && args.key && args.ca) {
    options.cert = fs.readFileSync(args.cert);
    options.key = fs.readFileSync(args.key);
    options.ca = fs.readFileSync(args.ca);
  }
  return options;
}

const client = mqtt.connect(args.broker, buildMqttOptions(args));

client.on('connect', () => {
  console.log(`[simulator] connected to ${args.broker}`);
  console.log(`[simulator] publishing ${args.vehicles} vehicle(s) on route "${ROUTE_888.routeName}" every ${args.interval}ms`);
});

client.on('error', (err) => {
  console.error('[simulator] MQTT error:', err.message);
});

// ---------------------------------------------------------------------------
// Vehicle state + physics
// ---------------------------------------------------------------------------
const cumulative = buildCumulativeDistances(ROUTE_888.waypoints);
const totalRouteKm = cumulative[cumulative.length - 1];
const CAPACITY = 60; // seated + standing, matches "Full" band upper bound

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function makeVehicle(index) {
  return {
    vehicleId: `bus-${String(index + 1).padStart(3, '0')}`,
    routeId: ROUTE_888.routeId,
    distanceKm: randomBetween(0, totalRouteKm), // stagger starting positions
    direction: 1, // 1 = towards Dandenong, -1 = back towards Cranbourne
    baseSpeedKmh: randomBetween(28, 45),
    occupancy: Math.round(randomBetween(5, 25)),
    // Occasionally a vehicle hits "traffic": speed drops sharply for a
    // few ticks, which is exactly the kind of event the delay-prediction
    // service (plan section 5.1) needs to be able to detect.
    congestionTicksRemaining: 0,
  };
}

const fleet = Array.from({ length: args.vehicles }, (_, i) => makeVehicle(i));

function stepVehicle(v, intervalMs) {
  // Randomly enter/continue a congestion event.
  if (v.congestionTicksRemaining > 0) {
    v.congestionTicksRemaining -= 1;
  } else if (Math.random() < 0.03) {
    v.congestionTicksRemaining = Math.round(randomBetween(3, 8)); // several ticks of slow speed
  }

  const congested = v.congestionTicksRemaining > 0;
  const targetSpeed = congested ? randomBetween(4, 12) : v.baseSpeedKmh;
  // Simple exponential smoothing towards target speed so speed changes
  // look continuous rather than jumping instantly tick to tick.
  v.currentSpeedKmh = v.currentSpeedKmh === undefined
    ? targetSpeed
    : v.currentSpeedKmh + (targetSpeed - v.currentSpeedKmh) * 0.4;

  const hours = intervalMs / 3_600_000;
  const deltaKm = v.currentSpeedKmh * hours * v.direction;
  v.distanceKm += deltaKm;

  // Bounce back and forth along the route instead of teleporting.
  if (v.distanceKm >= totalRouteKm) {
    v.distanceKm = totalRouteKm;
    v.direction = -1;
  } else if (v.distanceKm <= 0) {
    v.distanceKm = 0;
    v.direction = 1;
  }

  // Occupancy: bounded random walk, with a slightly higher chance of
  // boarding (going up) than alighting, to emulate net loading over a trip.
  const occupancyDelta = Math.round(randomBetween(-4, 5));
  v.occupancy = Math.max(0, Math.min(CAPACITY, v.occupancy + occupancyDelta));

  const pos = positionAtDistance(ROUTE_888.waypoints, cumulative, v.distanceKm);

  return {
    vehicle_id: v.vehicleId,
    route_id: v.routeId,
    timestamp: new Date().toISOString(),
    lat: pos.lat,
    lon: pos.lon,
    speed_kmh: Number(v.currentSpeedKmh.toFixed(1)),
    occupancy_count: v.occupancy,
    occupancy_pct: Number(((v.occupancy / CAPACITY) * 100).toFixed(1)),
    capacity: CAPACITY,
    distance_to_next_stop_km: pos.distanceToNextStopKm,
    next_stop: pos.nextStop.stopName,
    direction: v.direction === 1 ? 'outbound' : 'inbound',
  };
}

// ---------------------------------------------------------------------------
// Publish loop
// ---------------------------------------------------------------------------
let tickCount = 0;
const timer = setInterval(() => {
  if (!client.connected) return;

  for (const v of fleet) {
    const message = stepVehicle(v, args.interval);
    const topic = `transit/${message.route_id}/vehicle/${message.vehicle_id}/telemetry`;
    client.publish(topic, JSON.stringify(message), { qos: 0 }, (err) => {
      if (err) console.error(`[simulator] publish failed for ${message.vehicle_id}:`, err.message);
    });
  }

  tickCount += 1;
  if (tickCount % 6 === 0) {
    console.log(`[simulator] tick ${tickCount}: published ${fleet.length} messages (sample: ${JSON.stringify(stepVehicle(fleet[0], 0))})`);
  }
}, args.interval);

if (args.durationMs > 0) {
  setTimeout(() => {
    clearInterval(timer);
    client.end(false, {}, () => {
      console.log(`[simulator] finished after ${args.durationMs}ms, disconnected cleanly`);
      process.exit(0);
    });
  }, args.durationMs);
}

process.on('SIGINT', () => {
  clearInterval(timer);
  client.end(false, {}, () => process.exit(0));
});
