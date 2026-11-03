/**
 * PayPal IPN handler — POST /api/webhooks/paypal
 *
 * PayPal sends form-encoded POST data (IPN = Instant Payment Notification).
 * Verification: re-POST the exact body back to PayPal IPN endpoint with
 * "cmd=_notify-validate" prepended — PayPal responds "VERIFIED" or "INVALID".
 *
 * Same downstream pipeline as Stripe: Payments marker → fulfilNft (Crossmint → NFT_Mints → Resend).
 */

import { waitUntil } from '@vercel/functions';
import { TIER_NFT_MAP, inferTierFromAmount } from '../_lib/tiers.js';
import { fulfilNft } from '../_lib/fulfil.js';
import { createPayment, findPaymentByTransactionId } from '../_lib/db.js';
import { sendPurchaseConfirmation } from '../_lib/email.js';
import { sendAlert } from '../_lib/alert.js';

const PAYPAL_IPN_VERIFY_URL_LIVE    = 'https://ipnpb.paypal.com/cgi-bin/webscr';
const PAYPAL_IPN_VERIFY_URL_SANDBOX = 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr';

// ---------------------------------------------------------------------------
// IPN Verification
// ---------------------------------------------------------------------------

async function verifyPayPalIPN(rawBody) {
  const verifyUrl = process.env.PAYPAL_MODE === 'sandbox'
    ? PAYPAL_IPN_VERIFY_URL_SANDBOX
    : PAYPAL_IPN_VERIFY_URL_LIVE;

  // PayPal requires the exact raw body with cmd=_notify-validate prepended
  const verifyBody = `cmd=_notify-validate&${rawBody}`;

  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: verifyBody,
  });

  const result = await response.text();
  console.log(`[PayPal IPN] Verification result: ${result}`);
  return result.trim() === 'VERIFIED';
}

// ---------------------------------------------------------------------------
// Parse form-encoded IPN payload
// ---------------------------------------------------------------------------

function parseIPN(rawBody) {
  return Object.fromEntries(new URLSearchParams(rawBody));
}

// ---------------------------------------------------------------------------
// Infer tier from IPN data
// ---------------------------------------------------------------------------

// PayPal-eligible tiers (RE + Community). Restricting amount inference to these
// avoids collisions with add-on / archived web3 tiers that share dollar amounts.
const IPN_ELIGIBLE_TIERS = ['single', 'full', 'bogo', 'retainer', 'enterprise', 'comm_monthly', 'comm_lifetime'];

const IPN_TIER_ALIASES = {
  re_full: 'full',
  re_bogo: 'bogo',
  re_single: 'single',
  re_retainer: 'retainer',
  re_enterprise: 'enterprise',
};

function canonicalizeIpnTier(raw) {
  if (!raw) return null;
  const key = String(raw).trim();
  const canonical = IPN_TIER_ALIASES[key] || key;
  return IPN_ELIGIBLE_TIERS.includes(canonical) ? canonical : null;
}

/** Buyer-controlled `custom` is a hint only — never a substitute for USD paid. */
function claimedTierFromCustom(custom) {
  if (!custom) return null;
  try {
    const parsed = JSON.parse(custom);
    if (parsed && typeof parsed === 'object' && parsed.tier) {
      return canonicalizeIpnTier(parsed.tier);
    }
  } catch {
    return canonicalizeIpnTier(custom);
  }
  return canonicalizeIpnTier(custom);
}

function amountMatchesTier(tier, amountDollars) {
  const cfg = TIER_NFT_MAP[tier];
  if (!cfg || !Number.isFinite(amountDollars)) return false;
  return Math.abs(amountDollars - cfg.amount) <= 1;
}

function ipnCurrencyIsUsd(ipn) {
  return String(ipn.mc_currency ?? 'USD').trim().toUpperCase() === 'USD';
}

export function inferTierFromIPN(ipn) {
  // Catalog prices are USD. mc_gross is in mc_currency — a 2499 JPY/MXN/HUF
  // payment must not resolve as Enterprise. Missing currency stays USD so
  // hosted NCP IPNs that omit the field still match.
  if (!ipnCurrencyIsUsd(ipn)) return null;

  const amount = parseFloat(ipn.mc_gross ?? '0');
  const inferred = Number.isFinite(amount) && amount > 0
    ? inferTierFromAmount(Math.round(amount * 100))
    : null;
  const inferredEligible = inferred && IPN_ELIGIBLE_TIERS.includes(inferred) ? inferred : null;

  // Anyone can host a PayPal Buy Now form aimed at PAYPAL_BUSINESS_EMAIL with
  // custom={"tier":"enterprise"} and amount=1. Trust custom only when the
  // USD paid matches that tier's catalog price (same $1 window as amount inference).
  const claimed = claimedTierFromCustom(ipn.custom);
  if (claimed && amountMatchesTier(claimed, amount)) return claimed;

  return inferredEligible;
}

// ---------------------------------------------------------------------------
// Core pipeline (mirrors stripe handler)
// ---------------------------------------------------------------------------

export async function handleVerifiedIPN(ipn) {
  if (!ipn.txn_id) {
    console.error('[PayPal IPN] Verified IPN missing txn_id — refusing to process (fail-closed)');
    return;
  }

  const txnId = ipn.txn_id;
  const customerEmail = ipn.payer_email;
  const customerName = [ipn.first_name, ipn.last_name].filter(Boolean).join(' ') || 'Aurevon Member';
  const amount = parseFloat(ipn.mc_gross ?? '0');
  const paymentStatus = (ipn.payment_status ?? '').toLowerCase();

  if (!customerEmail) {
    console.error(`[PayPal IPN] No payer_email in IPN txnId=${txnId} — aborting pipeline`);
    return;
  }

  console.log(`[PayPal IPN] Processing txnId=${txnId} amount=${amount} status=${paymentStatus}`);

  // Only process completed payments
  if (paymentStatus !== 'completed') {
    console.log(`[PayPal IPN] Skipping non-completed payment (status=${paymentStatus})`);
    return;
  }

  // Validate receiver email to prevent fraud. FAIL CLOSED: if PAYPAL_BUSINESS_EMAIL
  // is unset we cannot prove the payment was made to us, so we refuse to mint/grant
  // rather than trusting an unverifiable receiver. Compare case-insensitively —
  // PayPal does not guarantee casing on receiver_email.
  const businessEmail = process.env.PAYPAL_BUSINESS_EMAIL;
  if (!businessEmail) {
    console.error('[PayPal IPN] PAYPAL_BUSINESS_EMAIL not set — refusing to process (fail-closed). Set this env var in production.');
    await sendAlert('paypal.business_email_unset', { txnId });
    return;
  }
  if ((ipn.receiver_email ?? '').toLowerCase() !== businessEmail.toLowerCase()) {
    console.warn(`[PayPal IPN] Receiver mismatch: got ${ipn.receiver_email}, expected ${businessEmail}`);
    return;
  }
  // Currency is checked only for a Completed payment to our own receiver, so
  // the alert below means real money arrived in a currency we don't price in.
  if (!ipnCurrencyIsUsd(ipn)) {
    console.warn(`[PayPal IPN] Rejecting non-USD payment (mc_currency=${ipn.mc_currency}) txnId=${ipn.txn_id}`);
    // Money may still have arrived: no Payments row is written, so alert for a
    // manual review / refund instead of dropping it silently.
    await sendAlert('paypal.non_usd_rejected', {
      txnId: ipn.txn_id,
      currency: ipn.mc_currency ?? null,
      gross: ipn.mc_gross ?? null,
    }).catch(() => {});
    return;
  }

  const tier = inferTierFromIPN(ipn);
  const token = `paid_${tier ?? 'unknown'}_${Date.now()}`;

  // Write Payments row — this is the idempotency MARKER and must land before the
  // irreversible Crossmint mint. If it fails we abort: minting without a persisted
  // marker would let a later IPN redelivery double-mint (the dedup check below
  // queries this table). No marker ⇒ no mint. (Mirrors the Stripe handler.)
  try {
    await createPayment({
      transactionId: txnId,
      method: 'PayPal',
      tier: tier ?? 'unknown',
      amount,
      customerEmail,
      customerName,
      status: 'Succeeded',
      token,
    });
  } catch (err) {
    if (err.code === 'DUPLICATE_PAYMENT') {
      // A concurrent IPN for this txn already wrote the marker and owns fulfilment.
      console.log(`[PayPal IPN] txn ${txnId} already being processed — skipping duplicate`);
      return;
    }
    console.error(`[PayPal IPN] createPayment (idempotency marker) failed: ${err.message} — aborting before mint`);
    await sendAlert('paypal.payment_marker_failed', { txnId, tier: tier ?? 'unknown', error: err.message });
    return;
  }

  // NFT fulfilment (mint → NFT_Mints row → delivery email) or, for tiers
  // without an NFT, a purchase confirmation.
  const result = await fulfilNft({ transactionId: txnId, email: customerEmail, customerName, tier: tier ?? 'unknown', provider: 'paypal' });
  if (result.reason === 'no_nft') {
    console.log(`[PayPal IPN] Tier "${tier}" has no NFT. Sending purchase confirmation.`);
    try {
      await sendPurchaseConfirmation({ email: customerEmail, customerName, tier: tier ?? 'unknown', transactionId: txnId });
    } catch (err) {
      console.error(`[PayPal IPN] Confirmation email failed: ${err.message}`);
    }
    return;
  }

  console.log(`[PayPal IPN] Pipeline complete for txnId=${txnId}`);
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read raw body (form-encoded)
  let rawBody;
  try {
    rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  } catch (err) {
    console.error(`[PayPal IPN] Failed to read body: ${err.message}`);
    return res.status(400).send('Failed to read body');
  }

  // PayPal expects HTTP 200 to acknowledge receipt immediately.
  res.status(200).send('OK');

  // Register the post-ack pipeline with waitUntil so Vercel keeps the function
  // alive until it settles. Without this, work after res.end() can be frozen and
  // the verify→mint→email pipeline silently dropped (the durability bug this
  // branch targets; the Stripe handler already uses waitUntil for the same reason).
  waitUntil(processIPN(rawBody).catch((err) => {
    console.error(`[PayPal IPN] Unhandled pipeline error: ${err.message}`, err.stack);
  }));
}

export async function processIPN(rawBody) {
  // Verify with PayPal
  let verified;
  try {
    verified = await verifyPayPalIPN(rawBody);
  } catch (err) {
    console.error(`[PayPal IPN] Verification request failed: ${err.message}`);
    return;
  }

  if (!verified) {
    console.warn('[PayPal IPN] IPN verification returned INVALID — discarding');
    return;
  }

  const ipn = parseIPN(rawBody);
  console.log(`[PayPal IPN] Verified. txn_id=${ipn.txn_id}, payment_status=${ipn.payment_status}`);

  // Idempotency check — skip if this txn_id has already been processed (the
  // UNIQUE Transaction ID in Payments also blocks a concurrent duplicate at
  // createPayment). Lookup failure is fail-closed: the
  // handler has already answered 200, so PayPal will NOT redeliver — the alert
  // below is what surfaces the payment for manual recovery.
  const txnId = ipn.txn_id;
  if (!txnId) {
    console.error('[PayPal IPN] Verified IPN missing txn_id — refusing to process (fail-closed)');
    return;
  }
  try {
    const prior = await findPaymentByTransactionId(txnId);
    if (prior) {
      console.log(`[PayPal IPN] Duplicate txn_id ${txnId} — skipping`);
      return;
    }
  } catch (err) {
    console.error(`[PayPal IPN] Idempotency check failed: ${err.message} — aborting`);
    await sendAlert('paypal.idempotency_lookup_failed', { txnId, error: err.message });
    return;
  }

  await handleVerifiedIPN(ipn);
}

export const config = {
  api: {
    bodyParser: false,
  },
};
