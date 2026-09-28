#!/usr/bin/env node
// Vehicle telemetry simulator: buses and V/Line trains publishing GPS, speed
// and occupancy over MQTT (AWS IoT Core or a local broker).

const fs = require('fs');
const mqtt = require('mqtt');
const { ROUTES, buildCumulativeDistances, positionAtDistance } = require('./route');

// CLI args (dependency-free on purpose)
function parseArgs(argv) {
  const args = {
    vehicles: 8, interval: 5000, broker: 'mqtt://localhost:1883', durationMs: 0,
    routes: 'all', connections: 1, scenario: 'normal', qos: 0, runId: '',
  };
  for (const raw of argv.slice(2)) {
    const [key, ...rest] = raw.replace(/^--/, '').split('=');
    if (rest.length === 0) continue;
    args[key] = rest.join('=');
  }
  args.vehicles = parseInt(args.vehicles, 10);
  args.interval = parseInt(args.interval, 10);
  args.durationMs = parseInt(args.durationMs, 10) || 0; // 0 = run forever
  args.connections = Math.max(1, parseInt(args.connections, 10) || 1);
  args.qos = parseInt(args.qos, 10) === 1 ? 1 : 0;
  return args;
}

const args = parseArgs(process.argv);

const activeRoutes = args.routes === 'all'
  ? ROUTES
  : ROUTES.filter((r) => args.routes.split(',').includes(r.routeId));
if (activeRoutes.length === 0) {
  console.error(`[simulator] no routes matched "${args.routes}". Valid: ${ROUTES.map((r) => r.routeId).join(', ')}`);
  process.exit(1);
}

// MQTT connections (TLS device-cert auth for AWS IoT Core, plain for local)
function buildMqttOptions(index) {
  const options = {
    clientId: `vehicle-sim-${index}-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 2000,
  };
  if (args.cert && args.key && args.ca) {
    options.cert = fs.readFileSync(args.cert);
    options.key = fs.readFileSync(args.key);
    options.ca = fs.readFileSync(args.ca);
  }
  return options;
}

const clients = Array.from({ length: args.connections }, (_, i) => {
  const c = mqtt.connect(args.broker, buildMqttOptions(i));
  c.on('connect', () => console.log(`[simulator] connection ${i + 1}/${args.connections} connected to ${args.broker}`));
  c.on('error', (err) => console.error(`[simulator] connection ${i + 1} MQTT error:`, err.message));
  return c;
});

// Route pre-computation
const routeInfo = new Map(activeRoutes.map((r) => {
  const cumulative = buildCumulativeDistances(r.waypoints);
  return [r.routeId, {
    route: r,
    cumulative,
    totalKm: cumulative[cumulative.length - 1],
    totalMin: r.waypoints[r.waypoints.length - 1].scheduledMinFromStart,
  }];
}));

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function scheduledMinAtDistance(info, distanceKm, direction) {
  const { route, cumulative, totalMin } = info;
  const wp = route.waypoints;
  let outboundMin = totalMin;
  for (let i = 0; i < cumulative.length - 1; i++) {
    if (distanceKm >= cumulative[i] && distanceKm <= cumulative[i + 1]) {
      const t = (distanceKm - cumulative[i]) / ((cumulative[i + 1] - cumulative[i]) || 1e-9);
      outboundMin = wp[i].scheduledMinFromStart + t * (wp[i + 1].scheduledMinFromStart - wp[i].scheduledMinFromStart);
      break;
    }
  }
  return direction === 1 ? outboundMin : totalMin - outboundMin;
}

function segmentScheduledSpeed(info, distanceKm) {
  const { route, cumulative } = info;
  for (let i = 0; i < cumulative.length - 1; i++) {
    if (distanceKm >= cumulative[i] && distanceKm <= cumulative[i + 1]) {
      const km = cumulative[i + 1] - cumulative[i];
      const min = route.waypoints[i + 1].scheduledMinFromStart - route.waypoints[i].scheduledMinFromStart;
      return (km / Math.max(min, 0.5)) * 60;
    }
  }
  return 40;
}

// Vehicle state + physics
function makeVehicle(index) {
  const info = routeInfo.get(activeRoutes[index % activeRoutes.length].routeId);
  const prefix = info.route.mode === 'train' ? 'train' : 'bus';
  const direction = Math.random() < 0.5 ? 1 : -1;
  const distanceKm = randomBetween(0.05, info.totalKm - 0.05); // stagger positions
  const now = Date.now();
  const elapsedMin = scheduledMinAtDistance(info, distanceKm, direction);
  const capacity = info.route.capacity;
  return {
    vehicleId: `${prefix}-${String(index + 1).padStart(3, '0')}`,
    info,
    client: clients[index % clients.length],
    distanceKm,
    direction, // 1 = outbound (first stop -> last stop), -1 = inbound
    // Some drivers / services run a little faster or slower than the timetable.
    paceFactor: randomBetween(0.92, 1.06),
    tripNo: 1,
    tripStartMs: now - elapsedMin * 60000, // on time at start
    capacity,
    occupancy: Math.round(capacity * randomBetween(0.1, 0.4)),
    congestionTicksRemaining: 0,
    layoverTicksRemaining: 0,
    currentSpeedKmh: undefined,
    seq: 0,
  };
}

const fleet = Array.from({ length: args.vehicles }, (_, i) => makeVehicle(i));

function stepVehicle(v, intervalMs) {
  const { info } = v;
  const now = Date.now();

  // Layover at a terminus: stand still, then start a new timetabled trip.
  if (v.layoverTicksRemaining > 0) {
    v.layoverTicksRemaining -= 1;
    v.currentSpeedKmh = 0;
    if (v.layoverTicksRemaining === 0) v.currentSpeedKmh = undefined; // depart at normal speed
  } else {
    // Congestion / incident events (the thing delay prediction must detect).
    // Probabilities and durations are defined per 5 s of simulated time, so
    // behaviour is the same whatever --interval is used.
    const tickScale = intervalMs / 5000;
    if (v.congestionTicksRemaining > 0) {
      v.congestionTicksRemaining -= 1;
    } else if (Math.random() < 0.02 * tickScale) {
      v.congestionTicksRemaining = Math.round(randomBetween(3, 10) / tickScale); // traffic / signals
    } else if (Math.random() < 0.002 * tickScale) {
      v.congestionTicksRemaining = Math.round(randomBetween(30, 60) / tickScale); // rare major incident
    }
    const congested = v.congestionTicksRemaining > 0;
    // Schedule recovery: like real drivers, a late vehicle speeds up a little
    // (up to ~15%) and an early one eases off, so delays caused by congestion
    // recover over time instead of growing for the whole trip.
    const elapsedMin = (now - v.tripStartMs) / 60000;
    const plannedMin = scheduledMinAtDistance(info, v.distanceKm, v.direction);
    const lateMin = elapsedMin - plannedMin;
    const recovery = lateMin > 1 ? 1.15 : lateMin < -1 ? 0.9 : 1;
    const scheduledSpeed = segmentScheduledSpeed(info, v.distanceKm) * v.paceFactor * recovery;
    // Buses crawl in traffic; trains slow down for signals / speed restrictions.
    const slowFactor = info.route.mode === 'train' ? randomBetween(0.35, 0.6) : randomBetween(0.1, 0.3);
    const targetSpeed = congested ? scheduledSpeed * slowFactor : scheduledSpeed;
    v.currentSpeedKmh = v.currentSpeedKmh === undefined
      ? targetSpeed
      : v.currentSpeedKmh + (targetSpeed - v.currentSpeedKmh) * 0.4;

    v.distanceKm += v.currentSpeedKmh * (intervalMs / 3_600_000) * v.direction;

    // Reached a terminus: everyone gets off, turn around after a short layover.
    if (v.distanceKm >= info.totalKm || v.distanceKm <= 0) {
      v.distanceKm = v.distanceKm >= info.totalKm ? info.totalKm : 0;
      v.direction *= -1;
      v.layoverTicksRemaining = 3;
      v.occupancy = Math.round(v.capacity * randomBetween(0.05, 0.15));
      // The next trip is timetabled to depart when the layover ends.
      v.tripNo += 1;
      v.tripStartMs = now + v.layoverTicksRemaining * intervalMs;
    }
  }

  // Occupancy: bounded random walk, scaled to vehicle size. Peak scenario
  // biases towards boarding so vehicles become crowded.
  const scale = v.capacity / 60;
  const bias = args.scenario === 'peak' ? 3 : 0.5;
  const delta = Math.round(randomBetween(-4, 4 + bias) * scale * Math.min(1, args.interval / 5000) ** 0.5);
  v.occupancy = Math.max(0, Math.min(v.capacity, v.occupancy + delta));

  const pos = positionAtDistance(info.route.waypoints, info.cumulative, v.distanceKm, v.direction);
  const nextStopOffsetMin = v.direction === 1
    ? pos.nextStop.scheduledMinFromStart
    : info.totalMin - pos.nextStop.scheduledMinFromStart;
  const scheduledArrivalMs = v.tripStartMs + nextStopOffsetMin * 60000;

  v.seq += 1;
  return {
    vehicle_id: v.vehicleId,
    route_id: info.route.routeId,
    route_name: info.route.routeName,
    mode: info.route.mode,
    trip_id: `${v.vehicleId}-t${v.tripNo}`,
    seq: v.seq,
    timestamp: new Date(now).toISOString(),
    sent_at_ms: now,
    lat: pos.lat,
    lon: pos.lon,
    speed_kmh: Number((v.currentSpeedKmh || 0).toFixed(1)),
    occupancy_count: v.occupancy,
    occupancy_pct: Number(((v.occupancy / v.capacity) * 100).toFixed(1)),
    capacity: v.capacity,
    distance_to_next_stop_km: pos.distanceToNextStopKm,
    next_stop: pos.nextStop.stopName,
    scheduled_arrival_next_stop: new Date(scheduledArrivalMs).toISOString(),
    direction: v.direction === 1 ? 'outbound' : 'inbound',
    status: v.layoverTicksRemaining > 0 ? 'layover' : 'in_service',
    run_id: args.runId || undefined,
  };
}

// Publish loop - each vehicle has its own timer, staggered across the
// interval, so load is smooth rather than one burst per tick.
const stats = { published: 0, failed: 0, skippedDisconnected: 0, startedAt: Date.now() };
let lastMessage = null;
const timers = [];

fleet.forEach((v, i) => {
  const offset = Math.floor((i / fleet.length) * args.interval);
  const starter = setTimeout(() => {
    const tick = () => {
      if (!v.client.connected) { stats.skippedDisconnected += 1; return; }
      const message = stepVehicle(v, args.interval);
      const topic = `transit/${message.route_id}/vehicle/${message.vehicle_id}/telemetry`;
      v.client.publish(topic, JSON.stringify(message), { qos: args.qos }, (err) => {
        if (err) { stats.failed += 1; console.error(`[simulator] publish failed for ${message.vehicle_id}:`, err.message); }
      });
      stats.published += 1;
      lastMessage = message;
    };
    tick();
    timers.push(setInterval(tick, args.interval));
  }, offset);
  timers.push(starter);
});

console.log(`[simulator] ${fleet.length} vehicle(s) on ${activeRoutes.length} route(s) [${activeRoutes.map((r) => r.routeId).join(', ')}], `
  + `interval ${args.interval}ms, ${args.connections} connection(s), scenario=${args.scenario}`
  + ` -> target ${(fleet.length * 1000 / args.interval).toFixed(1)} msg/s`);

const reporter = setInterval(() => {
  const secs = (Date.now() - stats.startedAt) / 1000;
  console.log(`[simulator] ${secs.toFixed(0)}s: published=${stats.published} (${(stats.published / secs).toFixed(1)} msg/s) `
    + `failed=${stats.failed} skipped(disconnected)=${stats.skippedDisconnected}`);
  if (lastMessage) console.log(`[simulator] sample: ${JSON.stringify(lastMessage)}`);
}, Math.max(args.interval * 6, 10000));

function shutdown(reason) {
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  clearInterval(reporter);
  const secs = (Date.now() - stats.startedAt) / 1000;
  console.log(`[simulator] ${reason}. Summary: published=${stats.published} in ${secs.toFixed(1)}s `
    + `(${(stats.published / secs).toFixed(1)} msg/s), failed=${stats.failed}, skipped=${stats.skippedDisconnected}`);
  let pending = clients.length;
  clients.forEach((c) => c.end(false, {}, () => { pending -= 1; if (pending === 0) process.exit(0); }));
  setTimeout(() => process.exit(0), 3000);
}

if (args.durationMs > 0) setTimeout(() => shutdown(`finished after ${args.durationMs}ms`), args.durationMs);
process.on('SIGINT', () => shutdown('stopped (Ctrl+C)'));
