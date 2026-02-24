// utils/tripPaymentService.js
const mongoose = require('mongoose');
const Wallet = require('../models/wallet.model');
const Transaction = require('../models/transaction.model');

/**
 * Process a wallet payment for a completed trip.
 * - Debits the passenger's wallet
 * - Credits the driver's wallet
 * - Creates matched Transaction records for both parties
 *
 * All amounts internally in KOBO. fareNaira is accepted and converted.
 */
async function processTripWalletPayment({ tripId, passengerId, driverId, fareNaira, serviceType }, session) {
  console.log(`💳 processTripWalletPayment | trip: ${tripId} | fare: ₦${fareNaira}`);

  const fareKobo = Math.round(fareNaira * 100);

  // ✅ Always use ObjectId — userId stored as ObjectId so Transaction.find({ userId }) always matches
  const passengerObjectId = new mongoose.Types.ObjectId(passengerId.toString());
  const driverObjectId    = new mongoose.Types.ObjectId(driverId.toString());
  const tripObjectId      = new mongoose.Types.ObjectId(tripId.toString());

  // ── Passenger wallet ──────────────────────────────────────────────────────
  const passengerWallet = await Wallet.findOne({ owner: passengerObjectId }).session(session);
  if (!passengerWallet) {
    throw new Error('Passenger wallet not found');
  }
  if (passengerWallet.balance < fareKobo) {
    throw new Error(
      `Insufficient passenger balance. ` +
      `Available: ₦${(passengerWallet.balance / 100).toFixed(2)}, ` +
      `Required: ₦${fareNaira.toFixed(2)}`
    );
  }

  // ── Driver wallet ─────────────────────────────────────────────────────────
  let driverWallet = await Wallet.findOne({ owner: driverObjectId }).session(session);
  if (!driverWallet) {
    console.log(`Creating wallet for driver ${driverId}`);
    const created = await Wallet.create(
      [{ owner: driverObjectId, balance: 0, currency: 'NGN' }],
      { session }
    );
    driverWallet = created[0];
  }

  // ── Capture balances before ───────────────────────────────────────────────
  const passengerBalanceBefore = passengerWallet.balance;
  const driverBalanceBefore    = driverWallet.balance;

  // ── Debit passenger ───────────────────────────────────────────────────────
  passengerWallet.balance -= fareKobo;
  await passengerWallet.save({ session });

  // ── Credit driver ─────────────────────────────────────────────────────────
  driverWallet.balance += fareKobo;
  await driverWallet.save({ session });

  // ── Passenger transaction (debit / ride_payment) ──────────────────────────
  // ✅ userId stored as ObjectId — critical for GET /wallet/transactions filter to work
  const [passengerTxn] = await Transaction.create(
    [{
      userId:        passengerObjectId,   // ✅ ObjectId, not string
      type:          'debit',
      amount:        fareKobo,
      description:   `Ride payment — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'}`,
      category:      'ride_payment',
      status:        'completed',
      balanceBefore: passengerBalanceBefore,
      balanceAfter:  passengerWallet.balance,
      metadata: {
        tripId:      tripObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'wallet',
        role:        'passenger',
      },
    }],
    { session }
  );

  // ── Driver transaction (credit / ride_earning) ────────────────────────────
  // ✅ userId stored as ObjectId
  const [driverTxn] = await Transaction.create(
    [{
      userId:                passengerObjectId,  // placeholder — replaced below
      type:                  'credit',
      amount:                fareKobo,
      description:           `Ride earnings — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'} (wallet)`,
      category:              'ride_earning',
      status:                'completed',
      balanceBefore:         driverBalanceBefore,
      balanceAfter:          driverWallet.balance,
      relatedTransactionId:  passengerTxn._id,
      metadata: {
        tripId:      tripObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'wallet',
        role:        'driver',
      },
    }],
    { session }
  );

  // ── Back-link passenger txn to driver txn ─────────────────────────────────
  await Transaction.updateOne(
    { _id: passengerTxn._id },
    { relatedTransactionId: driverTxn._id },
    { session }
  );

  // Fix driver userId — we cannot set it in the create above because of the
  // Mongoose array-create syntax limitation. Update it immediately.
  await Transaction.updateOne(
    { _id: driverTxn._id },
    { userId: driverObjectId },  // ✅ correct driver ObjectId
    { session }
  );

  console.log(`✅ Wallet payment processed | passenger txn: ${passengerTxn._id} | driver txn: ${driverTxn._id}`);
  console.log(`   Passenger balance: ${passengerBalanceBefore} → ${passengerWallet.balance} kobo`);
  console.log(`   Driver balance:    ${driverBalanceBefore}    → ${driverWallet.balance} kobo`);

  return {
    passengerTxn,
    driverTxn,
    driverWallet: {
      balance:          driverWallet.balance,
      balanceNaira:     (driverWallet.balance / 100).toFixed(2),
      balanceFormatted: `₦${(driverWallet.balance / 100).toLocaleString()}`,
    },
  };
}

/**
 * Record earnings for a cash trip — STATS ONLY, no wallet balance change.
 * The driver collected cash physically. We create a Transaction for history
 * but do NOT modify wallet.balance.
 */
async function recordCashTripEarning({ tripId, driverId, fareNaira, serviceType }, session) {
  console.log(`💵 recordCashTripEarning (stats only) | driver: ${driverId} | fare: ₦${fareNaira}`);

  const fareKobo      = Math.round(fareNaira * 100);
  // ✅ Always ObjectId
  const driverObjectId = new mongoose.Types.ObjectId(driverId.toString());
  const tripObjectId   = new mongoose.Types.ObjectId(tripId.toString());

  // Ensure wallet exists (driver may fund wallet later)
  let driverWallet = await Wallet.findOne({ owner: driverObjectId }).session(session);
  if (!driverWallet) {
    console.log(`Creating wallet for driver ${driverId}`);
    const created = await Wallet.create(
      [{ owner: driverObjectId, balance: 0, currency: 'NGN' }],
      { session }
    );
    driverWallet = created[0];
  }

  // ✅ DO NOT modify balance — cash was collected physically
  // Record for earnings history only
  const [driverTxn] = await Transaction.create(
    [{
      userId:        driverObjectId,   // ✅ ObjectId
      type:          'credit',
      amount:        fareKobo,
      description:   `Cash ride earnings — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'}`,
      category:      'ride_earning',
      status:        'completed',
      balanceBefore: driverWallet.balance,  // unchanged
      balanceAfter:  driverWallet.balance,  // unchanged — cash doesn't touch in-app wallet
      metadata: {
        tripId:        tripObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'cash',
        walletCredited: false,  // explicit flag
        role:          'driver',
      },
    }],
    { session }
  );

  console.log(`✅ Cash earning recorded (no wallet change): ${driverTxn._id}`);

  return { driverTxn, driverWallet };
}

module.exports = { processTripWalletPayment, recordCashTripEarning };