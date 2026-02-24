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

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — find the system wallet (the platform's own wallet that pays drivers
//           on free rides). The system wallet owner is identified by the env
//           var SYSTEM_WALLET_OWNER_ID — set this to your platform's admin
//           User._id in .env.
//
//           If the env var is missing we throw clearly so it's obvious in dev.
// ─────────────────────────────────────────────────────────────────────────────
async function _getSystemWallet(session) {
  const systemOwnerId = process.env.SYSTEM_WALLET_OWNER_ID;
  if (!systemOwnerId) {
    throw new Error(
      'SYSTEM_WALLET_OWNER_ID env var is not set. ' +
      'Add it to your .env pointing to the platform admin User._id.'
    );
  }

  const systemOwnerObjectId = new mongoose.Types.ObjectId(systemOwnerId);
  const wallet = await Wallet.findOne({ owner: systemOwnerObjectId }).session(session);

  if (!wallet) {
    throw new Error(
      `System wallet not found for owner ${systemOwnerId}. ` +
      'Make sure the platform admin has a funded wallet.'
    );
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
      userId:               passengerObjectId, // placeholder — corrected below
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

  // Back-link + fix driver userId
  await Transaction.updateOne(
    { _id: passengerTxn._id },
    { relatedTransactionId: driverTxn._id },
    { session }
  );
  await Transaction.updateOne(
    { _id: driverTxn._id },
    { userId: driverObjectId },
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
//  3. processFreeRideLoyaltyPayment   ✨ NEW ✨
//
//  Called when a FREE RIDE (Kilometre Club redemption) completes.
//
//  What it does:
//    • Passenger pays ₦0  — nothing debited from their wallet.
//    • System wallet      — debited fareKobo.
//    • Driver wallet      — credited fareKobo.
//    • Two Transaction records created:
//        ① system debit  — category: 'loyalty_payout'
//        ② driver credit — category: 'loyalty_earning'
//
//  Prerequisites:
//    • SYSTEM_WALLET_OWNER_ID env var must point to the platform admin User._id.
//    • That admin user must have a funded Wallet document.
//    • Call this inside a mongoose session (same transaction as trip completion).
//
//  Returns: { systemTxn, driverTxn, driverWallet }
// ═════════════════════════════════════════════════════════════════════════════
async function processFreeRideLoyaltyPayment(
  { tripId, passengerId, driverId, fareNaira, serviceType },
  session
) {
  console.log(`🎁 processFreeRideLoyaltyPayment | trip: ${tripId} | driver: ${driverId} | fare: ₦${fareNaira}`);

  const fareKobo = Math.round(fareNaira * 100);

  const driverObjectId    = new mongoose.Types.ObjectId(driverId.toString());
  const passengerObjectId = new mongoose.Types.ObjectId(passengerId.toString());
  const tripObjectId      = new mongoose.Types.ObjectId(tripId.toString());

  // ── System wallet ─────────────────────────────────────────────────────────
  const systemWallet = await _getSystemWallet(session);

  if (systemWallet.balance < fareKobo) {
    // Non-fatal degradation: log loudly, mark trip for manual review,
    // but don't crash the trip completion flow.
    console.error(
      `🚨 SYSTEM WALLET INSUFFICIENT for free ride payout! ` +
      `Required: ₦${fareNaira} (${fareKobo} kobo) | ` +
      `Available: ${systemWallet.balance} kobo. ` +
      `Trip ${tripId} driver payout PENDING MANUAL REVIEW.`
    );
    throw new Error(
      `System wallet has insufficient funds to pay driver for free ride. ` +
      `Required: ₦${fareNaira.toLocaleString()}. Please top up the system wallet.`
    );
  }

  // ── Driver wallet ─────────────────────────────────────────────────────────
  const driverWallet = await _findOrCreateWallet(driverObjectId, session);

  // ── Snapshots before ─────────────────────────────────────────────────────
  const systemBalanceBefore = systemWallet.balance;
  const driverBalanceBefore = driverWallet.balance;

  // ── Debit system / credit driver ─────────────────────────────────────────
  systemWallet.balance -= fareKobo;
  await systemWallet.save({ session });

  driverWallet.balance += fareKobo;
  await driverWallet.save({ session });

  // ── System debit transaction ──────────────────────────────────────────────
  const systemOwnerObjectId = new mongoose.Types.ObjectId(
    process.env.SYSTEM_WALLET_OWNER_ID
  );

  const [systemTxn] = await Transaction.create(
    [{
      userId:        systemOwnerObjectId,
      type:          'debit',
      amount:        fareKobo,
      description:   `Kilometre Club payout — free ride for passenger`,
      category:      'loyalty_payout',
      status:        'completed',
      balanceBefore: systemBalanceBefore,
      balanceAfter:  systemWallet.balance,
      metadata: {
        tripId:        tripObjectId,
        passengerId:   passengerObjectId,
        driverId:      driverObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'free_ride',
        role:          'system',
        programme:     'kilometre_club',
      },
    }],
    { session }
  );

  // ── Driver credit transaction ─────────────────────────────────────────────
  const [driverTxn] = await Transaction.create(
    [{
      userId:               driverObjectId,
      type:                 'credit',
      amount:               fareKobo,
      description:          `Kilometre Club earnings — ${serviceType ? serviceType.replace(/_/g, ' ') : 'trip'} (free ride)`,
      category:             'loyalty_earning',
      status:               'completed',
      balanceBefore:        driverBalanceBefore,
      balanceAfter:         driverWallet.balance,
      relatedTransactionId: systemTxn._id,
      metadata: {
        tripId:        tripObjectId,
        passengerId:   passengerObjectId,
        fareNaira,
        serviceType,
        paymentMethod: 'free_ride',
        role:          'driver',
        programme:     'kilometre_club',
        // Important flag: driver earned this from a loyalty free ride,
        // NOT from a passenger wallet or cash payment
        loyaltyPaid:   true,
      },
    }],
    { session }
  );

  // Back-link system txn → driver txn
  await Transaction.updateOne(
    { _id: systemTxn._id },
    { relatedTransactionId: driverTxn._id },
    { session }
  );

  console.log(`✅ Free ride payout complete`);
  console.log(`   System wallet:  ${systemBalanceBefore} → ${systemWallet.balance} kobo`);
  console.log(`   Driver wallet:  ${driverBalanceBefore} → ${driverWallet.balance} kobo`);
  console.log(`   System txn: ${systemTxn._id} | Driver txn: ${driverTxn._id}`);

  return {
    systemTxn,
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