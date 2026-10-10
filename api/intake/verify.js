/**
 * POST /api/intake/verify
 *
 * Confirms a Stripe Checkout session or PayPal txn_id actually paid before
 * the deal-intake form unlocks. Client-minted `paid_*` tokens are ignored.
 */

import { verifyIntakePayment } from '../_lib/intake-verify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await verifyIntakePayment({
      sessionId: body.sessionId,
      txnId: body.txnId,
    });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error });
    }
    return res.status(200).json({ ok: true, tier: result.tier, method: result.method });
  } catch (err) {
    console.error(`[intake-verify] ${err.message}`);
    return res.status(500).json({ ok: false, error: 'verify_failed' });
  }
}
