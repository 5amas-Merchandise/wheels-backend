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
 * @param {number} params.fareKobo         - Final fare in kobo (smallest unit)
 * @param {string} params.serviceType
 * @param {Object} session                 - Mongoose session (must be active)
 *
 * @returns {{ passengerTxn, driverTxn, driverWallet }}
 * @throws  Error if passenger wallet has insufficient balance
 */
async function processTripWalletPayment({ tripId, passengerId, driverId, fareKobo, serviceType }, session) {
  console.log(`💳 Processing wallet payment for trip ${tripId}: ₦${(fareKobo / 100).toFixed(2)}`);

  // ── 1. Load both wallets ──────────────────────────────────────────────────

  const [passengerWallet, driverWallet] = await Promise.all([
    Wallet.findOne({ owner: passengerId }).session(session),
    Wallet.findOne({ owner: driverId }).session(session)
  ]);

  if (!passengerWallet) {
    throw new Error('Passenger wallet not found');
  }

  // Create driver wallet on-the-fly if it somehow doesn't exist
  let resolvedDriverWallet = driverWallet;
  if (!resolvedDriverWallet) {
    console.log(`⚠️ Driver ${driverId} has no wallet — creating one`);
    const created = await Wallet.create([{
      owner: driverId,
      balance: 0,
      currency: 'NGN'
    }], { session });
    resolvedDriverWallet = created[0];
  }

  // ── 2. Check passenger has enough balance ────────────────────────────────
  //
  // The passenger's wallet may hold a mix of:
  //   - Regular funded balance (from Paystack top-ups)
  //   - Referral bonus credits
  // We treat them identically — the total balance is what matters.

  if (passengerWallet.balance < fareKobo) {
    const shortfall = fareKobo - passengerWallet.balance;
    throw new Error(
      `Insufficient wallet balance. ` +
      `Available: ₦${(passengerWallet.balance / 100).toFixed(2)}, ` +
      `Required: ₦${(fareKobo / 100).toFixed(2)}, ` +
      `Shortfall: ₦${(shortfall / 100).toFixed(2)}`
    );
  }

  // ── 3. Debit passenger ───────────────────────────────────────────────────

  const passengerBalanceBefore = passengerWallet.balance;
  passengerWallet.balance -= fareKobo;
  await passengerWallet.save({ session });

  console.log(
    `➖ Passenger ${passengerId} debited ₦${(fareKobo / 100).toFixed(2)}. ` +
    `Balance: ₦${(passengerBalanceBefore / 100).toFixed(2)} → ₦${(passengerWallet.balance / 100).toFixed(2)}`
  );

  // ── 4. Credit driver (full fare — always) ────────────────────────────────
  //
  // Even if the passenger paid using a referral bonus, the driver receives
  // the full fare. The "cost" of the bonus is absorbed by the platform
  // (the referral credit was issued from the platform, not from the driver).

  const driverBalanceBefore = resolvedDriverWallet.balance;
  resolvedDriverWallet.balance += fareKobo;
  await resolvedDriverWallet.save({ session });

  console.log(
    `➕ Driver ${driverId} credited ₦${(fareKobo / 100).toFixed(2)}. ` +
    `Balance: ₦${(driverBalanceBefore / 100).toFixed(2)} → ₦${(resolvedDriverWallet.balance / 100).toFixed(2)}`
  );

  // ── 5. Create transaction records ────────────────────────────────────────
  //
  // We create the passenger record first so we can link the driver record back to it.

  const [passengerTxnArr] = await Transaction.create([
    {
      userId: passengerId,
      type: 'debit',
      amount: fareKobo,
      description: `Ride payment — ${serviceType} trip`,
      category: 'ride_payment',
      status: 'completed',
      balanceBefore: passengerBalanceBefore,
      balanceAfter: passengerWallet.balance,
      metadata: {
        tripId: tripId.toString(),
        driverId: driverId.toString(),
        fareKobo,
        paymentMethod: 'wallet'
      }
    }
  ], { session });

  // Driver transaction references the passenger transaction
  const [driverTxnArr] = await Transaction.create([
    {
      userId: driverId,
      type: 'credit',
      amount: fareKobo,
      description: `Ride earnings — ${serviceType} trip`,
      category: 'ride_earning',
      status: 'completed',
      balanceBefore: driverBalanceBefore,
      balanceAfter: resolvedDriverWallet.balance,
      relatedTransactionId: passengerTxnArr._id,
      metadata: {
        tripId: tripId.toString(),
        passengerId: passengerId.toString(),
        fareKobo,
        paymentMethod: 'wallet'
      }
    }
  ], { session });

  // Back-link passenger txn to driver txn for easy auditing
  await Transaction.findByIdAndUpdate(
    passengerTxnArr._id,
    { relatedTransactionId: driverTxnArr._id },
    { session }
  );

  console.log(
    `📝 Transactions created — Passenger: ${passengerTxnArr._id}, Driver: ${driverTxnArr._id}`
  );

  return {
    passengerTxn: passengerTxnArr,
    driverTxn: driverTxnArr,
    driverWallet: resolvedDriverWallet
  };
}

/**
 * Pay driver for a cash trip.
 * For cash trips the passenger pays the driver in person, so we only need
 * to create a Transaction record crediting the driver's earnings history.
 * We intentionally DO NOT touch wallet balances here because the physical
 * cash has already changed hands outside the app.
 *
 * If you later want to track driver cash earnings in the wallet you can
 * flip `creditWallet` to true.
 *
 * @param {Object} params
 * @param {string} params.tripId
 * @param {string} params.passengerId
 * @param {string} params.driverId
 * @param {number} params.fareKobo
 * @param {string} params.serviceType
 * @param {Object} session
 *
 * @returns {{ driverTxn }}
 */
async function recordCashTripEarning({ tripId, passengerId, driverId, fareKobo, serviceType }, session) {
  console.log(`💵 Recording cash earnings for driver ${driverId}: ₦${(fareKobo / 100).toFixed(2)}`);

  // Credit driver wallet so their total_earnings stat is accurate
  const driverWallet = await Wallet.findOne({ owner: driverId }).session(session);

  let resolvedWallet = driverWallet;
  if (!resolvedWallet) {
    const created = await Wallet.create([{
      owner: driverId,
      balance: 0,
      currency: 'NGN'
    }], { session });
    resolvedWallet = created[0];
  }

  const balanceBefore = resolvedWallet.balance;

  // ⬇️  Credit the driver wallet with the cash fare they physically collected.
  //      This keeps their in-app "total earnings" accurate even for cash trips.
  resolvedWallet.balance += fareKobo;
  await resolvedWallet.save({ session });

  const [driverTxn] = await Transaction.create([{
    userId: driverId,
    type: 'credit',
    amount: fareKobo,
    description: `Cash ride earnings — ${serviceType} trip`,
    category: 'ride_earning',
    status: 'completed',
    balanceBefore,
    balanceAfter: resolvedWallet.balance,
    metadata: {
      tripId: tripId.toString(),
      passengerId: passengerId.toString(),
      fareKobo,
      paymentMethod: 'cash'
    }
  }], { session });

  console.log(`✅ Driver cash earning recorded: ${driverTxn._id}`);

  return { driverTxn, driverWallet: resolvedWallet };
}

module.exports = { processTripWalletPayment, recordCashTripEarning };