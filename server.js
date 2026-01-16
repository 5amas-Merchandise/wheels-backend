// server.js - UNIFIED VERSION
require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// ✅ Import your Express app with all routes
const app = require('./src/app'); // This is your existing app.js with all routes

const server = http.createServer(app);

// ────────────────────────────────────────────────
//  WebSocket + Room Management
// ────────────────────────────────────────────────

const wss = new WebSocket.Server({ server });

const connectedUsers = new Map();   // userId → ws
const rooms = new Map();            // roomName → Set<ws>

function joinRoom(ws, roomName) {
  if (!rooms.has(roomName)) rooms.set(roomName, new Set());
  rooms.get(roomName).add(ws);
}

function leaveAllRooms(ws) {
  for (const clients of rooms.values()) {
    clients.delete(ws);
  }
}

function sendToUser(userId, data) {
  const ws = connectedUsers.get(userId?.toString());
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomName, data, excludeWs = null) {
  const clients = rooms.get(roomName);
  if (!clients) return;

  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ────────────────────────────────────────────────
//  WebSocket Connection Handler
// ────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  ws.isAlive = true;

  // Heartbeat
  ws.on('pong', () => { ws.isAlive = true; });

  // Extract token from query string:  ws://.../?token=xyz
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication required: token missing' }));
    ws.close(1008, 'No token');
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-me');
    ws.userId = (payload.sub || payload.userId || payload._id)?.toString();
    ws.isDriver = !!payload.isDriver;

    if (!ws.userId) throw new Error('No valid userId in token');

    console.log(`🔗 Connected → user ${ws.userId} (${ws.isDriver ? 'driver' : 'passenger'})`);

    connectedUsers.set(ws.userId, ws);
    joinRoom(ws, `user:${ws.userId}`);

    if (ws.isDriver) {
      joinRoom(ws, 'drivers');
    }

    ws.send(JSON.stringify({
      type: 'connected',
      userId: ws.userId,
      isDriver: ws.isDriver,
      timestamp: new Date().toISOString()
    }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
    ws.close(1008, 'Invalid token');
    return;
  }

  // ─── Message handler ───────────────────────────────────────
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const { type, ...data } = msg;

    switch (type) {
      case 'driver:location': {
        if (!ws.isDriver) return;

        const { latitude, longitude, heading = 0 } = data;

        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
          return;
        }

        console.log(`📍 ${ws.userId} → [${latitude.toFixed(5)}, ${longitude.toFixed(5)}]`);

        broadcastToRoom('drivers', {
          type: 'driver:location',
          driverId: ws.userId,
          latitude,
          longitude,
          heading,
          timestamp: new Date().toISOString()
        });

        break;
      }

      case 'join:trip': {
        const { tripId } = data;
        if (!tripId) return;

        const room = `trip:${tripId}`;
        joinRoom(ws, room);

        ws.send(JSON.stringify({
          type: 'joined',
          room,
          timestamp: new Date().toISOString()
        }));

        console.log(`${ws.userId} joined ${room}`);
        break;
      }

      case 'driver:accept_trip': {
        if (!ws.isDriver) return;

        const { tripId, passengerId } = data;
        if (!tripId || !passengerId) return;

        const room = `trip:${tripId}`;

        joinRoom(ws, room);

        sendToUser(passengerId, {
          type: 'trip:accepted',
          tripId,
          driverId: ws.userId,
          message: 'Driver accepted your ride!',
          timestamp: new Date().toISOString()
        });

        const pWs = connectedUsers.get(passengerId.toString());
        if (pWs) joinRoom(pWs, room);

        broadcastToRoom(room, {
          type: 'trip:status',
          status: 'accepted',
          driverId: ws.userId,
          tripId,
          timestamp: new Date().toISOString()
        }, ws);

        break;
      }

      default:
        console.log(`Unhandled message type: ${type}`);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`Disconnected → ${ws.userId || 'unknown'}`);
    connectedUsers.delete(ws.userId);
    leaveAllRooms(ws);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for user ${ws.userId}:`, error);
  });
});

// Heartbeat — clean dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ────────────────────────────────────────────────
//  MongoDB connection
// ────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGO_URI;

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// ────────────────────────────────────────────────
//  Start server
// ────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════╗
  ║   Ride-hailing Server Running              ║
  ║                                            ║
  ║   HTTP:  http://localhost:${PORT}           ║
  ║   WS:    ws://localhost:${PORT}             ║
  ║                                            ║
  ║   Connect with ?token=your-jwt-token       ║
  ╚════════════════════════════════════════════╝
  `);
  
  console.log('✅ Express routes loaded from app.js');
  console.log('✅ WebSocket server ready');
});

// ────────────────────────────────────────────────
//  Error Handling
// ────────────────────────────────────────────────

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server...');
  wss.close(() => {
    server.close(() => {
      mongoose.connection.close(false, () => {
        console.log('Server closed.');
        process.exit(0);
      });
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Closing server...');
  wss.close(() => {
    server.close(() => {
      mongoose.connection.close(false, () => {
        console.log('Server closed.');
        process.exit(0);
      });
    });
  });
});