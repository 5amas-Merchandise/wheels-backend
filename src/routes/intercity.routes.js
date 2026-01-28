const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
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


// POST /intercity/company/register - REGISTER NEW TRANSPORT COMPANY
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

    // Check if phone is already used
    const existingPhone = await User.findOne({ phone: ownerPhone || contactPhone });
    if (existingPhone) {
      return res.status(400).json({
        success: false,
        error: { message: 'Phone number already registered' }
      });
    }

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(ownerPassword, saltRounds);

    // Create user account for company owner
    // IMPORTANT: Use 'passwordHash' field as defined in the User schema
    const user = await User.create({
      email: ownerEmail,
      passwordHash: hashedPassword, // Changed from 'password' to 'passwordHash'
      name: ownerName,
      phone: ownerPhone || contactPhone,
      roles: {
        isUser: true,
        isTransportCompany: true,
        isDriver: false,
        isAdmin: false
      },
      transportCompanyProfile: {
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
      const field = Object.keys(err.keyPattern)[0];
      return res.status(400).json({
        success: false,
        error: { message: `${field} already registered` }
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

    // Find user and explicitly select the passwordHash field
    // IMPORTANT: Use .select('+passwordHash') because it has select: false in schema
    const user = await User.findOne({ email }).select('+passwordHash');
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid credentials' }
      });
    }

    // Check password using the comparePassword method from User schema
    // The method expects this.passwordHash to exist
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

// POST /intercity/bookings - CREATE BOOKING (FINAL FIXED VERSION)
router.post('/bookings', requireAuth, async (req, res, next) => {
  try {
    console.log('🚀 === BOOKING REQUEST STARTED ===');
    const userId = req.user.sub;
    const {
      scheduleId,
      passengerDetails,
      numberOfSeats,
      seatNumbers,
      specialRequests
    } = req.body;

    console.log('📥 Request data:', {
      userId,
      scheduleId,
      numberOfSeats,
      passengerDetails: passengerDetails?.fullName
    });

    // Validate required fields
    if (!scheduleId) {
      return res.status(400).json({
        success: false,
        error: { message: 'Schedule ID is required' }
      });
    }

    if (!passengerDetails || !passengerDetails.fullName || !passengerDetails.email || !passengerDetails.phone) {
      return res.status(400).json({
        success: false,
        error: { message: 'Complete passenger details are required' }
      });
    }

    if (!numberOfSeats || numberOfSeats < 1) {
      return res.status(400).json({
        success: false,
        error: { message: 'Number of seats must be at least 1' }
      });
    }

    // Get schedule
    console.log('🔍 Fetching schedule...');
    const schedule = await IntercitySchedule.findById(scheduleId);
    
    if (!schedule) {
      console.error('❌ Schedule not found:', scheduleId);
      return res.status(404).json({
        success: false,
        error: { message: 'Schedule not found' }
      });
    }

    console.log('✅ Schedule found:', {
      id: schedule._id,
      status: schedule.status,
      availableSeats: schedule.availableSeats,
      pricePerSeat: schedule.pricePerSeat
    });

    // Check availability
    if (schedule.status !== 'scheduled') {
      return res.status(400).json({
        success: false,
        error: { message: 'Schedule is not available for booking' }
      });
    }

    if (schedule.availableSeats < numberOfSeats) {
      return res.status(400).json({
        success: false,
        error: { message: `Only ${schedule.availableSeats} seats available` }
      });
    }

    // Calculate total
    const totalAmount = schedule.pricePerSeat * numberOfSeats;
    console.log('💰 Total amount:', totalAmount, 'kobo');

    // Create booking (bookingReference will be auto-generated by pre-save hook)
    console.log('📝 Creating booking...');
    const booking = await IntercityBooking.create({
      userId,
      scheduleId: schedule._id,
      routeId: schedule.routeId,
      companyId: schedule.companyId,
      passengerDetails: {
        fullName: passengerDetails.fullName.trim(),
        email: passengerDetails.email.trim().toLowerCase(),
        phone: passengerDetails.phone.trim(),
        ...(passengerDetails.nextOfKin && {
          nextOfKin: passengerDetails.nextOfKin
        })
      },
      numberOfSeats: numberOfSeats,
      seatNumbers: seatNumbers || [],
      totalAmount: totalAmount,
      status: 'confirmed',
      paymentStatus: 'pending',
      specialRequests: specialRequests || null
    });

    console.log('✅ Booking created:', {
      id: booking._id,
      reference: booking.bookingReference
    });

    // Update schedule seats
    console.log('🔄 Updating schedule...');
    schedule.bookedSeats = (schedule.bookedSeats || 0) + numberOfSeats;
    schedule.availableSeats -= numberOfSeats;
    await schedule.save();

    console.log('✅ Schedule updated:', {
      bookedSeats: schedule.bookedSeats,
      availableSeats: schedule.availableSeats
    });

    // Update company stats
    console.log('🔄 Updating company stats...');
    await IntercityCompany.findByIdAndUpdate(
      schedule.companyId,
      { $inc: { totalBookings: 1 } }
    );

    console.log('✅ Company stats updated');

    // Get populated data for response
    console.log('🔍 Fetching populated data...');
    const populatedSchedule = await IntercitySchedule.findById(schedule._id)
      .populate('routeId')
      .populate('companyId')
      .lean();

    if (!populatedSchedule || !populatedSchedule.routeId || !populatedSchedule.companyId) {
      console.error('❌ Failed to populate schedule data');
      // Still return success but with basic data
      return res.status(201).json({
        success: true,
        booking: {
          id: booking._id,
          bookingReference: booking.bookingReference,
          status: booking.status,
          numberOfSeats: booking.numberOfSeats,
          totalAmount: booking.totalAmount,
          totalAmountInNaira: (booking.totalAmount / 100).toFixed(2)
        },
        message: 'Booking confirmed successfully'
      });
    }

    const responseData = {
      success: true,
      booking: {
        id: booking._id,
        bookingReference: booking.bookingReference,
        status: booking.status,
        numberOfSeats: booking.numberOfSeats,
        totalAmount: booking.totalAmount,
        totalAmountInNaira: (booking.totalAmount / 100).toFixed(2),
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

    console.log('✅ === BOOKING COMPLETED SUCCESSFULLY ===');
    console.log('📤 Response:', responseData);

    res.status(201).json(responseData);

    // Send notification (non-blocking)
    setImmediate(() => {
      try {
        emitter.emit('notification', {
          userId: userId.toString(),
          type: 'booking_confirmed',
          title: 'Booking Confirmed',
          body: `Your booking ${booking.bookingReference} is confirmed`,
          data: {
            bookingId: booking._id,
            bookingReference: booking.bookingReference
          }
        });
      } catch (emitErr) {
        console.error('⚠️ Notification error (non-critical):', emitErr);
      }
    });

  } catch (err) {
    console.error('❌ === BOOKING ERROR ===');
    console.error('Error name:', err.name);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    
    let statusCode = 500;
    let errorMessage = err.message || 'Failed to create booking';

    if (err.name === 'ValidationError') {
      statusCode = 400;
      const messages = Object.values(err.errors).map(e => e.message);
      errorMessage = messages.join(', ');
    } else if (err.name === 'CastError') {
      statusCode = 400;
      errorMessage = 'Invalid ID format';
    } else if (err.message.includes('not found')) {
      statusCode = 404;
    } else if (err.message.includes('not available') || err.message.includes('seats available')) {
      statusCode = 400;
    }

    res.status(statusCode).json({
      success: false,
      error: { 
        message: errorMessage,
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }
    });
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