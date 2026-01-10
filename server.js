// server.js - Production-ready with Socket.IO (REAL DATA ONLY)
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const app = require('./src/app');
const config = require('./src/config');
const db = require('./src/db/mongoose');

async function startServer() {
  try {
    await db.connect();
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB', err);
    process.exit(1);
  }

  const port = config.port || 3000;
  const server = http.createServer(app);

  // ============================================
  // Socket.IO Setup - UPDATED CORS CONFIGURATION
  // ============================================
  const io = socketIO(server, {
    cors: {
      origin: "*", // Allow ALL origins for development
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Store connected users: { userId: socketId }
  const connectedUsers = new Map();

  // Socket.IO Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      console.log('❌ Socket connection rejected: No token');
      return next(new Error('Authentication error: No token provided'));
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret);
      socket.userId = payload.userId || payload.sub || payload._id;
      socket.userRoles = payload.roles || {};
      console.log(`🔐 Socket authenticated for user: ${socket.userId}`);
      next();
    } catch (err) {
      console.log('❌ Socket auth failed:', err.message);
      next(new Error('Authentication error: Invalid token'));
    }
  });

  // Socket.IO Connection Handler
  io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`✅ User connected: ${userId} (Socket: ${socket.id})`);

    // Store connection
    connectedUsers.set(userId, socket.id);

    // Join user-specific room
    socket.join(`user:${userId}`);

    // If driver, join driver room
    if (socket.userRoles?.isDriver) {
      socket.join('drivers');
      console.log(`🚗 Driver ${userId} joined drivers room`);
    }

    // If admin, join admin room
    if (socket.userRoles?.isAdmin) {
      socket.join('admins');
      console.log(`👑 Admin ${userId} joined admins room`);
    }

    // Handle driver location updates (REAL-TIME TRACKING)
    socket.on('driver:location', async (data) => {
      try {
        const { latitude, longitude, heading } = data;
        
        if (!latitude || !longitude) {
          console.log('⚠️ Invalid location data from driver:', userId);
          return;
        }

        // Validate latitude and longitude ranges
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
          console.log('⚠️ Location out of range from driver:', userId);
          return;
        }

        const User = require('./src/models/user.model');
        
        // Update driver location in database
        await User.findByIdAndUpdate(userId, {
          'driverProfile.location': {
            type: 'Point',
            coordinates: [longitude, latitude]
          },
          'driverProfile.heading': heading || 0,
          'driverProfile.lastSeen': new Date()
        });

        console.log(`📍 Driver ${userId} location updated: [${latitude}, ${longitude}]`);
        
        // Broadcast location to relevant passengers if driver is on trip
        const trip = await require('./src/models/trip.model').findOne({
          driverId: userId,
          status: { $in: ['started', 'in_progress'] }
        });

        if (trip) {
          // Send real-time location update to passenger
          io.to(`user:${trip.passengerId}`).emit('trip:driver_location', {
            tripId: trip._id,
            driverLocation: { latitude, longitude, heading },
            timestamp: new Date()
          });
        }

      } catch (err) {
        console.error('❌ Location update error:', err.message);
      }
    });

    // Handle real-time trip request from passenger
    socket.on('passenger:request_trip', async (data) => {
      try {
        const { requestId } = data;
        
        if (!requestId) {
          socket.emit('error', { message: 'Request ID required' });
          return;
        }

        const TripRequest = require('./src/models/tripRequest.model');
        const tripRequest = await TripRequest.findById(requestId)
          .populate('passengerId', 'name phone')
          .lean();

        if (!tripRequest) {
          socket.emit('error', { message: 'Trip request not found' });
          return;
        }

        // Verify user is the passenger
        if (tripRequest.passengerId._id.toString() !== userId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        // Emit real-time update about trip request to the passenger
        socket.emit('trip:request_update', {
          requestId,
          status: tripRequest.status,
          assignedDriverId: tripRequest.assignedDriverId,
          candidates: tripRequest.candidates
        });

        // If assigned to driver, notify driver in real-time
        if (tripRequest.assignedDriverId) {
          io.to(`user:${tripRequest.assignedDriverId}`).emit('trip:assigned', {
            requestId: tripRequest._id,
            passenger: tripRequest.passengerId,
            pickup: tripRequest.pickup,
            serviceType: tripRequest.serviceType,
            timestamp: new Date()
          });
        }

      } catch (err) {
        console.error('❌ Trip request status error:', err.message);
        socket.emit('error', { message: 'Failed to fetch trip request' });
      }
    });

    // Handle trip updates from driver (REAL-TIME TRIP UPDATES)
    socket.on('trip:update', async (data) => {
      try {
        const { tripId, status, location, distanceKm, durationMinutes } = data;
        
        if (!tripId) {
          socket.emit('error', { message: 'Trip ID required' });
          return;
        }

        const Trip = require('./src/models/trip.model');
        const trip = await Trip.findById(tripId);
        
        if (!trip) {
          socket.emit('error', { message: 'Trip not found' });
          return;
        }

        // Verify driver owns this trip
        if (trip.driverId.toString() !== userId) {
          socket.emit('error', { message: 'Unauthorized' });
          return;
        }

        console.log(`🚗 Trip update from driver ${userId}:`, { tripId, status });

        // Update trip status
        if (status && ['started', 'in_progress', 'completed'].includes(status)) {
          trip.status = status;
          
          if (status === 'started') {
            trip.startedAt = new Date();
          } else if (status === 'completed') {
            trip.completedAt = new Date();
          }
        }

        if (distanceKm !== undefined) trip.distanceKm = distanceKm;
        if (durationMinutes !== undefined) trip.durationMinutes = durationMinutes;
        
        await trip.save();

        // Broadcast to passenger in real-time
        io.to(`user:${trip.passengerId}`).emit('trip:driver_update', {
          tripId,
          status: trip.status,
          driverLocation: location,
          distanceKm,
          durationMinutes,
          timestamp: new Date()
        });

      } catch (err) {
        console.error('❌ Trip update error:', err.message);
        socket.emit('error', { message: 'Failed to update trip' });
      }
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`❌ User disconnected: ${userId} (Reason: ${reason})`);
      connectedUsers.delete(userId);
      
      // Mark driver as unavailable if they disconnect
      if (socket.userRoles?.isDriver) {
        const User = require('./src/models/user.model');
        User.findByIdAndUpdate(userId, {
          'driverProfile.isAvailable': false,
          'driverProfile.lastSeen': new Date()
        }).catch(err => console.error('Failed to update driver status:', err));
      }
    });

    // Acknowledge connection
    socket.emit('connected', {
      userId,
      socketId: socket.id,
      timestamp: new Date()
    });
  });

  // ============================================
  // Connect Event Emitter to Socket.IO (REAL DATA FLOW)
  // ============================================
  const emitter = require('./src/utils/eventEmitter');

  // Listen to REAL app events and broadcast via Socket.IO
  emitter.on('notification', (data) => {
    const { userId, type, title, body, data: metadata } = data;
    
    if (!userId) {
      console.log('⚠️ Notification without userId:', { type, title });
      return;
    }

    console.log(`📢 Sending REAL notification to user ${userId}:`, { type, title });
    
    // Send to specific user room
    io.to(`user:${userId}`).emit('notification', {
      type,
      title,
      body,
      data: metadata,
      timestamp: new Date()
    });

    // Special handling for REAL trip offers to drivers
    if (type === 'trip_offered') {
      console.log(`🚗 Sending REAL trip offer to driver ${userId}:`, metadata);
      io.to(`user:${userId}`).emit('trip:offered', {
        requestId: metadata?.requestId,
        serviceType: metadata?.serviceType,
        title,
        body,
        timestamp: new Date()
      });
    }

    // REAL trip accepted notification
    if (type === 'trip_accepted') {
      io.to(`user:${userId}`).emit('trip:accepted', {
        requestId: metadata?.requestId,
        tripId: metadata?.tripId,
        driverId: metadata?.driverId,
        title,
        body,
        timestamp: new Date()
      });
    }

    // REAL trip started notification
    if (type === 'trip_started') {
      io.to(`user:${userId}`).emit('trip:started', {
        tripId: metadata?.tripId,
        title,
        body,
        timestamp: new Date()
      });
    }

    // REAL trip cancelled notification
    if (type === 'trip_cancelled') {
      io.to(`user:${userId}`).emit('trip:cancelled', {
        tripId: metadata?.tripId,
        reason: body,
        timestamp: new Date()
      });
    }

    // REAL trip completed notification
    if (type === 'trip_completed') {
      io.to(`user:${userId}`).emit('trip:completed', {
        tripId: metadata?.tripId,
        title,
        body,
        timestamp: new Date()
      });
    }

    // REAL no driver found notification
    if (type === 'no_driver_found') {
      io.to(`user:${userId}`).emit('trip:no_drivers', {
        requestId: metadata?.requestId,
        title,
        body,
        timestamp: new Date()
      });
    }
  });

  // Broadcast to all drivers (REAL announcements from admin)
  emitter.on('broadcast:drivers', (data) => {
    console.log('📢 Broadcasting to all drivers:', data);
    io.to('drivers').emit('broadcast', {
      ...data,
      timestamp: new Date()
    });
  });

  // Broadcast to all admins (REAL system alerts)
  emitter.on('broadcast:admins', (data) => {
    console.log('📢 Broadcasting to all admins:', data);
    io.to('admins').emit('broadcast', {
      ...data,
      timestamp: new Date()
    });
  });

  // Make io globally accessible for direct use in routes if needed
  global.io = io;
  app.set('io', io);

  // ============================================
  // Start Server
  // ============================================
  server.listen(port, () => {
    console.log(`🚀 Server listening on http://localhost:${port}`);
    console.log(`🔌 Socket.IO ready for REAL-TIME connections`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n⏳ Shutting down gracefully...');
    // Close all socket connections
    io.close(() => {
      console.log('🔌 Socket.IO connections closed');
    });
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.log('\n⏳ SIGTERM received, shutting down...');
    io.close();
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

startServer();