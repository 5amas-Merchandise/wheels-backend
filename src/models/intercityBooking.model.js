const mongoose = require('mongoose');

const intercityBookingSchema = new mongoose.Schema({
  bookingReference: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  scheduleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntercitySchedule',
    required: true
  },
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
  passengerDetails: {
    fullName: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    phone: {
      type: String,
      required: true,
      trim: true
    },
    nextOfKin: {
      name: String,
      phone: String,
      relationship: String
    },
    idType: {
      type: String,
      enum: ['NIN', 'Driver License', 'Voter Card', 'International Passport', 'Other', null],
      default: null
    },
    idNumber: String
  },
  numberOfSeats: {
    type: Number,
    required: true,
    min: 1,
    max: 10
  },
  seatNumbers: [{
    type: String,
    uppercase: true,
    trim: true
  }],
  totalAmount: {
    type: Number, // in kobo
    required: true
  },
  amountPaid: {
    type: Number,
    default: 0
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'partial', 'paid', 'refunded', 'failed'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    enum: ['card', 'transfer', 'wallet', 'cash', null],
    default: null
  },
  paymentReference: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show', 'refunded'],
    default: 'confirmed'
  },
  bookingDate: {
    type: Date,
    default: Date.now
  },
  cancellationDate: {
    type: Date,
    default: null
  },
  cancellationReason: {
    type: String,
    default: null
  },
  checkedInAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  specialRequests: {
    type: String,
    default: null
  },
  qrCode: {
    type: String, // Base64 QR code for verification
    default: null
  },
  qrCodeData: {
    type: String, // Encrypted booking data for QR
    default: null
  },
  // New fields
  bookingSource: {
    type: String,
    enum: ['web', 'mobile', 'agent', 'admin'],
    default: 'mobile'
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  discountCode: {
    type: String,
    default: null
  },
  discountAmount: {
    type: Number,
    default: 0
  },
  taxAmount: {
    type: Number,
    default: 0
  },
  serviceCharge: {
    type: Number,
    default: 0
  },
  insurance: {
    type: Boolean,
    default: false
  },
  insuranceAmount: {
    type: Number,
    default: 0
  },
  notes: {
    type: String,
    default: null
  },
  // For analytics
  deviceInfo: {
    platform: String,
    os: String,
    browser: String,
    ipAddress: String
  }
}, {
  timestamps: true
});

// Indexes
intercityBookingSchema.index({ userId: 1, createdAt: -1 });
intercityBookingSchema.index({ companyId: 1, createdAt: -1 });
intercityBookingSchema.index({ scheduleId: 1, status: 1 });
intercityBookingSchema.index({ bookingReference: 1 });
intercityBookingSchema.index({ 'passengerDetails.email': 1 });
intercityBookingSchema.index({ 'passengerDetails.phone': 1 });
intercityBookingSchema.index({ paymentStatus: 1, status: 1 });

// Virtual for total amount in Naira
intercityBookingSchema.virtual('totalAmountInNaira').get(function() {
  return (this.totalAmount / 100).toFixed(2);
});

// Virtual for amount paid in Naira
intercityBookingSchema.virtual('amountPaidInNaira').get(function() {
  return (this.amountPaid / 100).toFixed(2);
});

// Virtual for outstanding amount
intercityBookingSchema.virtual('outstandingAmount').get(function() {
  return this.totalAmount - this.amountPaid;
});

// Virtual for outstanding amount in Naira
intercityBookingSchema.virtual('outstandingAmountInNaira').get(function() {
  return ((this.totalAmount - this.amountPaid) / 100).toFixed(2);
});

// Generate booking reference
intercityBookingSchema.pre('save', async function(next) {
  if (!this.bookingReference) {
    const timestamp = Date.now();
    const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.bookingReference = `IC${timestamp}${randomNum}`;
  }
  
  // Generate QR code data if not exists
  if (!this.qrCodeData && this.bookingReference) {
    const bookingData = {
      bookingId: this._id.toString(),
      reference: this.bookingReference,
      passenger: this.passengerDetails.fullName,
      scheduleId: this.scheduleId.toString()
    };
    this.qrCodeData = JSON.stringify(bookingData);
  }
  
  next();
});

// Update schedule when booking is confirmed
intercityBookingSchema.post('save', async function(doc) {
  if (doc.status === 'confirmed' && doc.numberOfSeats > 0) {
    const Schedule = mongoose.model('IntercitySchedule');
    await Schedule.findByIdAndUpdate(doc.scheduleId, {
      $inc: { bookedSeats: doc.numberOfSeats, availableSeats: -doc.numberOfSeats }
    });
  }
});

// Update schedule when booking is cancelled
intercityBookingSchema.post('findOneAndUpdate', async function(doc) {
  if (doc && doc.status === 'cancelled' && doc.numberOfSeats > 0) {
    const Schedule = mongoose.model('IntercitySchedule');
    await Schedule.findByIdAndUpdate(doc.scheduleId, {
      $inc: { bookedSeats: -doc.numberOfSeats, availableSeats: doc.numberOfSeats }
    });
  }
});

// Method to check if booking is cancellable
intercityBookingSchema.methods.isCancellable = function() {
  const nonCancellableStatuses = ['cancelled', 'completed', 'no_show', 'refunded'];
  return !nonCancellableStatuses.includes(this.status);
};

// Method to check if booking is refundable
intercityBookingSchema.methods.isRefundable = function() {
  const refundableStatuses = ['confirmed', 'checked_in'];
  const now = new Date();
  const bookingDate = new Date(this.bookingDate);
  const hoursDifference = (now - bookingDate) / (1000 * 60 * 60);
  
  return refundableStatuses.includes(this.status) && hoursDifference <= 24;
};

module.exports = mongoose.model('IntercityBooking', intercityBookingSchema);