/**
 * Consolidated webhook router — POST /api/webhooks?provider=stripe|paypal|crossmint
 *
 * Historically this file carried its own copies of the Stripe/PayPal/Crossmint
 * pipelines. Those copies drifted from the canonical per-provider handlers and
 * had real defects (no idempotency guard, no waitUntil durability, an
 * `email`-field mapping bug that wrote mint rows with no Email, and a degenerate
 * retry loop). No external webhook points here — the providers are configured
 * against /api/webhooks/{stripe,paypal,crossmint}, which Vercel routes to the
 * standalone files. To eliminate the duplicate (and dangerous) bug surface this
 * router now DELEGATES to those canonical handlers, which own all signature
 * verification, idempotency, and durability logic.
 *
 * Delegation is safe: the raw request body has not been consumed here, and this
 * function's own `bodyParser: false` governs the route, so each canonical
 * handler still reads the raw stream it needs for signature/IPN verification.
 */

import stripeHandler from './stripe.js';
import paypalHandler from './paypal.js';
import crossmintHandler from './crossmint.js';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const provider = req.query?.provider;
  if (provider === 'stripe')    return stripeHandler(req, res);
  if (provider === 'paypal')    return paypalHandler(req, res);
  if (provider === 'crossmint') return crossmintHandler(req, res);
  return res.status(400).json({ error: 'Missing provider param', valid: ['stripe', 'paypal', 'crossmint'] });
}

export const config = { api: { bodyParser: false } };
