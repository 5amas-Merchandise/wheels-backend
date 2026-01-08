// server.js  ← Only runs locally (node server.js)
const http = require('http');
const app = require('./src/app');  // Adjust path if src is nested differently
const config = require('./src/config');
const db = require('./src/db/mongoose');

async function startServer() {
  try {
    await db.connect();
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  }

  const port = config.port || 3000;
  const server = http.createServer(app);

  server.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
}

startServer();