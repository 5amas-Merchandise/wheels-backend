// utils/tripPaymentService.js
//
// This service handles the wallet side of trip completion.
// Key rule: The DRIVER always receives the full fare regardless of how
// the passenger pays (cash, wallet, referral bonus, etc.).
//
// Payment flow for wallet trips:
//   1. Passenger wallet is debited the final fare
//   2. Driver wallet is credited the full final fare
//   3. Both sides get Transaction records linked via relatedTransactionId
//
// The referral bonus is just wallet credit the passenger already has.
// From the driver's perspective it makes no difference — they earn the full amount.
//
// IMPORTANT UNIT NOTE:
// ─────────────────────────────────────────────────────────────────────────────
// fareNaira in this function is the actual value coming from Trip.estimatedFare
// stored in NAIRA (not kobo). The wallet balance is stored in KOBO by Paystack convention.
// So we convert: fareKobo = fareNaira * 100 for wallet operations.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');
const Wallet = require('../models/wallet.model');
const Transaction = require('../models/transaction.model');

/**
 * Process wallet payment for a completed trip.
 *
 * @param {Object} params
 * @param {string} params.tripId
 * @param {string} params.passengerId
 * @param {string} params.driverId
 * @param {number} params.fareNaira         - Final fare in NAIRA (as stored in Trip)
 * @param {string} params.serviceType
 * @param {Object} session                   - Mongoose session (must be active)
 *
 * @returns {{ passengerTxn, driverTxn, driverWallet }}
 * @throws  Error if passenger wallet has insufficient balance
 */
async function processTripWalletPayment({ tripId, passengerId, driverId, fareNaira, serviceType }, session) {
  console.log(`💳 Processing wallet payment for trip ${tripId}: ₦${fareNaira}`);

  // Convert to kobo for wallet operations
  const fareKobo = Math.round(fareNaira * 100);
  
  if (!fareKobo || fareKobo <= 0) {
    throw new Error(`Invalid fare: ${fareNaira} naira`);
  }

  const passengerObjectId = new mongoose.Types.ObjectId(passengerId);
  const driverObjectId = new mongoose.Types.ObjectId(driverId);

  // ── 1. Load both wallets ──────────────────────────────────────────────────
  const [passengerWallet, driverWallet] = await Promise.all([
    Wallet.findOne({ owner: passengerObjectId }).session(session),
    Wallet.findOne({ owner: driverObjectId }).session(session)
  ]);

  if (!passengerWallet) {
    throw new Error('Passenger wallet not found');
  }

  // Create driver wallet on-the-fly if it somehow doesn't exist
  let resolvedDriverWallet = driverWallet;
  if (!resolvedDriverWallet) {
    console.log(`⚠️ Driver ${driverId} has no wallet — creating one`);
    const created = await Wallet.create([{
      owner: driverObjectId,
      balance: 0,
      currency: 'NGN'
    }], { session });
    resolvedDriverWallet = created[0];
  }

  console.log(`👛 Passenger wallet balance: ${passengerWallet.balance} kobo (₦${(passengerWallet.balance / 100).toFixed(2)})`);
  console.log(`💰 Fare required: ${fareKobo} kobo (₦${fareNaira})`);

  // ── 2. Check passenger has enough balance ────────────────────────────────
  if (passengerWallet.balance < fareKobo) {
    const shortfall = fareKobo - passengerWallet.balance;
    throw new Error(
      `Insufficient wallet balance. ` +
      `Available: ₦${(passengerWallet.balance / 100).toFixed(2)}, ` +
      `Required: ₦${fareNaira}, ` +
      `Shortfall: ₦${(shortfall / 100).toFixed(2)}`
    );
  }

  // ── 3. Debit passenger ───────────────────────────────────────────────────
  const passengerBalanceBefore = passengerWallet.balance;
  passengerWallet.balance -= fareKobo;
  await passengerWallet.save({ session });

  console.log(
    `➖ Passenger ${passengerId} debited ₦${fareNaira}. ` +
    `Balance: ₦${(passengerBalanceBefore / 100).toFixed(2)} → ₦${(passengerWallet.balance / 100).toFixed(2)}`
  );

  // ── 4. Credit driver (full fare — always) ────────────────────────────────
  const driverBalanceBefore = resolvedDriverWallet.balance;
  resolvedDriverWallet.balance += fareKobo;
  await resolvedDriverWallet.save({ session });

  console.log(
    `➕ Driver ${driverId} credited ₦${fareNaira}. ` +
    `Balance: ₦${(driverBalanceBefore / 100).toFixed(2)} → ₦${(resolvedDriverWallet.balance / 100).toFixed(2)}`
  );

  // ── 5. Create transaction records ────────────────────────────────────────
  const [passengerTxn] = await Transaction.create([{
    userId: passengerObjectId,
    type: 'debit',
    amount: fareKobo,
    description: `Ride payment — ${serviceType || 'ride'} trip`,
    category: 'trip_payment',
    status: 'completed',
    balanceBefore: passengerBalanceBefore,
    balanceAfter: passengerWallet.balance,
    metadata: {
      tripId: tripId.toString(),
      driverId: driverId.toString(),
      serviceType,
      fareNaira,
    }
  }], { session });

  const [driverTxn] = await Transaction.create([{
    userId: driverObjectId,
    type: 'credit',
    amount: fareKobo,
    description: `Ride earnings — ${serviceType || 'ride'} trip`,
    category: 'trip_earning',
    status: 'completed',
    balanceBefore: driverBalanceBefore,
    balanceAfter: resolvedDriverWallet.balance,
    relatedTransactionId: passengerTxn._id,
    metadata: {
      tripId: tripId.toString(),
      passengerId: passengerId.toString(),
      serviceType,
      fareNaira,
      paymentMethod: 'wallet'
    }
  }], { session });

  // Back-link passenger txn to driver txn for easy auditing
  await Transaction.findByIdAndUpdate(
    passengerTxn._id,
    { relatedTransactionId: driverTxn._id },
    { session }
  );

  console.log(`📝 Transactions created — Passenger: ${passengerTxn._id}, Driver: ${driverTxn._id}`);

  return {
    passengerTxn,
    driverTxn,
    driverWallet: resolvedDriverWallet
  };
}

/**
 * Record earnings for a cash trip.
 * For cash trips the passenger pays the driver in person. We credit the driver's
 * wallet to keep their total earnings accurate, since the physical cash has
 * already changed hands outside the app.
 *
 * @param {Object} params
 * @param {string} params.tripId
 * @param {string} params.driverId
 * @param {number} params.fareNaira
 * @param {string} params.serviceType
 * @param {Object} session
 *
 * @returns {{ driverTxn, driverWallet }}
 */
async function recordCashTripEarning({ tripId, driverId, fareNaira, serviceType }, session) {
  console.log(`💵 Recording cash earnings for driver ${driverId}: ₦${fareNaira}`);

  const fareKobo = Math.round(fareNaira * 100);
  const driverObjectId = new mongoose.Types.ObjectId(driverId);

  let driverWallet = await Wallet.findOne({ owner: driverObjectId }).session(session);
  
  if (!driverWallet) {
    console.log(`Creating new wallet for driver ${driverId}`);
    const created = await Wallet.create([{
      owner: driverObjectId,
      balance: 0,
      currency: 'NGN'
    }], { session });
    driverWallet = created[0];
  }

  const balanceBefore = driverWallet.balance;
  
  // Credit the driver wallet with the cash fare they physically collected
  driverWallet.balance += fareKobo;
  await driverWallet.save({ session });

  const [driverTxn] = await Transaction.create([{
    userId: driverObjectId,
    type: 'credit',
    amount: fareKobo,
    description: `Cash ride earnings — ${serviceType || 'ride'} trip`,
    category: 'trip_earning',
    status: 'completed',
    balanceBefore,
    balanceAfter: driverWallet.balance,
    metadata: {
      tripId: tripId.toString(),
      serviceType,
      fareNaira,
      paymentMethod: 'cash'
    }
  }], { session });

  console.log(`✅ Driver cash earning recorded: ${driverTxn._id} | New balance: ₦${(driverWallet.balance / 100).toFixed(2)}`);

  return { driverTxn, driverWallet };
}

module.exports = { processTripWalletPayment, recordCashTripEarning };