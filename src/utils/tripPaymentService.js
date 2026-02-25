// utils/tripPaymentService.js
//
// ══════════════════════════════════════════════════════════════════════════════
//  UNIT CONVENTION (applies to every function in this file)
//
//  • Trip.estimatedFare / Trip.finalFare  → stored in NAIRA  (frontend sends naira)
//  • Wallet.balance                        → stored in KOBO   (Paystack convention)
//  • All *Naira params received here are converted to kobo internally.
//  • All wallet reads/writes use kobo.
// ══════════════════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const Wallet      = require('../models/wallet.model');
const Transaction = require('../models/transaction.model');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — find or create a wallet (session-safe)
// ─────────────────────────────────────────────────────────────────────────────
async function _findOrCreateWallet(ownerObjectId, session) {
  let wallet = await Wallet.findOne({ owner: ownerObjectId }).session(session);
  if (!wallet) {
    console.log(`🆕 Creating wallet for ${ownerObjectId}`);
    const [created] = await Wallet.create(
      [{ owner: ownerObjectId, balance: 0, currency: 'NGN' }],
      { session }
    );
    wallet = created;
  }
  return wallet;
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. processTripWalletPayment
//     Passenger wallet  →  driver wallet  (wallet-to-wallet paid trip)
// ═════════════════════════════════════════════════════════════════════════════
async function processTripWalletPayment(
  { tripId, passengerId, driverId, fareNaira, serviceType },
  session
) {
  console.log(`💳 processTripWalletPayment | trip: ${tripId} | fare: ₦${fareNaira}`);

  const fareKobo = Math.round(fareNaira * 100);

  const passengerObjectId = new mongoose.Types.ObjectId(passengerId.toString());
  const driverObjectId    = new mongoose.Types.ObjectId(driverId.toString());
  const tripObjectId      = new mongoose.Types.ObjectId(tripId.toString());

  // ── Wallets ───────────────────────────────────────────────────────────────
  const passengerWallet = await Wallet.findOne({ owner: passengerObjectId }).session(session);
  if (!passengerWallet) throw new Error('Passenger wallet not found');
  if (passengerWallet.balance < fareKobo) {
    throw new Error(
      `Insufficient passenger balance. ` +
      `Available: ₦${(passengerWallet.balance / 100).toFixed(2)}, ` +
      `Required: ₦${fareNaira.toFixed(2)}`
    );
  }

  const driverWallet = await _findOrCreateWallet(driverObjectId, session);

  // ── Snapshots ─────────────────────────────────────────────────────────────
  const passengerBalanceBefore = passengerWallet.balance;
  const driverBalanceBefore    = driverWallet.balance;

  // ── Debit passenger / credit driver ───────────────────────────────────────
  passengerWallet.balance -= fareKobo;
  await passengerWallet.save({ session });

  driverWallet.balance += fareKobo;
  await driverWallet.save({ session });

  // ── Passenger transaction ─────────────────────────────────────────────────
  const [passengerTxn] = await Transaction.create(
    [{
      userId:        passengerObjectId,
      type:          'debit',
      amount:        fareKobo,
      description:   `Ride payment — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'}`,
      category:      'ride_payment',
      status:        'completed',
      balanceBefore: passengerBalanceBefore,
      balanceAfter:  passengerWallet.balance,
      metadata: {
        tripId:        tripObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'wallet',
        role:          'passenger',
      },
    }],
    { session }
  );

  // ── Driver transaction ────────────────────────────────────────────────────
  const [driverTxn] = await Transaction.create(
    [{
      userId:               driverObjectId,
      type:                 'credit',
      amount:               fareKobo,
      description:          `Ride earnings — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'} (wallet)`,
      category:             'ride_earning',
      status:               'completed',
      balanceBefore:        driverBalanceBefore,
      balanceAfter:         driverWallet.balance,
      relatedTransactionId: passengerTxn._id,
      metadata: {
        tripId:        tripObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'wallet',
        role:          'driver',
      },
    }],
    { session }
  );

  // Back-link passenger txn to driver txn
  await Transaction.updateOne(
    { _id: passengerTxn._id },
    { relatedTransactionId: driverTxn._id },
    { session }
  );

  console.log(`✅ Wallet payment | passenger txn: ${passengerTxn._id} | driver txn: ${driverTxn._id}`);
  console.log(`   Passenger: ${passengerBalanceBefore} → ${passengerWallet.balance} kobo`);
  console.log(`   Driver:    ${driverBalanceBefore} → ${driverWallet.balance} kobo`);

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

// ═════════════════════════════════════════════════════════════════════════════
//  2. recordCashTripEarning
//     Cash trip — stats only, no wallet balance change for passenger.
//     Driver collected cash physically.
// ═════════════════════════════════════════════════════════════════════════════
async function recordCashTripEarning(
  { tripId, driverId, fareNaira, serviceType },
  session
) {
  console.log(`💵 recordCashTripEarning (stats only) | driver: ${driverId} | fare: ₦${fareNaira}`);

  const fareKobo       = Math.round(fareNaira * 100);
  const driverObjectId = new mongoose.Types.ObjectId(driverId.toString());
  const tripObjectId   = new mongoose.Types.ObjectId(tripId.toString());

  const driverWallet = await _findOrCreateWallet(driverObjectId, session);

  // ✅ DO NOT modify balance — cash collected physically
  const [driverTxn] = await Transaction.create(
    [{
      userId:        driverObjectId,
      type:          'credit',
      amount:        fareKobo,
      description:   `Cash ride earnings — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'}`,
      category:      'ride_earning',
      status:        'completed',
      balanceBefore: driverWallet.balance,  // unchanged
      balanceAfter:  driverWallet.balance,  // unchanged
      metadata: {
        tripId:         tripObjectId,
        fareNaira,
        serviceType,
        paymentMethod:  'cash',
        walletCredited: false,
        role:           'driver',
      },
    }],
    { session }
  );

  console.log(`✅ Cash earning recorded (no wallet change): ${driverTxn._id}`);
  return { driverTxn, driverWallet };
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. processFreeRideLoyaltyPayment
//
//  Called when a FREE RIDE (Kilometre Club redemption) completes.
//
//  What it does:
//    • Passenger pays ₦0  — nothing debited.
//    • Driver wallet      — credited fareKobo (direct platform credit).
//    • One Transaction record created for the driver:
//        - category: 'loyalty_earning'   ✅ now in Transaction enum
//        - paymentMethod: 'free_ride'
//
//  ✅ BUG 2 FIX:
//    The old code used category: 'loyalty_earning' which was NOT in the
//    Transaction model's category enum. This caused Transaction.create() to
//    throw a Mongoose validation error every time a free ride completed.
//    That error was caught silently by the complete route's try/catch, so
//    resolvedPaymentMethod was set to 'free_ride_pending' and the driver
//    never received their wallet credit.
//
//    Fix: added 'loyalty_earning' to the Transaction model category enum.
//    This function is otherwise unchanged — it was always correct in intent.
//
//  Returns: { driverTxn, driverWallet }
// ═════════════════════════════════════════════════════════════════════════════
async function processFreeRideLoyaltyPayment(
  { tripId, passengerId, driverId, fareNaira, serviceType },
  session
) {
  console.log(`🎁 processFreeRideLoyaltyPayment START`);
  console.log(`   trip: ${tripId} | driver: ${driverId} | fare: ₦${fareNaira}`);

  // ✅ Validate inputs explicitly so we get clear errors instead of silent failures
  if (!tripId)      throw new Error('processFreeRideLoyaltyPayment: tripId is required');
  if (!driverId)    throw new Error('processFreeRideLoyaltyPayment: driverId is required');
  if (!passengerId) throw new Error('processFreeRideLoyaltyPayment: passengerId is required');
  if (!fareNaira || fareNaira <= 0) {
    throw new Error(`processFreeRideLoyaltyPayment: invalid fareNaira (${fareNaira})`);
  }

  const fareKobo = Math.round(fareNaira * 100);

  const driverObjectId    = new mongoose.Types.ObjectId(driverId.toString());
  const passengerObjectId = new mongoose.Types.ObjectId(passengerId.toString());
  const tripObjectId      = new mongoose.Types.ObjectId(tripId.toString());

  // ── Driver wallet (create if not exists) ──────────────────────────────────
  const driverWallet = await _findOrCreateWallet(driverObjectId, session);

  // ── Snapshot before ───────────────────────────────────────────────────────
  const driverBalanceBefore = driverWallet.balance;

  // ── Credit driver ─────────────────────────────────────────────────────────
  driverWallet.balance += fareKobo;
  await driverWallet.save({ session });

  console.log(`   Driver wallet: ${driverBalanceBefore} → ${driverWallet.balance} kobo`);

  // ── Driver credit transaction ─────────────────────────────────────────────
  // ✅ BUG 2 FIX: category is now 'loyalty_earning' which exists in the enum
  const [driverTxn] = await Transaction.create(
    [{
      userId:        driverObjectId,
      type:          'credit',
      amount:        fareKobo,
      description:   `Kilometre Club earnings — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'} (free ride)`,
      category:      'loyalty_earning',   // ✅ now valid — added to Transaction enum
      status:        'completed',
      balanceBefore: driverBalanceBefore,
      balanceAfter:  driverWallet.balance,
      metadata: {
        tripId:        tripObjectId,
        passengerId:   passengerObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'free_ride',
        role:          'driver',
        programme:     'kilometre_club',
        loyaltyPaid:   true,
      },
    }],
    { session }
  );

  console.log(`✅ processFreeRideLoyaltyPayment COMPLETE`);
  console.log(`   Driver txn: ${driverTxn._id} | credited: ₦${fareNaira}`);

  return {
    driverTxn,
    driverWallet: {
      balance:          driverWallet.balance,
      balanceNaira:     (driverWallet.balance / 100).toFixed(2),
      balanceFormatted: `₦${(driverWallet.balance / 100).toLocaleString()}`,
    },
  };
}

module.exports = {
  processTripWalletPayment,
  recordCashTripEarning,
  processFreeRideLoyaltyPayment,
};