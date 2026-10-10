/**
 * Proof-of-payment for the Aurevon Capital deal-intake form.
 *
 * The static intake page used to treat any `?paid=paid_…` query token as a
 * successful purchase. Those tokens are minted in the browser before checkout
 * (and can be typed by hand), so the form was reachable without paying.
 *
 * Callers must present a real processor id:
 *   - Stripe Checkout session id (`cs_test_…` / `cs_live_…`)
 *   - PayPal IPN `txn_id`
 *
 * Stripe sessions are retrieved live so we don't race the webhook's Payments
 * write. PayPal (and Stripe when the secret is unset) fall back to the
 * Payments row written by the webhook. Unpaid async Checkout
 * (`payment_status !== 'paid'`) is rejected — same rule as the Stripe
 * fulfillment guard.
 */

import Stripe from 'stripe';
import { findPaymentByTransactionId } from './airtable.js';

export const STRIPE_SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]+$/;
export const PAYPAL_TXN_RE = /^[A-Za-z0-9]{8,32}$/;

function succeededPayment(record) {
  if (!record) return null;
  const status = String(record.fields?.Status ?? '').toLowerCase();
  if (status !== 'succeeded') return null;
  return {
    ok: true,
    tier: record.fields?.['Pass Type'] ?? null,
    method: String(record.fields?.['Payment Provider'] ?? '').toLowerCase().includes('paypal')
      ? 'paypal'
      : 'stripe',
  };
}

async function lookupPayment(transactionId) {
  try {
    return succeededPayment(await findPaymentByTransactionId(transactionId));
  } catch (err) {
    const error = new Error(err.message);
    error.code = 'lookup_failed';
    throw error;
  }
}

/**
 * @param {{ sessionId?: string, txnId?: string }} input
 * @returns {Promise<{ ok: true, tier: string|null, method: string } | { ok: false, status: number, error: string }>}
 */
export async function verifyIntakePayment(input = {}) {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const txnId = typeof input.txnId === 'string' ? input.txnId.trim() : '';

  if (sessionId) {
    if (!STRIPE_SESSION_RE.test(sessionId)) {
      return { ok: false, status: 400, error: 'invalid_session' };
    }
    const secret = process.env.STRIPE_SECRET_KEY;
    if (secret) {
      try {
        const stripe = new Stripe(secret, { apiVersion: '2023-10-16' });
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status === 'paid') {
          return { ok: true, tier: session.metadata?.tier ?? null, method: 'stripe' };
        }
        return { ok: false, status: 402, error: 'unpaid' };
      } catch (err) {
        // Unknown / malformed session id — try the Payments marker, then 404.
        console.error(`[intake-verify] Stripe retrieve failed: ${err.message}`);
      }
    }
    try {
      const paid = await lookupPayment(sessionId);
      if (paid) return paid;
    } catch (err) {
      if (err.code === 'lookup_failed') {
        return { ok: false, status: 503, error: 'lookup_failed' };
      }
      throw err;
    }
    return { ok: false, status: 404, error: 'not_found' };
  }

  if (txnId) {
    if (!PAYPAL_TXN_RE.test(txnId)) {
      return { ok: false, status: 400, error: 'invalid_txn' };
    }
    try {
      const paid = await lookupPayment(txnId);
      if (paid) return paid;
    } catch (err) {
      if (err.code === 'lookup_failed') {
        return { ok: false, status: 503, error: 'lookup_failed' };
      }
      throw err;
    }
    return { ok: false, status: 404, error: 'not_found' };
  }

  return { ok: false, status: 400, error: 'missing_id' };
}
