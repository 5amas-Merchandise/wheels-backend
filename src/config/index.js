const dotenv = require('dotenv');
dotenv.config();

// Enforce required env vars in production
const requiredEnvVars = ['MONGO_URI', 'JWT_SECRET'];
if (process.env.NODE_ENV === 'production') {
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 8000,
  // prefer explicit env var; default to IPv4 localhost to avoid IPv6 (::1) resolution issues
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  platformCommissionPercent: process.env.PLATFORM_COMMISSION_PERCENT ? Number(process.env.PLATFORM_COMMISSION_PERCENT) : 10,
  // Map provider settings (frontend can use MapLibre/Leaflet with these)
  mapProvider: process.env.MAP_PROVIDER || 'openstreetmap',
  // Default OSM tile URL (sublibrary like MapLibre or Leaflet can consume this)
  mapTileUrl: process.env.MAP_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  // Security config
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['http://localhost:3000', 'http://localhost:3001'],
  trustProxy: process.env.TRUST_PROXY === 'true',
  secureCookies: process.env.NODE_ENV === 'production'
};
