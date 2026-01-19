const mongoose = require('mongoose');

const intercityScheduleSchema = new mongoose.Schema({
  routeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntercityRoute',
    required: true
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntercityCompany',
    required: true
  },
  scheduleCode: {
    type: String,
    unique: true
  },
  departureDate: {
    type: Date,
    required: true
  },
  departureTime: {
    type: String, // Format: "HH:MM" (24-hour)
    required: true,
    validate: {
      validator: function(v) {
        return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
      },
      message: 'Invalid time format. Use HH:MM (24-hour format)'
    }
  },
  arrivalTime: {
    type: String, // Estimated arrival time
    required: true,
    validate: {
      validator: function(v) {
        return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
      },
      message: 'Invalid time format. Use HH:MM (24-hour format)'
    }
  },
  totalSeats: {
    type: Number,
    required: true,
    min: 1,
    max: 100
  },
  availableSeats: {
    type: Number,
    required: true
  },
  bookedSeats: {
    type: Number,
    default: 0
  },
  pricePerSeat: {
    type: Number, // in kobo
    required: true,
    min: 1000,
    max: 5000000
  },
  vehicleNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  driverName: {
    type: String,
    default: null
  },
  driverPhone: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['scheduled', 'boarding', 'departed', 'arrived', 'cancelled', 'delayed'],
    default: 'scheduled'
  },
  cancellationReason: {
    type: String,
    default: null
  },
  delayReason: {
    type: String,
    default: null
  },
  delayMinutes: {
    type: Number,
    default: 0
  },
  // New fields
  boardingPoint: {
    type: String,
    default: null
  },
  notes: {
    type: String,
    default: null
  },
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
intercityScheduleSchema.index({ routeId: 1, departureDate: 1, status: 1 });
intercityScheduleSchema.index({ companyId: 1, departureDate: 1 });
intercityScheduleSchema.index({ departureDate: 1, status: 1 });
intercityScheduleSchema.index({ scheduleCode: 1 });
intercityScheduleSchema.index({ vehicleNumber: 1, departureDate: 1 });

// Prevent overbooking
intercityScheduleSchema.pre('save', function(next) {
  if (this.bookedSeats > this.totalSeats) {
    return next(new Error('Cannot book more seats than available'));
  }
  this.availableSeats = this.totalSeats - this.bookedSeats;
  
  // Validate departure date is in future for new schedules
  if (this.isNew && new Date(this.departureDate) < new Date()) {
    return next(new Error('Departure date must be in the future'));
  }
  
  next();
});

// Generate schedule code
intercityScheduleSchema.pre('save', function(next) {
  if (!this.scheduleCode) {
    const date = new Date(this.departureDate);
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
    const timeStr = this.departureTime.replace(':', '');
    const randomNum = Math.floor(Math.random() * 100);
    this.scheduleCode = `SCH-${dateStr}-${timeStr}-${randomNum}`;
  }
  next();
});

// Virtual for price in Naira
intercityScheduleSchema.virtual('priceInNaira').get(function() {
  return (this.pricePerSeat / 100).toFixed(2);
});

// Virtual for formatted departure datetime
intercityScheduleSchema.virtual('departureDateTime').get(function() {
  const date = new Date(this.departureDate);
  const [hours, minutes] = this.departureTime.split(':');
  date.setHours(parseInt(hours), parseInt(minutes), 0, 0);
  return date;
});

// Virtual for arrival datetime
intercityScheduleSchema.virtual('arrivalDateTime').get(function() {
  const departureDate = new Date(this.departureDate);
  const [hours, minutes] = this.arrivalTime.split(':');
  const arrivalDate = new Date(departureDate);
  arrivalDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
  
  // If arrival time is earlier than departure (next day)
  if (arrivalDate < departureDate) {
    arrivalDate.setDate(arrivalDate.getDate() + 1);
  }
  
  return arrivalDate;
});

// Method to check if schedule is full
intercityScheduleSchema.methods.isFull = function() {
  return this.availableSeats === 0;
};

// Method to check if schedule is available for booking
intercityScheduleSchema.methods.isAvailable = function() {
  return this.status === 'scheduled' && this.availableSeats > 0;
};

module.exports = mongoose.model('IntercitySchedule', intercityScheduleSchema);