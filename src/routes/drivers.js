// routes/drivers.routes.js
const express = require('express');
const router = express.Router();
const User = require('../models/user.model');
const { requireAuth } = require('../middleware/auth');
const DURATION_DAYS = {
daily: 1,
weekly: 7,
monthly: 30
};
// Subscribe or renew subscription (driver action)
router.post('/subscribe', requireAuth, async (req, res, next) => {
try {
const userId = req.user && req.user.sub;
if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
const { type } = req.body;
if (!type || !DURATION_DAYS[type]) return res.status(400).json({ error: { message: 'Invalid subscription type' } });
const user = await User.findById(userId);
if (!user) return res.status(404).json({ error: { message: 'User not found' } });
const now = new Date();
const days = DURATION_DAYS[type];
const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
user.subscription = { type, startedAt: now, expiresAt };
// mark as driver if not already
user.roles = user.roles || {};
user.roles.isDriver = true;
await user.save();
res.json({ ok: true, subscription: user.subscription });
  } catch (err) {
next(err);
  }
});
// Get subscription status
router.get('/subscription', requireAuth, async (req, res, next) => {
try {
const userId = req.user && req.user.sub;
if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
const user = await User.findById(userId).lean();
if (!user) return res.status(404).json({ error: { message: 'User not found' } });
res.json({ subscription: user.subscription || null });
  } catch (err) {
next(err);
  }
});
// --- Driver profile management ---
// Get driver profile
router.get('/me', requireAuth, async (req, res, next) => {
try {
const userId = req.user && req.user.sub;
if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
const user = await User.findById(userId).lean();
if (!user) return res.status(404).json({ error: { message: 'User not found' } });
res.json({ driverProfile: user.driverProfile, roles: user.roles });
  } catch (err) {
next(err);
  }
});
// Update basic driver profile (vehicle info, name)
router.post('/profile', requireAuth, async (req, res, next) => {
try {
const userId = req.user && req.user.sub;
if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
// Onboarding fields
const {
vehicleMake,
vehicleModel,
vehicleNumber,
name,
profilePicUrl,
carPicUrl,
nin,
ninImageUrl,
licenseNumber,
licenseImageUrl
    } = req.body;
const update = {};
if (vehicleMake !== undefined) update['driverProfile.vehicleMake'] = vehicleMake;
if (vehicleModel !== undefined) update['driverProfile.vehicleModel'] = vehicleModel;
if (vehicleNumber !== undefined) update['driverProfile.vehicleNumber'] = vehicleNumber;
if (name !== undefined) update['name'] = name;
if (profilePicUrl !== undefined) update['driverProfile.profilePicUrl'] = profilePicUrl;
if (carPicUrl !== undefined) update['driverProfile.carPicUrl'] = carPicUrl;
if (nin !== undefined) update['driverProfile.nin'] = nin;
if (ninImageUrl !== undefined) update['driverProfile.ninImageUrl'] = ninImageUrl;
if (licenseNumber !== undefined) update['driverProfile.licenseNumber'] = licenseNumber;
if (licenseImageUrl !== undefined) update['driverProfile.licenseImageUrl'] = licenseImageUrl;
const user = await User.findByIdAndUpdate(userId, { $set: update }, { new: true }).lean();
res.json({ driverProfile: user.driverProfile });
  } catch (err) {
next(err);
  }
});
// Add or remove service categories
router.post('/service-categories', requireAuth, async (req, res, next) => {
try {
const userId = req.user && req.user.sub;
if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
const { add = [], remove = [] } = req.body;
// ensure arrays
if (!Array.isArray(add) || !Array.isArray(remove)) return res.status(400).json({ error: { message: 'add and remove must be arrays' } });
const user = await User.findById(userId);
if (!user) return res.status(404).json({ error: { message: 'User not found' } });
user.driverProfile.serviceCategories = user.driverProfile.serviceCategories || [];
// add unique
for (const s of add) {
if (!user.driverProfile.serviceCategories.includes(s)) user.driverProfile.serviceCategories.push(s);
    }
// remove
user.driverProfile.serviceCategories = user.driverProfile.serviceCategories.filter(s => !remove.includes(s));
await user.save();
res.json({ serviceCategories: user.driverProfile.serviceCategories });
  } catch (err) {
next(err);
  }
});
// Update availability and location
router.post('/availability', requireAuth, async (req, res, next) => {
try {
const userId = req.user && req.user.sub;
if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
const { isAvailable, location } = req.body;
const update = { 'driverProfile.lastSeen': new Date() };
if (typeof isAvailable === 'boolean') update['driverProfile.isAvailable'] = isAvailable;
if (location && Array.isArray(location.coordinates) && location.coordinates.length === 2) {
update['driverProfile.location'] = { type: 'Point', coordinates: location.coordinates };
    }
const user = await User.findByIdAndUpdate(userId, { $set: update }, { new: true }).lean();
res.json({ driverProfile: user.driverProfile });
  } catch (err) {
next(err);
  }
});
// Driver requests verification (moves state to pending)
router.put('/request-verification', requireAuth, async (req, res, next) => {
try {
const userId = req.user?.sub;
console.log('🚀 === VERIFICATION REQUEST START ===');
console.log('User ID:', userId);
console.log('Request Body:', JSON.stringify(req.body, null, 2));
if (!userId) {
console.log('❌ No user ID found in token');
return res.status(401).json({ error: { message: 'Unauthorized' } });
    }
// First, check if user exists
const existingUser = await User.findById(userId);
if (!existingUser) {
console.log('❌ User not found');
return res.status(404).json({ error: { message: 'User not found' } });
    }
console.log('\n📊 === EXISTING USER ===');
console.log('Name:', existingUser.name);
console.log('Roles:', existingUser.roles);
console.log('Has driverProfile?:', !!existingUser.driverProfile);
console.log('Driver Profile:', JSON.stringify(existingUser.driverProfile, null, 2));
const {
name,
vehicleMake,
vehicleModel,
vehicleNumber,
nin,
licenseNumber,
serviceCategories,
profilePicUrl,
carPicUrl,
ninImageUrl,
licenseImageUrl,
vehicleRegistrationUrl,
    } = req.body;
// Validate required fields
if (!name || !vehicleMake || !vehicleModel || !vehicleNumber || !nin || !licenseNumber) {
return res.status(400).json({
error: { message: 'Missing required fields' }
      });
    }
if (!serviceCategories || !Array.isArray(serviceCategories) || serviceCategories.length === 0) {
return res.status(400).json({
error: { message: 'Service category is required' }
      });
    }
if (nin.length !== 11) {
return res.status(400).json({
error: { message: 'NIN must be exactly 11 digits' }
      });
    }
if (!profilePicUrl || !carPicUrl || !ninImageUrl || !licenseImageUrl || !vehicleRegistrationUrl) {
return res.status(400).json({
error: { message: 'All document images are required' }
      });
    }
console.log('\n✅ === VALIDATION PASSED ===');
// Use findOneAndUpdate with dot notation to ensure nested update
const updateData = {
$set: {
// Update user name
name: name.trim(),
// Ensure driver role is set
'roles.isDriver': true,
'roles.isUser': true,
'roles.isAdmin': existingUser.roles?.isAdmin || false,
// Update ALL driverProfile fields with dot notation
'driverProfile.vehicleMake': vehicleMake.trim(),
'driverProfile.vehicleModel': vehicleModel.trim(),
'driverProfile.vehicleNumber': vehicleNumber.trim().toUpperCase(),
'driverProfile.nin': nin.trim(),
'driverProfile.licenseNumber': licenseNumber.trim(),
'driverProfile.serviceCategories': Array.isArray(serviceCategories) ? serviceCategories : [serviceCategories],
'driverProfile.profilePicUrl': profilePicUrl,
'driverProfile.carPicUrl': carPicUrl,
'driverProfile.ninImageUrl': ninImageUrl,
'driverProfile.licenseImageUrl': licenseImageUrl,
'driverProfile.vehicleRegistrationUrl': vehicleRegistrationUrl,
'driverProfile.verified': false,
'driverProfile.verificationState': 'pending',
'driverProfile.submittedAt': new Date(),
// Set default values if not present
'driverProfile.isAvailable': existingUser.driverProfile?.isAvailable !== undefined
? existingUser.driverProfile.isAvailable
: true,
'driverProfile.location': existingUser.driverProfile?.location
? existingUser.driverProfile.location
: { type: 'Point', coordinates: [0, 0] },
'driverProfile.lastSeen': existingUser.driverProfile?.lastSeen
? existingUser.driverProfile.lastSeen
: new Date(),
      }
    };
console.log('\n🔄 === UPDATE DATA ===');
console.log(JSON.stringify(updateData, null, 2));
// Perform the update
const updatedUser = await User.findOneAndUpdate(
      { _id: userId },
updateData,
      {
new: true, // Return the updated document
runValidators: true, // Run schema validators
upsert: false, // Don't create if doesn't exist
setDefaultsOnInsert: true, // Set default values
      }
    ).select('name phone roles driverProfile');
if (!updatedUser) {
console.log('❌ Failed to update user');
return res.status(500).json({
error: { message: 'Failed to update user profile' }
      });
    }
console.log('\n✅ === USER UPDATED SUCCESSFULLY ===');
console.log('Updated User ID:', updatedUser._id);
console.log('Name:', updatedUser.name);
console.log('Roles:', updatedUser.roles);
console.log('Has driverProfile?:', !!updatedUser.driverProfile);
console.log('Driver Profile verificationState:', updatedUser.driverProfile?.verificationState);
console.log('Driver Profile vehicleMake:', updatedUser.driverProfile?.vehicleMake);
console.log('Driver Profile serviceCategories:', updatedUser.driverProfile?.serviceCategories);
console.log('Driver Profile submittedAt:', updatedUser.driverProfile?.submittedAt);
console.log('Full driverProfile:', JSON.stringify(updatedUser.driverProfile, null, 2));
// Verify the update by fetching fresh from DB
const verifiedUser = await User.findById(updatedUser._id);
console.log('\n🔍 === DATABASE VERIFICATION ===');
console.log('Verified - Has driverProfile?:', !!verifiedUser.driverProfile);
console.log('Verified - Driver Profile keys:', verifiedUser.driverProfile ? Object.keys(verifiedUser.driverProfile) : []);
res.json({
success: true,
message: 'Driver verification request submitted successfully',
data: {
userId: updatedUser._id,
name: updatedUser.name,
verificationState: updatedUser.driverProfile?.verificationState || 'pending',
submittedAt: updatedUser.driverProfile?.submittedAt || new Date(),
      },
debug: {
hasDriverProfile: !!updatedUser.driverProfile,
profileKeys: updatedUser.driverProfile ? Object.keys(updatedUser.driverProfile) : [],
vehicleMake: updatedUser.driverProfile?.vehicleMake,
serviceCategories: updatedUser.driverProfile?.serviceCategories,
      }
    });
  } catch (err) {
console.error('\n❌ === ERROR IN VERIFICATION REQUEST ===');
console.error('Error:', err.message);
console.error('Error stack:', err.stack);
// Handle validation errors
if (err.name === 'ValidationError') {
return res.status(400).json({
error: {
message: 'Validation failed',
details: Object.values(err.errors).map(e => e.message)
        }
      });
    }
// Handle duplicate key errors
if (err.code === 11000) {
return res.status(400).json({
error: {
message: 'Duplicate field value entered',
field: Object.keys(err.keyPattern)[0]
        }
      });
    }
res.status(500).json({
error: {
message: 'Failed to submit verification request',
details: err.message
      }
    });
  }
});
// Add this route for debugging
// GET /drivers/check-user/:userId
router.get('/check-user/:userId', async (req, res, next) => {
try {
const { userId } = req.params;
console.log(`\n=== CHECKING USER ${userId} ===`);
const user = await User.findById(userId);
if (!user) {
console.log('User not found');
return res.status(404).json({
error: { message: 'User not found' }
      });
    }
console.log('User found:');
console.log('Name:', user.name);
console.log('Phone:', user.phone);
console.log('Roles:', user.roles);
console.log('Has driverProfile?:', !!user.driverProfile);
console.log('Driver Profile keys:', user.driverProfile ? Object.keys(user.driverProfile) : []);
console.log('Driver Profile verificationState:', user.driverProfile?.verificationState);
console.log('Driver Profile vehicleMake:', user.driverProfile?.vehicleMake);
console.log('Driver Profile serviceCategories:', user.driverProfile?.serviceCategories);
console.log('Full driverProfile:', JSON.stringify(user.driverProfile, null, 2));
res.json({
success: true,
user: {
_id: user._id,
name: user.name,
phone: user.phone,
roles: user.roles,
hasDriverProfile: !!user.driverProfile,
driverProfile: user.driverProfile || {},
driverProfileKeys: user.driverProfile ? Object.keys(user.driverProfile) : [],
createdAt: user.createdAt,
updatedAt: user.updatedAt
      }
    });
  } catch (err) {
console.error('Error checking user:', err);
res.status(500).json({
error: {
message: 'Failed to check user',
details: err.message
      }
    });
  }
});
// GET currently offered trip request for the driver (for polling)
router.get('/offered-request', requireAuth, async (req, res, next) => {
try {
const driverId = req.user.sub;
const activeRequest = await TripRequest.findOne({
'candidates': {
$elemMatch: {
driverId: driverId,
status: 'offered'
        }
      },
status: 'searching'
    })
    .populate('passengerId', 'name') // get passenger name
    .lean();
if (!activeRequest) {
return res.status(404).json({ message: 'No active offer' });
    }
// Find the specific candidate entry
const candidate = activeRequest.candidates.find(
c => c.driverId.toString() === driverId && c.status === 'offered'
    );
if (!candidate) {
return res.status(404).json({ message: 'No active offer' });
    }
// Build response similar to what your frontend expects
const response = {
request: {
requestId: activeRequest._id,
passengerName: activeRequest.passengerId?.name || 'Passenger',
rating: 4.8, // you can store real rating later
pickupAddress: 'Pickup location near you', // improve with reverse geocoding later
fare: 2500, // temporary – replace with real fare calculation
serviceType: activeRequest.serviceType // Added to show service type
      }
    };
res.json(response);
  } catch (err) {
next(err);
  }
});
module.exports = router;