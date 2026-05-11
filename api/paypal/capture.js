// api/paypal/capture.js
// Captures a PayPal order and triggers email + Airtable logging
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const BASE_URL = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SITE_URL = process.env.NEXT_PUBLIC_URL || 'https://aurevon-site.vercel.app';

async function getPayPalToken() {
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  return (await r.json()).access_token;
}

async function logToAirtable(data) {
  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID) return;
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Payments`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields: { ...data } }] })
  });
}

async function sendConfirmationEmail(email, passType, name) {
  await fetch(`${SITE_URL}/api/email/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email, passType, customerName: name, portalLink: `${SITE_URL}/portal.html` })
  });
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

    // Log to Airtable
    await logToAirtable({
      'Payment Provider': 'PayPal',
      'Order ID': orderId,
      'Pass Type': capturedPassType,
      'Amount': parseFloat(amount) || 0,
      'Customer Email': email,
      'Customer Name': customerName || '',
      'Status': 'Completed',
      'Timestamp': new Date().toISOString()
    });

    // Send confirmation email
    if (email) await sendConfirmationEmail(email, capturedPassType, customerName);

    return res.status(200).json({ ok: true, status: 'COMPLETED', orderId, passType: capturedPassType, amount });
  } catch (err) {
    return res.status(500).json({ error: 'Capture error', message: err.message });
  }
}
