// api/paypal/capture.js
// Captures a PayPal order and sends a purchase confirmation email.
//
// NOTE: This endpoint handles the frontend-facing capture confirmation only.
// The IPN webhook (/api/webhooks/paypal) handles the actual NFT mint and
// Airtable logging. Airtable writes are intentionally omitted here to prevent
// duplicate Payment records when both capture.js and the IPN webhook fire for
// the same transaction.

import { sendPurchaseConfirmation } from '../_lib/email.js';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const BASE_URL = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

async function getPayPalToken() {
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  return (await r.json()).access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) return res.status(503).json({ error: 'PayPal not configured' });

  const { orderId, customerEmail, passType, customerName } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  try {
    const token = await getPayPalToken();
    const response = await fetch(`${BASE_URL}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const capture = await response.json();
    if (!response.ok || capture.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Capture failed', detail: capture });
    }

    const unit = capture.purchase_units?.[0];
    const capturedPassType = passType || unit?.reference_id || 'UNKNOWN';
    const amount = unit?.payments?.captures?.[0]?.amount?.value;
    const email = customerEmail || unit?.custom_id || '';

    // Send confirmation email directly (IPN webhook handles Airtable + NFT mint)
    if (email) {
      try {
        await sendPurchaseConfirmation({ email, customerName: customerName || '', tier: capturedPassType });
      } catch (err) {
        console.error('[PayPal capture] Confirmation email failed:', err.message);
      }
    }

    return res.status(200).json({ ok: true, status: 'COMPLETED', orderId, passType: capturedPassType, amount });
  } catch (err) {
    return res.status(500).json({ error: 'Capture error', message: err.message });
  }
}
