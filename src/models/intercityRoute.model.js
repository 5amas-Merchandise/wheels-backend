const mongoose = require('mongoose');

const intercityRouteSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IntercityCompany',
    required: true
  },
  routeName: {
    type: String,
    required: true,
    trim: true
  },
  departureState: {
    type: String,
    required: true,
    enum: [
      'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa',
      'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo',
      'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa',
      'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
      'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun',
      'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'
    ]
  },
  departureCity: {
    type: String,
    required: true
  },
  departureTerminal: {
    type: String,
    default: 'Main Terminal'
  },
  arrivalState: {
    type: String,
    required: true,
    enum: [
      'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa',
      'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo',
      'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa',
      'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
      'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun',
      'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'
    ]
  },
  arrivalCity: {
    type: String,
    required: true
  },
  arrivalTerminal: {
    type: String,
    default: 'Main Terminal'
  },
  estimatedDuration: {
    type: Number, // in minutes
    required: true,
    min: 30,
    max: 1440 // 24 hours
  },
  estimatedDistance: {
    type: Number, // in kilometers
    required: true,
    min: 10,
    max: 2000
  },
  basePrice: {
    type: Number, // price in kobo
    required: true,
    min: 1000, // Minimum ₦10
    max: 5000000 // Maximum ₦50,000
  },
  vehicleType: {
    type: String,
    enum: ['bus', 'minibus', 'luxury_bus', 'van', 'coaster'],
    default: 'bus'
  },
  amenities: [{
    type: String,
    enum: ['AC', 'WiFi', 'TV', 'Refreshments', 'Reclining Seats', 'Restroom', 'USB Charging', 'First Aid', 'Security']
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  // New fields
  routeCode: {
    type: String,
    unique: true,
    sparse: true
  },
  popular: {
    type: Boolean,
    default: false
  },
  stops: [{
    city: String,
    state: String,
    terminal: String,
    stopDuration: Number // in minutes
  }],
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Compound index for route queries
intercityRouteSchema.index({ departureState: 1, arrivalState: 1, isActive: 1 });
intercityRouteSchema.index({ companyId: 1, isActive: 1 });
intercityRouteSchema.index({ departureCity: 'text', arrivalCity: 'text' });

// Virtual for price in Naira
intercityRouteSchema.virtual('priceInNaira').get(function() {
  return (this.basePrice / 100).toFixed(2);
});

// Virtual for formatted duration
intercityRouteSchema.virtual('formattedDuration').get(function() {
  const hours = Math.floor(this.estimatedDuration / 60);
  const minutes = this.estimatedDuration % 60;
  return `${hours}h ${minutes}m`;
});

// Generate route code
intercityRouteSchema.pre('save', function(next) {
  if (!this.routeCode) {
    const depCode = this.departureCity.substring(0, 3).toUpperCase();
    const arrCode = this.arrivalCity.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000);
    this.routeCode = `${depCode}-${arrCode}-${randomNum}`;
  }
  next();
});

module.exports = mongoose.model('IntercityRoute', intercityRouteSchema);