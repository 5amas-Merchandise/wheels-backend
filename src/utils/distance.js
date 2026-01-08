// Haversine distance utility — returns meters and approximate duration
function toRadians(deg) {
  return deg * (Math.PI / 180);
}

function haversineDistanceMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6371000; // Earth radius in meters
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// returns { distanceKm, distanceMeters, approxDurationMinutes }
function estimateTrip(fromPoint, toPoint, options = {}) {
  // fromPoint and toPoint are GeoJSON coordinates arrays: [lng, lat]
  const meters = haversineDistanceMeters(fromPoint, toPoint);
  const distanceKm = meters / 1000;
  // approximate duration: default avg speed 40 km/h (modify via options.avgKmph)
  const avgKmph = options.avgKmph || 40;
  const hours = distanceKm / avgKmph;
  const approxDurationMinutes = Math.max(1, Math.round(hours * 60));
  return { distanceKm, distanceMeters: Math.round(meters), approxDurationMinutes };
}

module.exports = { estimateTrip, haversineDistanceMeters };
