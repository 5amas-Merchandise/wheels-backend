const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken'); // Added JWT
const { requireAuth } = require('../middleware/auth');
const IntercityCompany = require('../models/intercityCompany.model');
const IntercityRoute = require('../models/intercityRoute.model'); // Fixed import
const IntercitySchedule = require('../models/intercitySchedule.model'); // Fixed import
const IntercityBooking = require('../models/intercityBooking.model'); // Fixed import
const User = require('../models/user.model');
const emitter = require('../utils/eventEmitter');

// ==========================================
// NIGERIA STATES CONSTANT
// ==========================================
const NIGERIA_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa',
  'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo',
  'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa',
  'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
  'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun',
  'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'
];

// ==========================================
// GET /intercity/states - GET ALL STATES
// ==========================================
router.get('/states', (req, res) => {
  res.json({
    success: true,
    states: NIGERIA_STATES
  });
});

// ==========================================
// COMPANY REGISTRATION & MANAGEMENT
// ==========================================

// POST /intercity/company/register - REGISTER TRANSPORT COMPANY (WITH USER CREATION)
router.post('/company/register', async (req, res, next) => {
  try {
    const {
      companyName,
      rcNumber,
      contactEmail,
      contactPhone,
      address,
      companyLogo,
      // User details for account creation
      ownerName,
      ownerEmail,
      ownerPhone,
      ownerPassword
    } = req.body;

    console.log(`🚌 Registering intercity company: ${companyName}`);

    // Validate required fields
    if (!companyName || !rcNumber || !contactEmail || !contactPhone || !ownerEmail || !ownerPassword || !ownerName) {
      return res.status(400).json({
        success: false,
        error: { message: 'Missing required fields' }
      });
    }

    // Check if RC number is already used
    const existingRC = await IntercityCompany.findOne({ rcNumber });
    if (existingRC) {
      return res.status(400).json({
        success: false,
        error: { message: 'RC number already registered' }
      });
    }

    // Check if owner email is already used
    const existingUser = await User.findOne({ email: ownerEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: { message: 'Email already registered. Please login instead.' }
      });
    }

    // Create user account for company owner
    const user = await User.create({
      email: ownerEmail,
      password: ownerPassword,
      name: ownerName,
      phone: ownerPhone || contactPhone,
      roles: {
        isTransportCompany: true,
        isDriver: false,
        isPassenger: false,
        isAdmin: false
      },
      profile: {
        companyName: companyName,
        companyRcNumber: rcNumber
      }
    });

    console.log(`✅ User account created for company owner: ${user._id}`);

    // Create company
    const company = await IntercityCompany.create({
      userId: user._id,
      companyName,
      rcNumber,
      contactEmail,
      contactPhone,
      address,
      companyLogo,
      verified: false,
      verificationStatus: 'pending'
    });

    console.log(`✅ Company ${company._id} registered successfully`);

    // Generate JWT token for immediate login
    const token = jwt.sign(
      {
        sub: user._id.toString(),
        email: user.email,
        roles: user.roles
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      company: {
        id: company._id,
        companyName: company.companyName,
        verificationStatus: company.verificationStatus,
        isActive: company.isActive
      },
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        roles: user.roles
      },
      token,
      message: 'Company registered successfully. Awaiting verification.'
    });

  } catch (err) {
    console.error('❌ Company registration error:', err);
    
    // Handle duplicate email error
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        error: { message: 'Email already registered' }
      });
    }

    // Handle validation errors
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(val => val.message);
      return res.status(400).json({
        success: false,
        error: { message: messages.join(', ') }
      });
    }

    next(err);
  }
});

// POST /intercity/company/login - LOGIN COMPANY OWNER
router.post('/company/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: { message: 'Email and password are required' }
      });
    }

    // Find user
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid credentials' }
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid credentials' }
      });
    }

    // Check if user is a transport company
    if (!user.roles.isTransportCompany) {
      return res.status(403).json({
        success: false,
        error: { message: 'Access denied. Transport company account required.' }
      });
    }

    // Find company
    const company = await IntercityCompany.findOne({ userId: user._id });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    // Generate token
    const token = jwt.sign(
      {
        sub: user._id.toString(),
        email: user.email,
        roles: user.roles
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        roles: user.roles
      },
      company: {
        id: company._id,
        companyName: company.companyName,
        verificationStatus: company.verificationStatus,
        isActive: company.isActive
      }
    });

  } catch (err) {
    console.error('❌ Company login error:', err);
    next(err);
  }
});

// GET /intercity/company/profile - GET COMPANY PROFILE
router.get('/company/profile', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const company = await IntercityCompany.findOne({ userId })
      .select('-__v')
      .lean();

    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    res.json({
      success: true,
      company
    });

  } catch (err) {
    console.error('❌ Get company profile error:', err);
    next(err);
  }
});

// PUT /intercity/company/profile - UPDATE COMPANY PROFILE
router.put('/company/profile', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const updates = req.body;

    // Don't allow updating verification status or userId
    delete updates.verified;
    delete updates.verificationStatus;
    delete updates.userId;
    delete updates.rcNumber; // RC number shouldn't be changed

    const company = await IntercityCompany.findOneAndUpdate(
      { userId },
      { $set: updates },
      { new: true }
    );

    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    res.json({
      success: true,
      company,
      message: 'Company profile updated successfully'
    });

  } catch (err) {
    console.error('❌ Update company profile error:', err);
    next(err);
  }
});

// ==========================================
// ROUTE MANAGEMENT (COMPANY)
// ==========================================

// POST /intercity/routes - CREATE NEW ROUTE
router.post('/routes', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const {
      routeName,
      departureState,
      departureCity,
      arrivalState,
      arrivalCity,
      estimatedDuration,
      estimatedDistance,
      basePrice,
      vehicleType,
      amenities
    } = req.body;

    // Find company
    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found. Please register first.' }
      });
    }

    if (!company.verified || company.verificationStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        error: { message: 'Company must be verified to create routes' }
      });
    }

    // Validate states
    if (!NIGERIA_STATES.includes(departureState) || !NIGERIA_STATES.includes(arrivalState)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Invalid state selected' }
      });
    }

    // Create route
    const route = await IntercityRoute.create({
      companyId: company._id,
      routeName,
      departureState,
      departureCity,
      arrivalState,
      arrivalCity,
      estimatedDuration,
      estimatedDistance,
      basePrice,
      vehicleType,
      amenities: amenities || []
    });

    console.log(`✅ Route ${route._id} created by company ${company._id}`);

    res.status(201).json({
      success: true,
      route,
      message: 'Route created successfully'
    });

  } catch (err) {
    console.error('❌ Create route error:', err);
    next(err);
  }
});

// GET /intercity/routes/my-routes - GET COMPANY'S ROUTES
router.get('/routes/my-routes', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const routes = await IntercityRoute.find({ companyId: company._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      routes,
      total: routes.length
    });

  } catch (err) {
    console.error('❌ Get routes error:', err);
    next(err);
  }
});

// PUT /intercity/routes/:routeId - UPDATE ROUTE
router.put('/routes/:routeId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { routeId } = req.params;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const route = await IntercityRoute.findOne({
      _id: routeId,
      companyId: company._id
    });

    if (!route) {
      return res.status(404).json({
        success: false,
        error: { message: 'Route not found' }
      });
    }

    const updates = req.body;
    delete updates.companyId; // Prevent changing company

    Object.assign(route, updates);
    await route.save();

    res.json({
      success: true,
      route,
      message: 'Route updated successfully'
    });

  } catch (err) {
    console.error('❌ Update route error:', err);
    next(err);
  }
});

// DELETE /intercity/routes/:routeId - DELETE ROUTE
router.delete('/routes/:routeId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { routeId } = req.params;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    // Check for active schedules
    const activeSchedules = await IntercitySchedule.countDocuments({
      routeId,
      status: { $in: ['scheduled', 'boarding'] }
    });

    if (activeSchedules > 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Cannot delete route with active schedules' }
      });
    }

    await IntercityRoute.findOneAndDelete({
      _id: routeId,
      companyId: company._id
    });

    res.json({
      success: true,
      message: 'Route deleted successfully'
    });

  } catch (err) {
    console.error('❌ Delete route error:', err);
    next(err);
  }
});

// ==========================================
// SCHEDULE MANAGEMENT (COMPANY)
// ==========================================

// POST /intercity/schedules - CREATE SCHEDULE
router.post('/schedules', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const {
      routeId,
      departureDate,
      departureTime,
      arrivalTime,
      totalSeats,
      pricePerSeat,
      vehicleNumber
    } = req.body;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const route = await IntercityRoute.findOne({
      _id: routeId,
      companyId: company._id,
      isActive: true
    });

    if (!route) {
      return res.status(404).json({
        success: false,
        error: { message: 'Route not found or inactive' }
      });
    }

    // Validate date is in future
    const scheduleDate = new Date(departureDate);
    if (scheduleDate < new Date()) {
      return res.status(400).json({
        success: false,
        error: { message: 'Departure date must be in the future' }
      });
    }

    const schedule = await IntercitySchedule.create({
      routeId,
      companyId: company._id,
      departureDate: scheduleDate,
      departureTime,
      arrivalTime,
      totalSeats,
      availableSeats: totalSeats,
      bookedSeats: 0,
      pricePerSeat,
      vehicleNumber,
      status: 'scheduled'
    });

    console.log(`✅ Schedule ${schedule._id} created for route ${routeId}`);

    res.status(201).json({
      success: true,
      schedule,
      message: 'Schedule created successfully'
    });

  } catch (err) {
    console.error('❌ Create schedule error:', err);
    next(err);
  }
});

// GET /intercity/schedules/my-schedules - GET COMPANY SCHEDULES
router.get('/schedules/my-schedules', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { status, startDate, endDate } = req.query;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const filter = { companyId: company._id };
    
    if (status) {
      filter.status = status;
    }

    if (startDate || endDate) {
      filter.departureDate = {};
      if (startDate) filter.departureDate.$gte = new Date(startDate);
      if (endDate) filter.departureDate.$lte = new Date(endDate);
    }

    const schedules = await IntercitySchedule.find(filter)
      .populate('routeId')
      .sort({ departureDate: 1, departureTime: 1 })
      .lean();

    res.json({
      success: true,
      schedules,
      total: schedules.length
    });

  } catch (err) {
    console.error('❌ Get schedules error:', err);
    next(err);
  }
});

// PUT /intercity/schedules/:scheduleId - UPDATE SCHEDULE
router.put('/schedules/:scheduleId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { scheduleId } = req.params;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const schedule = await IntercitySchedule.findOne({
      _id: scheduleId,
      companyId: company._id
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        error: { message: 'Schedule not found' }
      });
    }

    // Don't allow updates if trip has departed
    if (schedule.status === 'departed' || schedule.status === 'arrived') {
      return res.status(400).json({
        success: false,
        error: { message: 'Cannot update schedule after departure' }
      });
    }

    const updates = req.body;
    delete updates.companyId;
    delete updates.routeId;
    delete updates.bookedSeats; // Prevent manual booking modification

    Object.assign(schedule, updates);
    await schedule.save();

    res.json({
      success: true,
      schedule,
      message: 'Schedule updated successfully'
    });

  } catch (err) {
    console.error('❌ Update schedule error:', err);
    next(err);
  }
});

// DELETE /intercity/schedules/:scheduleId - CANCEL SCHEDULE
router.delete('/schedules/:scheduleId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { scheduleId } = req.params;
    const { reason } = req.body;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const schedule = await IntercitySchedule.findOne({
      _id: scheduleId,
      companyId: company._id
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        error: { message: 'Schedule not found' }
      });
    }

    // Cancel all bookings for this schedule
    const bookings = await IntercityBooking.find({
      scheduleId,
      status: { $in: ['pending', 'confirmed'] }
    });

    for (const booking of bookings) {
      booking.status = 'cancelled';
      booking.cancellationDate = new Date();
      booking.cancellationReason = reason || 'Schedule cancelled by company';
      await booking.save();

      // Notify passenger
      try {
        emitter.emit('notification', {
          userId: booking.userId.toString(),
          type: 'booking_cancelled',
          title: 'Trip Cancelled',
          body: `Your booking ${booking.bookingReference} has been cancelled`,
          data: {
            bookingId: booking._id,
            reason: booking.cancellationReason
          }
        });
      } catch (emitErr) {
        console.error('Notification error:', emitErr);
      }
    }

    schedule.status = 'cancelled';
    schedule.cancellationReason = reason;
    await schedule.save();

    res.json({
      success: true,
      message: 'Schedule cancelled successfully',
      cancelledBookings: bookings.length
    });

  } catch (err) {
    console.error('❌ Cancel schedule error:', err);
    next(err);
  }
});

// ==========================================
// PASSENGER BOOKING
// ==========================================

// GET /intercity/search - SEARCH AVAILABLE TRIPS
router.get('/search', async (req, res, next) => {
  try {
    const { departureState, arrivalState, date } = req.query;

    console.log(`🔍 Searching trips: ${departureState} → ${arrivalState} on ${date}`);

    if (!departureState || !arrivalState) {
      return res.status(400).json({
        success: false,
        error: { message: 'Departure and arrival states are required' }
      });
    }

    // Find active routes
    const routes = await IntercityRoute.find({
      departureState,
      arrivalState,
      isActive: true
    }).populate('companyId').lean();

    if (routes.length === 0) {
      return res.json({
        success: true,
        trips: [],
        message: 'No routes available for this journey'
      });
    }

    const routeIds = routes.map(r => r._id);

    // Build schedule filter
    const scheduleFilter = {
      routeId: { $in: routeIds },
      status: 'scheduled',
      availableSeats: { $gt: 0 }
    };

    if (date) {
      const searchDate = new Date(date);
      const nextDay = new Date(searchDate);
      nextDay.setDate(nextDay.getDate() + 1);
      
      scheduleFilter.departureDate = {
        $gte: searchDate,
        $lt: nextDay
      };
    } else {
      scheduleFilter.departureDate = { $gte: new Date() };
    }

    const schedules = await IntercitySchedule.find(scheduleFilter)
      .populate('routeId')
      .populate('companyId')
      .sort({ departureDate: 1, departureTime: 1 })
      .lean();

    const trips = schedules.map(schedule => ({
      scheduleId: schedule._id,
      company: {
        id: schedule.companyId._id,
        name: schedule.companyId.companyName,
        logo: schedule.companyId.companyLogo,
        rating: schedule.companyId.rating,
        totalReviews: schedule.companyId.totalReviews
      },
      route: {
        from: `${schedule.routeId.departureCity}, ${schedule.routeId.departureState}`,
        to: `${schedule.routeId.arrivalCity}, ${schedule.routeId.arrivalState}`,
        duration: schedule.routeId.estimatedDuration,
        distance: schedule.routeId.estimatedDistance
      },
      departure: {
        date: schedule.departureDate,
        time: schedule.departureTime
      },
      arrival: {
        time: schedule.arrivalTime
      },
      pricing: {
        pricePerSeat: schedule.pricePerSeat,
        priceInNaira: (schedule.pricePerSeat / 100).toFixed(2)
      },
      availability: {
        totalSeats: schedule.totalSeats,
        availableSeats: schedule.availableSeats,
        bookedSeats: schedule.bookedSeats
      },
      vehicle: {
        type: schedule.routeId.vehicleType,
        number: schedule.vehicleNumber,
        amenities: schedule.routeId.amenities
      }
    }));

    res.json({
      success: true,
      trips,
      total: trips.length
    });

  } catch (err) {
    console.error('❌ Search error:', err);
    next(err);
  }
});

// POST /intercity/bookings - CREATE BOOKING (WITH DETAILED LOGGING)
router.post('/bookings', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();
  
  try {
    console.log('🚀 === BOOKING REQUEST STARTED ===');
    console.log('📥 Request body:', JSON.stringify(req.body, null, 2));
    console.log('👤 User ID:', req.user.sub);

    await session.withTransaction(async () => {
      const userId = req.user.sub;
      const {
        scheduleId,
        passengerDetails,
        numberOfSeats,
        seatNumbers,
        specialRequests
      } = req.body;

      // Validate required fields
      if (!scheduleId) {
        throw new Error('Schedule ID is required');
      }
      if (!passengerDetails) {
        throw new Error('Passenger details are required');
      }
      if (!numberOfSeats || numberOfSeats < 1) {
        throw new Error('Number of seats must be at least 1');
      }

      console.log('✅ Step 1: Validation passed');
      console.log('📝 Creating booking for user:', userId);
      console.log('📝 Schedule ID:', scheduleId);

      // Get schedule WITHOUT populate (populate doesn't work well in transactions)
      console.log('🔍 Step 2: Fetching schedule...');
      const schedule = await IntercitySchedule.findById(scheduleId).session(session);

      if (!schedule) {
        console.error('❌ Schedule not found:', scheduleId);
        throw new Error('Schedule not found');
      }

      console.log('✅ Step 2: Schedule found');
      console.log('📊 Schedule details:', {
        id: schedule._id,
        status: schedule.status,
        totalSeats: schedule.totalSeats,
        availableSeats: schedule.availableSeats,
        bookedSeats: schedule.bookedSeats,
        pricePerSeat: schedule.pricePerSeat,
        routeId: schedule.routeId,
        companyId: schedule.companyId
      });

      if (schedule.status !== 'scheduled') {
        console.error('❌ Schedule not available, status:', schedule.status);
        throw new Error('Schedule is not available for booking');
      }

      if (schedule.availableSeats < numberOfSeats) {
        console.error('❌ Not enough seats:', {
          requested: numberOfSeats,
          available: schedule.availableSeats
        });
        throw new Error(`Only ${schedule.availableSeats} seats available`);
      }

      console.log('✅ Step 3: Availability check passed');

      // Calculate total (pricePerSeat should already be in kobo)
      const totalAmount = schedule.pricePerSeat * numberOfSeats;
      console.log('💰 Total amount calculated:', {
        pricePerSeat: schedule.pricePerSeat,
        numberOfSeats,
        totalAmount
      });

      // Create booking - use ObjectIds directly, not populated objects
      console.log('🔍 Step 4: Creating booking document...');
      const bookingDoc = {
        userId: userId,
        scheduleId: schedule._id,
        routeId: schedule.routeId, // This is already an ObjectId
        companyId: schedule.companyId, // This is already an ObjectId
        passengerDetails: passengerDetails,
        numberOfSeats: numberOfSeats,
        seatNumbers: seatNumbers || [],
        totalAmount: totalAmount,
        status: 'confirmed',
        specialRequests: specialRequests || null
      };

      console.log('📄 Booking document to create:', JSON.stringify(bookingDoc, null, 2));

      const booking = await IntercityBooking.create([bookingDoc], { session });
      const newBooking = booking[0];

      console.log('✅ Step 4: Booking created:', newBooking._id);
      console.log('📋 Booking reference:', newBooking.bookingReference);

      // Update schedule
      console.log('🔍 Step 5: Updating schedule seats...');
      schedule.bookedSeats += numberOfSeats;
      schedule.availableSeats -= numberOfSeats;
      await schedule.save({ session });

      console.log('✅ Step 5: Schedule updated:', {
        newBookedSeats: schedule.bookedSeats,
        newAvailableSeats: schedule.availableSeats
      });

      // Update company stats
      console.log('🔍 Step 6: Updating company stats...');
      await IntercityCompany.findByIdAndUpdate(
        schedule.companyId,
        { $inc: { totalBookings: 1 } },
        { session }
      );

      console.log('✅ Step 6: Company stats updated');

      // Transaction completed successfully
      console.log('✅ Step 7: Transaction completed successfully');

      // Fetch populated data AFTER transaction for response
      console.log('🔍 Step 8: Fetching populated schedule for response...');
      const populatedSchedule = await IntercitySchedule.findById(schedule._id)
        .populate('routeId')
        .populate('companyId')
        .lean();

      console.log('✅ Step 8: Populated schedule fetched');

      const responseData = {
        success: true,
        booking: {
          id: newBooking._id,
          bookingReference: newBooking.bookingReference,
          status: newBooking.status,
          numberOfSeats: newBooking.numberOfSeats,
          totalAmount: newBooking.totalAmount,
          totalAmountInNaira: (newBooking.totalAmount / 100).toFixed(2),
          company: populatedSchedule.companyId.companyName,
          route: {
            from: `${populatedSchedule.routeId.departureCity}, ${populatedSchedule.routeId.departureState}`,
            to: `${populatedSchedule.routeId.arrivalCity}, ${populatedSchedule.routeId.arrivalState}`
          },
          departure: {
            date: populatedSchedule.departureDate,
            time: populatedSchedule.departureTime
          }
        },
        message: 'Booking confirmed successfully'
      };

      console.log('📤 Sending response:', JSON.stringify(responseData, null, 2));
      console.log('✅ === BOOKING REQUEST COMPLETED ===');

      res.status(201).json(responseData);

      // Send notification after transaction (non-blocking)
      setImmediate(() => {
        try {
          emitter.emit('notification', {
            userId: userId.toString(),
            type: 'booking_confirmed',
            title: 'Booking Confirmed',
            body: `Your booking ${newBooking.bookingReference} is confirmed`,
            data: {
              bookingId: newBooking._id,
              bookingReference: newBooking.bookingReference
            }
          });
        } catch (emitErr) {
          console.error('⚠️ Notification error (non-critical):', emitErr);
        }
      });
    });

  } catch (err) {
    console.error('❌ === BOOKING ERROR ===');
    console.error('Error name:', err.name);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    
    let statusCode = 500;
    let errorMessage = err.message || 'Failed to create booking';

    if (err.message.includes('not found')) {
      statusCode = 404;
    } else if (err.message.includes('not available') || err.message.includes('seats available') || err.message.includes('required')) {
      statusCode = 400;
    }

    const errorResponse = {
      success: false,
      error: { 
        message: errorMessage,
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }
    };

    console.error('📤 Sending error response:', errorResponse);
    res.status(statusCode).json(errorResponse);
  } finally {
    await session.endSession();
    console.log('🔒 Session ended');
  }
});

// GET /intercity/bookings - GET USER BOOKINGS
router.get('/bookings', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { status } = req.query;

    const filter = { userId };
    if (status) {
      filter.status = status;
    }

    const bookings = await IntercityBooking.find(filter)
      .populate({
        path: 'scheduleId',
        populate: { path: 'routeId' }
      })
      .populate('companyId')
      .sort({ createdAt: -1 })
      .lean();

    const formattedBookings = bookings.map(booking => ({
      id: booking._id,
      bookingReference: booking.bookingReference,
      status: booking.status,
      company: {
        name: booking.companyId?.companyName,
        logo: booking.companyId?.companyLogo
      },
      route: {
        from: `${booking.scheduleId?.routeId?.departureCity}, ${booking.scheduleId?.routeId?.departureState}`,
        to: `${booking.scheduleId?.routeId?.arrivalCity}, ${booking.scheduleId?.routeId?.arrivalState}`
      },
      departure: {
        date: booking.scheduleId?.departureDate,
        time: booking.scheduleId?.departureTime
      },
      passenger: booking.passengerDetails,
      numberOfSeats: booking.numberOfSeats,
      totalAmount: booking.totalAmount,
      totalAmountInNaira: (booking.totalAmount / 100).toFixed(2),
      bookingDate: booking.createdAt,
      cancellationDate: booking.cancellationDate,
      cancellationReason: booking.cancellationReason
    }));

    res.json({
      success: true,
      bookings: formattedBookings,
      total: formattedBookings.length
    });

  } catch (err) {
    console.error('❌ Get bookings error:', err);
    next(err);
  }
});

// GET /intercity/bookings/:bookingId - GET BOOKING DETAILS
router.get('/bookings/:bookingId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { bookingId } = req.params;

    const booking = await IntercityBooking.findOne({
      _id: bookingId,
      userId
    })
      .populate({
        path: 'scheduleId',
        populate: { path: 'routeId' }
      })
      .populate('companyId')
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { message: 'Booking not found' }
      });
    }

    res.json({
      success: true,
      booking: {
        id: booking._id,
        bookingReference: booking.bookingReference,
        status: booking.status,
        company: {
          name: booking.companyId.companyName,
          logo: booking.companyId.companyLogo,
          phone: booking.companyId.contactPhone,
          email: booking.companyId.contactEmail
        },
        route: {
          from: `${booking.scheduleId.routeId.departureCity}, ${booking.scheduleId.routeId.departureState}`,
          to: `${booking.scheduleId.routeId.arrivalCity}, ${booking.scheduleId.routeId.arrivalState}`,
          duration: booking.scheduleId.routeId.estimatedDuration,
          distance: booking.scheduleId.routeId.estimatedDistance
        },
        departure: {
          date: booking.scheduleId.departureDate,
          time: booking.scheduleId.departureTime
        },
        arrival: {
          time: booking.scheduleId.arrivalTime
        },
        vehicle: {
          type: booking.scheduleId.routeId.vehicleType,
          number: booking.scheduleId.vehicleNumber,
          amenities: booking.scheduleId.routeId.amenities
        },
        passenger: booking.passengerDetails,
        numberOfSeats: booking.numberOfSeats,
        seatNumbers: booking.seatNumbers,
        totalAmount: booking.totalAmount,
        totalAmountInNaira: (booking.totalAmount / 100).toFixed(2),
        specialRequests: booking.specialRequests,
        bookingDate: booking.createdAt,
        qrCode: booking.qrCode
      }
    });

  } catch (err) {
    console.error('❌ Get booking details error:', err);
    next(err);
  }
});

// POST /intercity/bookings/:bookingId/cancel - CANCEL BOOKING
router.post('/bookings/:bookingId/cancel', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      const userId = req.user.sub;
      const { bookingId } = req.params;
      const { reason } = req.body;

      const booking = await IntercityBooking.findOne({
        _id: bookingId,
        userId
      }).session(session);

      if (!booking) {
        throw new Error('Booking not found');
      }

      if (booking.status === 'cancelled') {
        throw new Error('Booking already cancelled');
      }

      if (booking.status === 'completed') {
        throw new Error('Cannot cancel completed trip');
      }

      // Update booking
      booking.status = 'cancelled';
      booking.cancellationDate = new Date();
      booking.cancellationReason = reason || 'Cancelled by passenger';
      await booking.save({ session });

      // Return seats to schedule
      const schedule = await IntercitySchedule.findById(booking.scheduleId).session(session);
      if (schedule) {
        schedule.bookedSeats -= booking.numberOfSeats;
        schedule.availableSeats += booking.numberOfSeats;
        await schedule.save({ session });
      }

      console.log(`✅ Booking ${booking.bookingReference} cancelled`);

      res.json({
        success: true,
        message: 'Booking cancelled successfully'
      });
    });

  } catch (err) {
    console.error('❌ Cancel booking error:', err);
    
    let statusCode = 500;
    if (err.message.includes('not found')) statusCode = 404;
    else if (err.message.includes('already') || err.message.includes('Cannot')) statusCode = 400;

    res.status(statusCode).json({
      success: false,
      error: { message: err.message }
    });
  } finally {
    await session.endSession();
  }
});

// ==========================================
// COMPANY BOOKING MANAGEMENT
// ==========================================

// GET /intercity/company/bookings - GET ALL BOOKINGS FOR COMPANY
router.get('/company/bookings', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { status, scheduleId, startDate, endDate } = req.query;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const filter = { companyId: company._id };
    
    if (status) filter.status = status;
    if (scheduleId) filter.scheduleId = scheduleId;
    
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const bookings = await IntercityBooking.find(filter)
      .populate('userId', 'name phone email')
      .populate({
        path: 'scheduleId',
        populate: { path: 'routeId' }
      })
      .sort({ createdAt: -1 })
      .lean();

    const formattedBookings = bookings.map(booking => ({
      id: booking._id,
      bookingReference: booking.bookingReference,
      status: booking.status,
      passenger: {
        ...booking.passengerDetails,
        userId: booking.userId?._id
      },
      route: {
        from: `${booking.scheduleId?.routeId?.departureCity}, ${booking.scheduleId?.routeId?.departureState}`,
        to: `${booking.scheduleId?.routeId?.arrivalCity}, ${booking.scheduleId?.routeId?.arrivalState}`
      },
      departure: {
        date: booking.scheduleId?.departureDate,
        time: booking.scheduleId?.departureTime
      },
      numberOfSeats: booking.numberOfSeats,
      seatNumbers: booking.seatNumbers,
      totalAmount: booking.totalAmount,
      totalAmountInNaira: (booking.totalAmount / 100).toFixed(2),
      bookingDate: booking.createdAt,
      checkedInAt: booking.checkedInAt
    }));

    res.json({
      success: true,
      bookings: formattedBookings,
      total: formattedBookings.length
    });

  } catch (err) {
    console.error('❌ Get company bookings error:', err);
    next(err);
  }
});

// POST /intercity/company/bookings/:bookingId/checkin - CHECK IN PASSENGER
router.post('/company/bookings/:bookingId/checkin', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { bookingId } = req.params;

    const company = await IntercityCompany.findOne({ userId });
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    const booking = await IntercityBooking.findOne({
      _id: bookingId,
      companyId: company._id
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { message: 'Booking not found' }
      });
    }

    if (booking.status !== 'confirmed') {
      return res.status(400).json({
        success: false,
        error: { message: `Cannot check in booking with status: ${booking.status}` }
      });
    }

    booking.status = 'checked_in';
    booking.checkedInAt = new Date();
    await booking.save();

    res.json({
      success: true,
      message: 'Passenger checked in successfully',
      booking: {
        bookingReference: booking.bookingReference,
        checkedInAt: booking.checkedInAt
      }
    });

  } catch (err) {
    console.error('❌ Check-in error:', err);
    next(err);
  }
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

const requireAdmin = (req, res, next) => {
  if (req.user?.roles?.isAdmin) {
    next();
  } else {
    res.status(403).json({ 
      success: false,
      error: { message: 'Admin access required' } 
    });
  }
};

// GET /intercity/admin/companies - GET ALL COMPANIES
router.get('/admin/companies', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { verificationStatus } = req.query;

    const filter = {};
    if (verificationStatus) {
      filter.verificationStatus = verificationStatus;
    }

    const companies = await IntercityCompany.find(filter)
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      companies,
      total: companies.length
    });

  } catch (err) {
    console.error('❌ Get companies error:', err);
    next(err);
  }
});

// PUT /intercity/admin/companies/:companyId/verify - VERIFY COMPANY
// PUT /intercity/companies/:companyId/verify - VERIFY COMPANY (NO AUTH REQUIRED)
router.put('/companies/:companyId/verify', async (req, res, next) => {
  try {
    const { companyId } = req.params;
    const { approved, reason } = req.body; // Added adminCode for basic security

    console.log(`🔐 Verification request for company ${companyId}: ${approved ? 'approve' : 'reject'}`);


    const company = await IntercityCompany.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    // Check if already verified/rejected
    if (company.verificationStatus === (approved ? 'approved' : 'rejected')) {
      return res.status(400).json({
        success: false,
        error: { 
          message: `Company already ${company.verificationStatus}` 
        }
      });
    }

    const oldStatus = company.verificationStatus;
    company.verificationStatus = approved ? 'approved' : 'rejected';
    company.verified = approved;
    
    // Update user role if approved
    if (approved) {
      const user = await User.findById(company.userId);
      if (user) {
        user.roles.isTransportCompany = true;
        if (user.transportCompanyProfile) {
          user.transportCompanyProfile.verified = true;
          user.transportCompanyProfile.verificationStatus = 'approved';
        }
        await user.save();
        console.log(`✅ Updated user ${user._id} with transport company role`);
      }
    }
    
    await company.save();

    console.log(`✅ Company ${company._id} verification status changed from ${oldStatus} to ${company.verificationStatus}`);

    // Notify company owner
    try {
      emitter.emit('notification', {
        userId: company.userId.toString(),
        type: 'company_verification',
        title: approved ? '🎉 Company Approved!' : '❌ Company Rejected',
        body: approved 
          ? `Congratulations! ${company.companyName} has been approved and is now active on Wheela.`
          : `Your company verification was rejected. Reason: ${reason || 'Please check your documents and try again.'}`,
        data: {
          companyId: company._id,
          companyName: company.companyName,
          status: company.verificationStatus,
          reason: reason || null
        }
      });
      
      // Also send email notification if you have email service
      if (approved) {
        emitter.emit('email', {
          to: company.contactEmail,
          subject: `🎉 ${company.companyName} - Verification Approved!`,
          template: 'company_approved',
          data: {
            companyName: company.companyName,
            loginLink: `${process.env.FRONTEND_URL}/company/login`
          }
        });
      }
    } catch (emitErr) {
      console.error('Notification error:', emitErr);
    }

    res.json({
      success: true,
      company: {
        id: company._id,
        companyName: company.companyName,
        verificationStatus: company.verificationStatus,
        verified: company.verified,
        isActive: company.isActive,
        updatedAt: company.updatedAt
      },
      message: `Company ${approved ? 'approved' : 'rejected'} successfully`
    });

  } catch (err) {
    console.error('❌ Verify company error:', err);
    next(err);
  }
});

// GET /intercity/companies/:companyId/status - GET COMPANY VERIFICATION STATUS (NO AUTH)
router.get('/companies/:companyId/status', async (req, res, next) => {
  try {
    const { companyId } = req.params;

    const company = await IntercityCompany.findById(companyId)
      .select('companyName verificationStatus verified isActive createdAt updatedAt')
      .lean();

    if (!company) {
      return res.status(404).json({
        success: false,
        error: { message: 'Company not found' }
      });
    }

    res.json({
      success: true,
      company
    });

  } catch (err) {
    console.error('❌ Get company status error:', err);
    next(err);
  }
});

// GET /intercity/companies/pending - GET PENDING COMPANIES (WITH BASIC AUTH)
router.get('/companies/pending', async (req, res, next) => {
  try {
    const { adminCode } = req.query;

    // Basic security check
    if (!adminCode || adminCode !== process.env.ADMINCODE) {
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid admin code' }
      });
    }

    const companies = await IntercityCompany.find({ 
      verificationStatus: 'pending' 
    })
    .populate('userId', 'name email phone')
    .select('companyName rcNumber contactEmail contactPhone address createdAt')
    .sort({ createdAt: -1 })
    .lean();

    res.json({
      success: true,
      companies,
      total: companies.length,
      message: companies.length > 0 
        ? `${companies.length} pending compan${companies.length === 1 ? 'y' : 'ies'} found`
        : 'No pending companies'
    });

  } catch (err) {
    console.error('❌ Get pending companies error:', err);
    next(err);
  }
});

module.exports = router;