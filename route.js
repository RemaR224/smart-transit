// Route definitions for the simulator (approximate stops and timetable offsets).

// Fixed routes for the Smart Transit simulator.
// problem statement). Version 2 adds three more corridors in south-east and
// western Victoria so the system behaves like a small network rather than a
// single line, which is also what lets the scalability experiment ramp up
// realistic load (more routes x more vehicles).
// Coordinates are approximate station / stop locations and scheduled minutes
// are simplified timetable offsets from the start of a trip. They are
// documented assumptions, not official PTV / V/Line data. A real deployment
// would load GTFS shapes.txt and stop_times.txt instead; nothing downstream
// of this module would need to change.

const ROUTES = [
  {
    routeId: 'route-888',
    routeName: 'Cranbourne Station to Dandenong Station',
    mode: 'bus',
    capacity: 60,
    waypoints: [
      { lat: -38.1000, lon: 145.2833, stopName: 'Cranbourne Station', scheduledMinFromStart: 0 },
      { lat: -38.0930, lon: 145.2760, stopName: 'Cranbourne Park SC', scheduledMinFromStart: 4 },
      { lat: -38.0850, lon: 145.2650, stopName: 'High St / Clyde Rd', scheduledMinFromStart: 8 },
      { lat: -38.0700, lon: 145.2400, stopName: 'Hampton Park', scheduledMinFromStart: 14 },
      { lat: -38.0570, lon: 145.2270, stopName: 'Fountain Gate SC', scheduledMinFromStart: 19 },
      { lat: -38.0450, lon: 145.2150, stopName: 'Endeavour Hills', scheduledMinFromStart: 24 },
      { lat: -38.0270, lon: 145.2070, stopName: 'Dandenong North', scheduledMinFromStart: 29 },
      { lat: -38.0100, lon: 145.2000, stopName: 'Dandenong Station', scheduledMinFromStart: 34 },
    ],
  },
  {
    routeId: 'route-857',
    routeName: 'Frankston Station to Dandenong Station',
    mode: 'bus',
    capacity: 60,
    waypoints: [
      { lat: -38.1428, lon: 145.1259, stopName: 'Frankston Station', scheduledMinFromStart: 0 },
      { lat: -38.1330, lon: 145.1570, stopName: 'Karingal Hub', scheduledMinFromStart: 7 },
      { lat: -38.0960, lon: 145.1800, stopName: 'Carrum Downs', scheduledMinFromStart: 16 },
      { lat: -38.0480, lon: 145.1900, stopName: 'Keysborough', scheduledMinFromStart: 26 },
      { lat: -38.0200, lon: 145.2000, stopName: 'Dandenong South', scheduledMinFromStart: 31 },
      { lat: -37.9899, lon: 145.2098, stopName: 'Dandenong Station', scheduledMinFromStart: 36 },
    ],
  },
  {
    routeId: 'vline-traralgon',
    routeName: 'Dandenong to Traralgon (V/Line Gippsland)',
    mode: 'train',
    capacity: 300,
    waypoints: [
      { lat: -37.9899, lon: 145.2098, stopName: 'Dandenong', scheduledMinFromStart: 0 },
      { lat: -38.0404, lon: 145.3458, stopName: 'Berwick', scheduledMinFromStart: 12 },
      { lat: -38.0806, lon: 145.4859, stopName: 'Pakenham', scheduledMinFromStart: 21 },
      { lat: -38.1586, lon: 145.9313, stopName: 'Warragul', scheduledMinFromStart: 50 },
      { lat: -38.1752, lon: 146.2615, stopName: 'Moe', scheduledMinFromStart: 68 },
      { lat: -38.2347, lon: 146.3950, stopName: 'Morwell', scheduledMinFromStart: 78 },
      { lat: -38.1955, lon: 146.5402, stopName: 'Traralgon', scheduledMinFromStart: 87 },
    ],
  },
  {
    routeId: 'vline-ballarat',
    routeName: 'Southern Cross to Ballarat (V/Line)',
    mode: 'train',
    capacity: 300,
    waypoints: [
      { lat: -37.8184, lon: 144.9525, stopName: 'Southern Cross', scheduledMinFromStart: 0 },
      { lat: -37.8013, lon: 144.9031, stopName: 'Footscray', scheduledMinFromStart: 7 },
      { lat: -37.7883, lon: 144.8327, stopName: 'Sunshine', scheduledMinFromStart: 14 },
      { lat: -37.7773, lon: 144.7717, stopName: 'Deer Park', scheduledMinFromStart: 20 },
      { lat: -37.6863, lon: 144.5843, stopName: 'Melton', scheduledMinFromStart: 33 },
      { lat: -37.6866, lon: 144.4380, stopName: 'Bacchus Marsh', scheduledMinFromStart: 45 },
      { lat: -37.6033, lon: 144.2215, stopName: 'Ballan', scheduledMinFromStart: 58 },
      { lat: -37.5585, lon: 143.8594, stopName: 'Ballarat', scheduledMinFromStart: 78 },
    ],
  },
];

const ROUTE_888 = ROUTES[0]; // kept for backwards compatibility with v1 code

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildCumulativeDistances(waypoints) {
  const cumulative = [0];
  for (let i = 1; i < waypoints.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineKm(waypoints[i - 1], waypoints[i]));
  }
  return cumulative;
}

function positionAtDistance(waypoints, cumulative, distanceKm, direction = 1) {
  const totalKm = cumulative[cumulative.length - 1];
  const d = Math.max(0, Math.min(distanceKm, totalKm));

  let segment = cumulative.length - 2;
  for (let i = 0; i < cumulative.length - 1; i++) {
    if (d >= cumulative[i] && d <= cumulative[i + 1]) {
      segment = i;
      break;
    }
  }

  const segStart = cumulative[segment];
  const segEnd = cumulative[segment + 1];
  const segLen = segEnd - segStart || 1e-9;
  const t = (d - segStart) / segLen;

  const a = waypoints[segment];
  const b = waypoints[segment + 1];
  const lat = a.lat + (b.lat - a.lat) * t;
  const lon = a.lon + (b.lon - a.lon) * t;

  const nextIndex = direction === 1 ? segment + 1 : segment;
  const distToNext = direction === 1 ? segEnd - d : d - segStart;

  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    nextStop: waypoints[nextIndex],
    nextStopIndex: nextIndex,
    distanceToNextStopKm: Number(Math.max(0, distToNext).toFixed(3)),
    totalRouteKm: Number(totalKm.toFixed(3)),
  };
}

module.exports = { ROUTES, ROUTE_888, haversineKm, buildCumulativeDistances, positionAtDistance };
