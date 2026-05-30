// api/paypal/index.js
// Consolidated PayPal handler — dispatches via ?action=create-order|capture
// Routes: POST /api/paypal/create-order  → ?action=create-order
//         POST /api/paypal/capture       → ?action=capture

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const BASE_URL = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SITE_URL = process.env.DOMAIN || 'https://www.aurevonvc.com';

const PASS_PRICES = {
  OBSIDIAN: { amount: '2499.00', description: 'Aurevon OBSIDIAN EXECUTIVE Pass - Enterprise RE Tier 3' },
  EMBER:    { amount: '1499.00', description: 'Aurevon EMBER Pass - RE Tier 2' },
  INSIDER:  { amount: '250.00',  description: 'Aurevon INSIDER Pass - RE Tier 1' },
  CHROME:   { amount: '349.99',  description: 'Aurevon CHROME Pass - Lifetime Community' },
  GENESIS:  { amount: '500.00',  description: 'Aurevon GENESIS Founder Pass - All Access Lifetime' },
  COMMUNITY:{ amount: '29.99',   description: 'Aurevon GENESIS COMMUNITY Pass - Monthly' },
  // À La Carte add-ons (no NFT) — mirror of the Stripe add-on products
  ADDON_RUSH:        { amount: '99.00',  description: 'Aurevon RE - 12-Hour Rush Delivery (Add-On)' },
  ADDON_MEMO:        { amount: '149.00', description: 'Aurevon RE - Investor Memo Formatting (Add-On)' },
  ADDON_LENDER:      { amount: '199.00', description: 'Aurevon RE - Lender Presentation Package (Add-On)' },
  ADDON_SENSITIVITY: { amount: '125.00', description: 'Aurevon RE - Sensitivity Modeling (Add-On)' },
  ADDON_PORTFOLIO:   { amount: '499.00', description: 'Aurevon RE - Portfolio Review Bundle (Add-On)' },
  ADDON_WHITELABEL:  { amount: '175.00', description: 'Aurevon RE - White-Label Reports (Add-On)' },
};

async function getAccessToken() {
  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  return data.access_token;
}

async function logToAirtable(data) {
  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID) return;
  try {
    const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Payments`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: { ...data } }] })
    });
    if (!res.ok) console.error(`[PayPal] Airtable log failed (${res.status}): ${await res.text()}`);
  } catch (err) {
    console.error(`[PayPal] Airtable log error: ${err.message}`);
  }
}

async function sendConfirmationEmail(email, passType, name) {
  try {
    await fetch(`${SITE_URL}/api/email/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '',
      },
      body: JSON.stringify({ to: email, passType, customerName: name, portalLink: `${SITE_URL}/portal.html` })
    });
  } catch (err) {
    console.error(`[PayPal] Confirmation email error: ${err.message}`);
  }
}

async function handleCreateOrder(req, res) {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    return res.status(503).json({ error: 'PayPal not configured', hint: 'Add PAYPAL_CLIENT_ID and PAYPAL_SECRET to Vercel env vars' });
  }

  const { passType, customerEmail, returnUrl, cancelUrl } = req.body || {};
  const pass = PASS_PRICES[passType?.toUpperCase()];
  if (!pass) return res.status(400).json({ error: 'Invalid passType', valid: Object.keys(PASS_PRICES) });

  try {
    const accessToken = await getAccessToken();
    const response = await fetch(`${BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `aurevon-${Date.now()}-${passType}`
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: passType,
          description: pass.description,
          custom_id: customerEmail || '',
          amount: { currency_code: 'USD', value: pass.amount }
        }],
        application_context: {
          brand_name: 'Aurevon Ventures LLC',
          return_url: returnUrl || `${SITE_URL}/portal.html?payment=success`,
          cancel_url: cancelUrl || `${SITE_URL}/aurevon-re.html?payment=cancelled`,
          user_action: 'PAY_NOW'
        }
      })
    });
    const order = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: 'PayPal order creation failed', detail: order });
    const approvalLink = order.links?.find(l => l.rel === 'approve')?.href;
    return res.status(200).json({ ok: true, orderId: order.id, approvalUrl: approvalLink });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create PayPal order', message: err.message });
  }
}

async function handleCapture(req, res) {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) return res.status(503).json({ error: 'PayPal not configured' });

  const { orderId, customerEmail, passType, customerName } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  try {
    const token = await getAccessToken();
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

    if (amount === undefined) {
      console.warn(`[PayPal] Capture amount missing from PayPal response for orderId=${orderId} — logging $0`);
    }

    await logToAirtable({
      'Transaction ID':  orderId,
      'Payment Provider': 'PayPal',
      'Pass Type':       capturedPassType,
      'Amount':          parseFloat(amount) || 0,
      'Customer Email':  email,
      'Customer Name':   customerName || '',
      'Status':          'Succeeded',
      'Token':           `paid_${capturedPassType}_${Date.now()}`,
      'Payment Date':    new Date().toISOString(),
    });

    if (email) await sendConfirmationEmail(email, capturedPassType, customerName);

    return res.status(200).json({ ok: true, status: 'COMPLETED', orderId, passType: capturedPassType, amount });
  } catch (err) {
    return res.status(500).json({ error: 'Capture error', message: err.message });
  }
}

export default async function handler(req, res) {
  const origin = process.env.DOMAIN || 'https://www.aurevonvc.com';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action;
  if (action === 'create-order') return handleCreateOrder(req, res);
  if (action === 'capture') return handleCapture(req, res);
  return res.status(400).json({ error: 'Missing action param', valid: ['create-order', 'capture'] });
}
