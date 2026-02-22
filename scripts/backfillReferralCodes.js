// scripts/backfillReferralCodes.js
// Run: node scripts/backfillReferralCodes.js

const mongoose = require('mongoose');
const User = require('../src/models/user.model');

const REFERRAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function generateUniqueReferralCode(name = '') {
  const prefix = (name || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3)
    .padEnd(3, REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)]);

  for (let attempt = 0; attempt < 10; attempt++) {
    let suffix = '';
    for (let i = 0; i < 5; i++) {
      suffix += REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)];
    }
    const code = prefix + suffix;
    const exists = await User.findOne({ referralCode: code }).lean();
    if (!exists) return code;
  }
  let fallback = '';
  for (let i = 0; i < 8; i++) {
    fallback += REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)];
  }
  return fallback;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://tezzertech:1914@cluster0.pzkucdw.mongodb.net/wheeladev');
  const users = await User.find({ $or: [ { referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' } ] });
  let updated = 0;
  for (const user of users) {
    const code = await generateUniqueReferralCode(user.name || '');
    user.referralCode = code;
    await user.save();
    updated++;
    console.log(`User ${user._id} assigned referral code: ${code}`);
  }
  console.log(`Done. ${updated} users updated.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
