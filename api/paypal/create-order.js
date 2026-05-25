// api/paypal/create-order.js
// Creates a PayPal order for Aurevon pass purchases

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const BASE_URL = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const PASS_PRICES = {
  OBSIDIAN: { amount: '2499.00', description: 'Aurevon OBSIDIAN EXECUTIVE Pass - Enterprise RE Tier 3' },
  EMBER:    { amount: '1499.00', description: 'Aurevon EMBER Pass - RE Tier 2' },
  INSIDER:  { amount: '250.00',  description: 'Aurevon INSIDER Pass - RE Tier 1' },
  CHROME:   { amount: '150.00',  description: 'Aurevon CHROME Pass - Tier 2' },
  GENESIS:  { amount: '500.00',  description: 'Aurevon GENESIS Founder Pass - All Access Lifetime' },
  COMMUNITY:{ amount: '29.99',   description: 'Aurevon GENESIS COMMUNITY Pass - Monthly' },
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

function isSafeRedirect(url) {
  if (!url) return false;
  try {
    const allowed = new URL(process.env.NEXT_PUBLIC_URL || process.env.BASE_URL || 'https://www.aurevonvc.com');
    const target = new URL(url);
    return target.origin === allowed.origin;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    return res.status(503).json({ error: 'PayPal not configured', hint: 'Add PAYPAL_CLIENT_ID and PAYPAL_SECRET to Vercel env vars' });
  }

  const { passType, customerEmail, returnUrl, cancelUrl } = req.body || {};
  const pass = PASS_PRICES[passType?.toUpperCase()];
  if (!pass) return res.status(400).json({ error: 'Invalid passType', valid: Object.keys(PASS_PRICES) });

  const safeReturn = isSafeRedirect(returnUrl) ? returnUrl : `${process.env.NEXT_PUBLIC_URL || 'https://www.aurevonvc.com'}/success`;
  const safeCancel = isSafeRedirect(cancelUrl) ? cancelUrl : `${process.env.NEXT_PUBLIC_URL || 'https://www.aurevonvc.com'}/cancel`;

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
          brand_name: 'Aurevon Group LLC',
          return_url: safeReturn,
          cancel_url: safeCancel,
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
