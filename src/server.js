const http = require('http');
const app = require('./app');
const config = require('./config');
const db = require('./db/mongoose');

async function start() {
  try {
    await db.connect();
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  }

  const port = config.port;
  const server = http.createServer(app);
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down');
    server.close(() => process.exit(0));
  });
}

start();
