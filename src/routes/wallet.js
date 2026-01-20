const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const axios = require('axios');
const User = require('../models/user.model');
const Wallet = require('../models/wallet.model');
const Transaction = require('../models/transaction.model'); // Import directly
const { requireAuth } = require('../middleware/auth');

// Paystack configuration
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

// ==========================================
// ADMIN MANUAL WALLET UPDATE (CREDIT/DEBIT)
// ==========================================

router.post('/admin/update', async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const { driverId, amount, reason, notes, type } = req.body;

      console.log(`💰 Admin manual wallet update:`, { driverId, amount, reason });

      // Validation
      if (!driverId || amount === undefined || !reason) {
        throw new Error('Driver ID, amount, and reason are required');
      }

      if (amount === 0) {
        throw new Error('Amount cannot be zero');
      }

      if (Math.abs(amount) > 1000000) {
        throw new Error('Maximum transaction amount is ₦1,000,000');
      }

      if (!mongoose.Types.ObjectId.isValid(driverId)) {
        throw new Error('Invalid Driver ID format');
      }

      // Determine transaction type
      const transactionType = type || (amount > 0 ? 'credit' : 'debit');
      const isCredit = transactionType === 'credit';
      const absoluteAmount = Math.abs(amount);

      // Verify driver exists
      const driver = await User.findById(driverId)
        .select('name phone email roles')
        .session(session);

      if (!driver) {
        throw new Error('Driver not found');
      }

      console.log(`✅ Driver: ${driver.name}`);

      // Convert to kobo
      const amountKobo = Math.round(absoluteAmount * 100);

      // Get or create wallet using atomic upsert
      let wallet = await Wallet.findOneAndUpdate(
        { owner: driverId },
        { $setOnInsert: { owner: driverId, balance: 0, currency: 'NGN' } },
        { new: true, upsert: true, session }
      );

      const balanceBefore = wallet.balance;

      // Update wallet balance
      if (isCredit) {
        wallet.balance += amountKobo;
      } else {
        if (wallet.balance < amountKobo) {
          throw new Error(`Insufficient balance. Available: ₦${(wallet.balance / 100).toLocaleString()}, Required: ₦${absoluteAmount.toLocaleString()}`);
        }
        wallet.balance -= amountKobo;
      }
      
      await wallet.save({ session });

      console.log(`✅ Wallet ${transactionType}ed: ₦${absoluteAmount}`);

      // Determine category based on transaction type and reason
      let category = 'other';
      if (transactionType === 'credit' && reason.toLowerCase().includes('admin')) {
        category = 'admin_credit';
      } else if (transactionType === 'debit' && reason.toLowerCase().includes('admin')) {
        category = 'admin_debit';
      } else if (reason.toLowerCase().includes('bonus')) {
        category = 'bonus';
      } else if (reason.toLowerCase().includes('refund')) {
        category = 'refund';
      }

      // Create transaction record
      const transaction = await Transaction.create([{
        userId: driverId,
        type: transactionType,
        amount: amountKobo,
        description: `Admin ${transactionType}: ${reason}`,
        category: category,
        status: 'completed',
        balanceBefore,
        balanceAfter: wallet.balance,
        metadata: {
          adminManual: true,
          reason,
          notes: notes || '',
          driverName: driver.name,
          driverPhone: driver.phone,
          amountNaira: absoluteAmount
        }
      }], { session });

      console.log(`📝 Transaction created: ${transaction[0]._id}`);

      res.json({
        success: true,
        message: `Wallet ${transactionType}ed successfully`,
        data: {
          driverId,
          driverName: driver.name,
          transactionType,
          amount: absoluteAmount,
          amountFormatted: `₦${absoluteAmount.toLocaleString()}`,
          previousBalance: balanceBefore / 100,
          previousBalanceFormatted: `₦${(balanceBefore / 100).toLocaleString()}`,
          newBalance: wallet.balance / 100,
          newBalanceFormatted: `₦${(wallet.balance / 100).toLocaleString()}`,
          transactionId: transaction[0]._id,
          reason,
          notes: notes || ''
        }
      });
    });

  } catch (error) {
    console.error('❌ Admin update error:', error.message);

    let statusCode = 500;
    let errorCode = 'WALLET_UPDATE_FAILED';

    if (error.message.includes('required') || error.message.includes('cannot be zero')) {
      statusCode = 400;
      errorCode = 'INVALID_REQUEST';
    } else if (error.message.includes('not found') || error.message.includes('Invalid Driver ID')) {
      statusCode = 404;
      errorCode = 'DRIVER_NOT_FOUND';
    } else if (error.message.includes('Insufficient balance')) {
      statusCode = 400;
      errorCode = 'INSUFFICIENT_BALANCE';
    } else if (error.message.includes('Maximum transaction amount')) {
      statusCode = 400;
      errorCode = 'AMOUNT_EXCEEDED';
    }

    res.status(statusCode).json({
      success: false,
      error: {
        message: error.message,
        code: errorCode
      }
    });

  } finally {
    await session.endSession();
  }
});

// ==========================================
// GET /wallet - GET WALLET BALANCE
// ==========================================

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    // Use atomic upsert to ensure wallet exists
    let wallet = await Wallet.findOneAndUpdate(
      { owner: userId },
      { $setOnInsert: { owner: userId, balance: 0, currency: 'NGN' } },
      { new: true, upsert: true }
    ).lean();

    res.json({
      success: true,
      wallet: {
        id: wallet._id,
        balance: wallet.balance,
        balanceNaira: (wallet.balance / 100).toFixed(2),
        balanceFormatted: `₦${(wallet.balance / 100).toLocaleString()}`,
        currency: wallet.currency,
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
        lastUpdated: wallet.updatedAt
      }
    });

  } catch (err) {
    console.error('Get wallet error:', err);
    next(err);
  }
});

// ==========================================
// POST /wallet/fund/initialize - INITIALIZE FUNDING
// ==========================================

router.post('/fund/initialize', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { amount, email } = req.body;

    console.log(`💰 Initializing wallet funding for user ${userId}`);

    // Validation
    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        error: { 
          message: 'Minimum funding amount is ₦100',
          code: 'MIN_AMOUNT_REQUIRED'
        }
      });
    }

    if (amount > 1000000) {
      return res.status(400).json({
        success: false,
        error: { 
          message: 'Maximum funding amount is ₦1,000,000',
          code: 'MAX_AMOUNT_EXCEEDED'
        }
      });
    }

    if (!email) {
      return res.status(400).json({
        success: false,
        error: { 
          message: 'Email is required',
          code: 'EMAIL_REQUIRED'
        }
      });
    }

    // Get user
    const user = await User.findById(userId).select('name phone email');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { 
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        }
      });
    }

    // Generate reference
    const reference = `wallet_fund_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Amount in kobo
    const amountKobo = Math.round(amount * 100);

    // Create pending transaction
    const transaction = await Transaction.create({
      userId,
      type: 'deposit',
      amount: amountKobo,
      description: `Wallet funding - ₦${amount.toLocaleString()}`,
      category: 'wallet_funding',
      status: 'pending',
      paymentGateway: 'paystack',
      paymentReference: reference,
      metadata: {
        email,
        amountNaira: amount,
        userId: userId.toString()
      }
    });

    console.log(`📝 Pending transaction created: ${transaction._id}`);

    // Initialize Paystack
    try {
      const paystackResponse = await axios.post(
        `${PAYSTACK_BASE_URL}/transaction/initialize`,
        {
          email,
          amount: amountKobo,
          reference,
          callback_url: `${process.env.FRONTEND_URL}/wallet/funding-callback`,
          metadata: {
            userId,
            transactionId: transaction._id.toString(),
            purpose: 'wallet_funding'
          }
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!paystackResponse.data.status) {
        throw new Error('Paystack initialization failed');
      }

      const { authorization_url, access_code } = paystackResponse.data.data;

      // Update transaction
      transaction.metadata.paystackAccessCode = access_code;
      transaction.metadata.authorizationUrl = authorization_url;
      await transaction.save();

      console.log(`✅ Paystack initialized successfully: ${reference}`);

      res.json({
        success: true,
        message: 'Payment initialized successfully',
        data: {
          authorizationUrl: authorization_url,
          accessCode: access_code,
          reference,
          amount: amount,
          amountFormatted: `₦${amount.toLocaleString()}`,
          transactionId: transaction._id,
          email
        }
      });

    } catch (paystackError) {
      console.error('❌ Paystack error:', paystackError.message);

      // Update transaction as failed
      transaction.status = 'failed';
      transaction.metadata.error = paystackError.message;
      await transaction.save();

      return res.status(500).json({
        success: false,
        error: { 
          message: 'Payment initialization failed',
          code: 'PAYSTACK_INIT_FAILED',
          details: paystackError.message
        }
      });
    }

  } catch (err) {
    console.error('Initialize funding error:', err);
    next(err);
  }
});

// ==========================================
// POST /wallet/fund/verify - VERIFY FUNDING
// ==========================================

router.post('/fund/verify', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const userId = req.user.sub;
      const { reference } = req.body;

      console.log(`🔍 Verifying payment: ${reference}`);

      if (!reference) {
        throw new Error('Payment reference is required');
      }

      // Find pending transaction
      const transaction = await Transaction.findOne({
        userId,
        paymentReference: reference,
        status: 'pending'
      }).session(session);

      if (!transaction) {
        throw new Error('Transaction not found or already processed');
      }

      // Verify with Paystack
      try {
        const verifyResponse = await axios.get(
          `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
          {
            headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
            }
          }
        );

        if (!verifyResponse.data.status) {
          throw new Error('Paystack verification failed');
        }

        const paymentData = verifyResponse.data.data;

        if (paymentData.status !== 'success') {
          throw new Error(`Payment not successful. Status: ${paymentData.status}`);
        }

        console.log(`✅ Paystack verification successful for reference: ${reference}`);

        // Get or create wallet
        let wallet = await Wallet.findOne({ owner: userId }).session(session);
        if (!wallet) {
          wallet = await Wallet.create([{
            owner: userId,
            balance: 0,
            currency: 'NGN'
          }], { session });
          wallet = wallet[0];
        }

        const balanceBefore = wallet.balance;
        const amountKobo = paymentData.amount;

        // Credit wallet
        wallet.balance += amountKobo;
        await wallet.save({ session });

        // Update transaction
        transaction.status = 'completed';
        transaction.balanceBefore = balanceBefore;
        transaction.balanceAfter = wallet.balance;
        transaction.metadata.paystackData = {
          amount: paymentData.amount,
          currency: paymentData.currency,
          paidAt: paymentData.paid_at,
          channel: paymentData.channel,
          gatewayResponse: paymentData.gateway_response
        };
        await transaction.save({ session });

        console.log(`💰 Wallet credited successfully: ₦${amountKobo / 100}`);

        res.json({
          success: true,
          message: 'Wallet funded successfully',
          data: {
            transaction: {
              id: transaction._id,
              amount: amountKobo / 100,
              amountFormatted: `₦${(amountKobo / 100).toLocaleString()}`,
              reference,
              status: 'completed'
            },
            wallet: {
              balance: wallet.balance,
              balanceNaira: (wallet.balance / 100).toFixed(2),
              balanceFormatted: `₦${(wallet.balance / 100).toLocaleString()}`
            }
          }
        });

      } catch (paystackError) {
        console.error('❌ Paystack verification error:', paystackError.message);

        // Mark transaction as failed
        transaction.status = 'failed';
        transaction.metadata.verificationError = paystackError.message;
        await transaction.save({ session });

        throw new Error(`Payment verification failed: ${paystackError.message}`);
      }
    });

  } catch (error) {
    console.error('❌ Verify funding error:', error.message);

    let statusCode = 500;
    let errorCode = 'VERIFICATION_FAILED';

    if (error.message.includes('not found') || error.message.includes('already processed')) {
      statusCode = 404;
      errorCode = 'TRANSACTION_NOT_FOUND';
    } else if (error.message.includes('required')) {
      statusCode = 400;
      errorCode = 'INVALID_REQUEST';
    } else if (error.message.includes('not successful')) {
      statusCode = 400;
      errorCode = 'PAYMENT_NOT_SUCCESSFUL';
    }

    res.status(statusCode).json({
      success: false,
      error: {
        message: error.message,
        code: errorCode
      }
    });

  } finally {
    await session.endSession();
  }
});

// ==========================================
// POST /wallet/webhook - PAYSTACK WEBHOOK
// ==========================================

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  
  try {
    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }

    event = req.body;

    console.log(`📨 Webhook event received: ${event.event}`);

    if (event.event === 'charge.success') {
      const data = event.data;
      const reference = data.reference;

      console.log(`✅ Payment success via webhook: ${reference}`);

      // Find pending transaction
      const transaction = await Transaction.findOne({
        paymentReference: reference,
        status: 'pending'
      });

      if (!transaction) {
        console.log(`ℹ️ Transaction not found or already processed: ${reference}`);
        return res.status(200).json({ received: true });
      }

      const session = await mongoose.startSession();
      
      try {
        await session.withTransaction(async () => {
          // Get wallet
          let wallet = await Wallet.findOne({ owner: transaction.userId }).session(session);
          if (!wallet) {
            wallet = await Wallet.create([{
              owner: transaction.userId,
              balance: 0,
              currency: 'NGN'
            }], { session });
            wallet = wallet[0];
          }

          const balanceBefore = wallet.balance;
          const amountKobo = data.amount;

          // Credit wallet
          wallet.balance += amountKobo;
          await wallet.save({ session });

          // Update transaction
          transaction.status = 'completed';
          transaction.balanceBefore = balanceBefore;
          transaction.balanceAfter = wallet.balance;
          transaction.metadata.paystackData = {
            amount: data.amount,
            currency: data.currency,
            paidAt: data.paid_at,
            channel: data.channel,
            gatewayResponse: data.gateway_response,
            webhookProcessed: true
          };
          await transaction.save({ session });

          console.log(`💰 Wallet credited via webhook: ₦${amountKobo / 100} for user ${transaction.userId}`);
        });

        await session.endSession();

      } catch (err) {
        await session.endSession();
        console.error('❌ Webhook processing error:', err);
      }
    } else if (event.event === 'transfer.success') {
      console.log(`✅ Transfer successful: ${event.data.reference}`);
    } else {
      console.log(`ℹ️ Webhook event received but not handled: ${event.event}`);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GET /wallet/transactions - GET TRANSACTION HISTORY
// ==========================================

router.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { 
      limit = 20, 
      offset = 0,
      type = 'all',
      status = 'all',
      startDate,
      endDate
    } = req.query;

    const parsedLimit = Math.min(parseInt(limit), 100);
    const parsedOffset = parseInt(offset) || 0;

    const filter = { userId };
    
    if (type !== 'all') {
      filter.type = type;
    }
    
    if (status !== 'all') {
      filter.status = status;
    }
    
    // Date filtering
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(parsedLimit)
      .skip(parsedOffset)
      .lean();

    const total = await Transaction.countDocuments(filter);

    const formattedTransactions = transactions.map(txn => ({
      id: txn._id,
      type: txn.type,
      amount: txn.amount / 100,
      amountFormatted: `₦${(txn.amount / 100).toLocaleString()}`,
      description: txn.description,
      category: txn.category,
      status: txn.status,
      balanceBefore: txn.balanceBefore ? txn.balanceBefore / 100 : null,
      balanceAfter: txn.balanceAfter ? txn.balanceAfter / 100 : null,
      createdAt: txn.createdAt,
      updatedAt: txn.updatedAt,
      reference: txn.paymentReference,
      metadata: txn.metadata || {}
    }));

    res.json({
      success: true,
      data: {
        transactions: formattedTransactions,
        pagination: {
          total,
          limit: parsedLimit,
          offset: parsedOffset,
          hasMore: total > parsedOffset + parsedLimit
        }
      }
    });

  } catch (err) {
    console.error('Get transactions error:', err);
    next(err);
  }
});

// ==========================================
// GET /wallet/transactions/:id - GET SINGLE TRANSACTION
// ==========================================

router.get('/transactions/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const transactionId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Invalid transaction ID' }
      });
    }

    const transaction = await Transaction.findOne({
      _id: transactionId,
      userId
    }).lean();

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: { message: 'Transaction not found' }
      });
    }

    const formattedTransaction = {
      id: transaction._id,
      type: transaction.type,
      amount: transaction.amount / 100,
      amountFormatted: `₦${(transaction.amount / 100).toLocaleString()}`,
      description: transaction.description,
      category: transaction.category,
      status: transaction.status,
      balanceBefore: transaction.balanceBefore ? transaction.balanceBefore / 100 : null,
      balanceAfter: transaction.balanceAfter ? transaction.balanceAfter / 100 : null,
      paymentGateway: transaction.paymentGateway,
      paymentReference: transaction.paymentReference,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
      metadata: transaction.metadata || {}
    };

    res.json({
      success: true,
      data: formattedTransaction
    });

  } catch (err) {
    console.error('Get transaction error:', err);
    next(err);
  }
});

// ==========================================
// DEBUG ENDPOINT: Get list of drivers for testing
// ==========================================

router.get('/admin/debug/drivers', async (req, res) => {
  try {
    console.log('🔍 Looking for drivers...');
    
    let drivers = await User.find({ 'roles.isDriver': true })
      .select('_id name email phone roles createdAt')
      .limit(20)
      .lean();

    if (drivers.length === 0) {
      console.log('⚠️ No drivers found, getting all users...');
      drivers = await User.find()
        .select('_id name email phone roles createdAt')
        .limit(10)
        .lean();
    }

    console.log(`✅ Found ${drivers.length} users`);

    res.json({
      success: true,
      count: drivers.length,
      drivers: drivers.map(d => ({
        id: d._id,
        name: d.name,
        email: d.email || 'No email',
        phone: d.phone || 'No phone',
        isDriver: d.roles?.isDriver || false,
        isAdmin: d.roles?.isAdmin || false,
        createdAt: d.createdAt
      }))
    });
  } catch (error) {
    console.error('Error getting drivers:', error);
    res.status(500).json({
      success: false,
      error: { 
        message: error.message,
        stack: error.stack 
      }
    });
  }
});

// ==========================================
// DEBUG ENDPOINT: Get Transaction Schema Info
// ==========================================

router.get('/admin/debug/schema', async (req, res) => {
  try {
    const schema = Transaction.schema;
    
    res.json({
      success: true,
      data: {
        transactionSchema: {
          type: {
            enumValues: schema.path('type').enumValues,
            required: schema.path('type').isRequired
          },
          status: {
            enumValues: schema.path('status').enumValues,
            default: schema.path('status').defaultValue
          },
          category: {
            enumValues: schema.path('category').enumValues,
            default: schema.path('category').defaultValue
          }
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message }
    });
  }
});

// ==========================================
// DEBUG ENDPOINT: Check if user has wallet
// ==========================================

router.get('/admin/debug/wallet/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Invalid user ID' }
      });
    }

    const user = await User.findById(userId).select('name email phone');
    const wallet = await Wallet.findOne({ owner: userId });
    const transactions = await Transaction.find({ userId }).limit(5).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        user: user || { message: 'User not found' },
        wallet: wallet || { message: 'No wallet found' },
        recentTransactions: transactions.map(t => ({
          id: t._id,
          type: t.type,
          amount: t.amount / 100,
          status: t.status,
          description: t.description,
          createdAt: t.createdAt
        }))
      }
    });

  } catch (error) {
    console.error('Debug wallet error:', error);
    res.status(500).json({
      success: false,
      error: { message: error.message }
    });
  }
});

module.exports = router;