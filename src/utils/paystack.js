const crypto = require('crypto');
const config = require('../config');

const PAYSTACK_BASE = 'https://api.paystack.co';

async function initializeTransaction({ amountKobo, email, metadata = {}, reference }) {
  const body = { amount: amountKobo, email, metadata };
  if (reference) body.reference = reference;

  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.paystackSecretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function verifyTransaction(reference) {
  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${config.paystackSecretKey}` }
  });
  return res.json();
}

function verifyWebhookSignature(rawBodyBuffer, signatureHeader) {
  if (!config.paystackSecretKey) return false;
  const hmac = crypto.createHmac('sha512', config.paystackSecretKey);
  hmac.update(rawBodyBuffer);
  const expected = hmac.digest('hex');
  return expected === signatureHeader;
}

async function createTransferRecipient({ type, accountNumber, bankCode, name }) {
  const body = { type, account_number: accountNumber, bank_code: bankCode, name };
  const res = await fetch(`${PAYSTACK_BASE}/transferrecipient`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.paystackSecretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function initiateTransfer({ amountKobo, recipientCode, reference }) {
  const body = { amount: amountKobo, recipient: recipientCode, reference };
  const res = await fetch(`${PAYSTACK_BASE}/transfer`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.paystackSecretKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature, createTransferRecipient, initiateTransfer };
