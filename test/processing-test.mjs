// Unit tests for the processing logic.

import {
  validate, ema, etaSeconds, classifyCrowd, classifyDelay, processTelemetry,
} from '../processing/index.mjs';

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) < 0.01 : actual === expected;
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; console.log(`  FAIL  ${name}: expected ${expected}, got ${actual}`); }
}

const now = Date.parse('2026-09-28T08:00:00.000Z');
const base = {
  vehicle_id: 'bus-001', route_id: 'route-888', route_name: 'Cranbourne Station to Dandenong Station',
  mode: 'bus', trip_id: 'bus-001-t1', seq: 10, timestamp: new Date(now - 200).toISOString(),
  sent_at_ms: now - 200, lat: -38.07, lon: 145.24, speed_kmh: 40, occupancy_pct: 30,
  distance_to_next_stop_km: 2, next_stop: 'Hampton Park', status: 'in_service',
  scheduled_arrival_next_stop: new Date(now + 180000).toISOString(), // due in 3 min
};

console.log('Worked example from the project plan (section 5.1)');
check('2 km at 40 km/h -> ETA 180 s (3 min)', etaSeconds(2, 40), 180);
const onTime = processTelemetry(base, undefined, now);
check('bus due in 3 min, ETA 3 min -> delay 0 s', onTime.state.delay_seconds, 0);
check('delay 0 s -> on_time', onTime.state.delay_status, 'on_time');
check('end-to-end latency measured (200 ms)', onTime.latencyMs, 200);

console.log('\nSmoothing (EMA, alpha 0.3)');
check('ema(40, 10) = 31', ema(40, 10), 31);
check('first reading is used as-is', ema(undefined, 25), 25);
const prev = { ...onTime.state };
const slowed = processTelemetry({ ...base, seq: 11, sent_at_ms: now, speed_kmh: 10 }, prev, now);
check('one slow reading only drops smoothed speed to 31 km/h', slowed.state.smoothed_speed_kmh, 31);
// ETA = 2/31*3600 = 232.26 s -> delay 52 s -> still on time (noise is not a delay)
check('single slow reading does not flag a delay', slowed.state.delay_status, 'on_time');

console.log('\nSustained congestion becomes a delay');
let state = prev;
let result;
for (let i = 0; i < 6; i += 1) {
  result = processTelemetry({ ...base, seq: 12 + i, sent_at_ms: now + i, speed_kmh: 8 }, state, now);
  state = result.state;
}
check('6 readings at 8 km/h -> major_delay', result.state.delay_status, 'major_delay');

console.log('\nDelay bands');
check('-90 s -> early', classifyDelay(-90), 'early');
check('119 s -> on_time', classifyDelay(119), 'on_time');
check('200 s -> minor_delay', classifyDelay(200), 'minor_delay');
check('301 s -> major_delay', classifyDelay(301), 'major_delay');

console.log('\nCrowd bands (plan section 5.2)');
check('30% -> low', classifyCrowd(30), 'low');
check('60% -> moderate', classifyCrowd(60), 'moderate');
check('80% -> high', classifyCrowd(80), 'high');
check('97% -> full', classifyCrowd(97), 'full');

console.log('\nAlerts only fire on a change of state');
const fullPrev = { ...onTime.state, smoothed_occupancy_pct: 96, crowd_level: 'high' };
const becameFull = processTelemetry({ ...base, seq: 11, occupancy_pct: 100 }, fullPrev, now);
check('high -> full raises one CROWD alert', becameFull.alerts.filter((a) => a.type === 'CROWD').length, 1);
const stillFull = processTelemetry({ ...base, seq: 12, occupancy_pct: 100 }, becameFull.state, now);
check('already full -> no repeat alert', stillFull.alerts.length, 0);

console.log('\nValidation (same rules as the Node-RED filter)');
check('valid message accepted', validate(base), null);
check('missing vehicle_id rejected', validate({ ...base, vehicle_id: undefined }), 'missing vehicle_id');
check('occupancy 150% rejected', validate({ ...base, occupancy_pct: 150 }), 'occupancy out of range');

console.log('\nMessage loss detection');
const gapRes = processTelemetry({ ...base, seq: 15 }, { ...onTime.state, seq: 10 }, now);
check('seq 10 -> 15 counts 4 missed messages', gapRes.gap, 4);

console.log('\nLayover');
check('vehicle on layover -> no delay computed', processTelemetry({ ...base, status: 'layover', speed_kmh: 0 }, undefined, now).state.delay_status, 'layover');

console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
