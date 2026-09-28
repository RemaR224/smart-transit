// A simplified fixed bus route standing in for a real GTFS shape.
//
// The project plan (section 7.1) calls for the vehicle simulator to
// "generate GPS coordinates along a fixed route". Rather than inventing
// arbitrary coordinates, this route roughly follows the Cranbourne ->
// Dandenong corridor mentioned in the plan's problem statement (section 1),
// so the demo data stays connected to the real motivating scenario.
//
// In a later iteration this could be replaced by loading an actual GTFS
// shapes.txt file for a real route without changing anything downstream of
// this module (simulator.js only needs an ordered list of {lat, lon} points
// and each stop's scheduled offset in minutes from route start).

const ROUTE_888 = {
  routeId: 'route-888',
  routeName: 'Cranbourne Station to Dandenong Station',
  // Scheduled minutes-from-start at each stop, used later for delay
  // prediction (compare live ETA against this timetable).
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
};

/** Haversine distance between two {lat, lon} points, in kilometres. */
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

/**
 * Pre-compute cumulative distance (km) at each waypoint, so we can later
 * place a vehicle at any distance-along-route by finding which segment it
 * falls in and interpolating.
 */
function buildCumulativeDistances(waypoints) {
  const cumulative = [0];
  for (let i = 1; i < waypoints.length; i++) {
    cumulative.push(cumulative[i - 1] + haversineKm(waypoints[i - 1], waypoints[i]));
  }
  return cumulative;
}

/**
 * Given a distance travelled along the route (km, clamped to route length),
 * return the interpolated {lat, lon} and which stop is "next".
 */
function positionAtDistance(waypoints, cumulative, distanceKm) {
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

  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    nextStop: b,
    distanceToNextStopKm: Number((segEnd - d).toFixed(3)),
    totalRouteKm: Number(totalKm.toFixed(3)),
  };
}

module.exports = { ROUTE_888, haversineKm, buildCumulativeDistances, positionAtDistance };
