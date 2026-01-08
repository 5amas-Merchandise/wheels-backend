#!/usr/bin/env node
/* Seed an initial admin user. Usage:
   ADMIN_EMAIL=admin@local ADMIN_PASSWORD=Secret123 node scripts/seedAdmin.js
*/
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/user.model');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not set in environment');
    process.exit(1);
  }

  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  const email = process.env.ADMIN_EMAIL || 'admin@wheela.local';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const phone = process.env.ADMIN_PHONE || '+10000000000';

  let admin = await User.findOne({ email });
  if (!admin) {
    admin = new User({ name: 'Administrator', email, phone });
  }

  admin.phone = admin.phone || phone;
  admin.roles = Object.assign({}, admin.roles || {}, { isAdmin: true, isDriver: false, isUser: false });
  admin.passwordHash = await bcrypt.hash(password, 10);
  await admin.save();
  console.log('Admin ensured:', email);
  console.log('You can login via POST /auth/login with identifier=', email);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
