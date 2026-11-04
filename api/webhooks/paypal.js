/**
 * PayPal IPN handler — POST /api/webhooks/paypal
 *
 * PayPal sends form-encoded POST data (IPN = Instant Payment Notification).
 * Verification: re-POST the exact body back to PayPal IPN endpoint with
 * "cmd=_notify-validate" prepended — PayPal responds "VERIFIED" or "INVALID".
 *
 * Same downstream pipeline as Stripe: Payments marker → fulfilNft (Crossmint → NFT_Mints → Resend).
 *
 * txn_type routing (missing txn_type = web_accept):
 *   web_accept / express_checkout / cart / subscr_payment → fulfilment
 *     (a subscr_payment for a subscr_id already on a Payments row is a renewal:
 *      recorded, monthly billing extended, never minted)
 *   subscr_cancel / subscr_eot / subscr_failed → monthly billing cancelled only
 *   anything else (subscr_signup, adjustments, …) → logged, nothing written
 */

import { waitUntil } from '@vercel/functions';
import { TIER_NFT_MAP, inferTierFromAmount, canonicalTier, paypalItemTiers } from '../_lib/tiers.js';
import { resolveEntitlementFromSku } from '../_lib/entitlements.js';
import { fulfilNft } from '../_lib/fulfil.js';
import {
  createPayment, findPaymentByTransactionId, findPaymentBySubscriptionId,
  findMemberByEmail, listPaymentsByEmail, updateEntitlementState,
} from '../_lib/db.js';
import { sendPurchaseConfirmation } from '../_lib/email.js';
import { sendAlert } from '../_lib/alert.js';

const PAYPAL_IPN_VERIFY_URL_LIVE    = 'https://ipnpb.paypal.com/cgi-bin/webscr';
const PAYPAL_IPN_VERIFY_URL_SANDBOX = 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr';

const DAY_MS = 86_400_000;
// A PayPal monthly renewal pays the next month; 31 days covers the longest one.
const SUBSCRIPTION_PERIOD_DAYS = 31;

// ---------------------------------------------------------------------------
// txn_type routing
// ---------------------------------------------------------------------------

/** Payment types that may fulfil (mint / confirm). Everything else never does. */
const FULFIL_TXN_TYPES = new Set(['web_accept', 'express_checkout', 'cart', 'subscr_payment']);
/** Subscription lifecycle types: billing state only, no Payments row, no txn_id needed. */
const LIFECYCLE_TXN_TYPES = new Set(['subscr_cancel', 'subscr_eot', 'subscr_failed']);

/**
 * The IPN's txn_type, lower-cased. A missing txn_type is treated as
 * `web_accept`: hosted NCP (no-code checkout) IPNs sometimes omit it.
 */
export function ipnTxnType(ipn) {
  const t = String(ipn?.txn_type ?? '').trim().toLowerCase();
  return t || 'web_accept';
}

/** Log-safe rendering of an IPN token (txn_type etc.) — no free text in logs. */
function logToken(v) {
  return String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || '(blank)';
}

/** PayPal subscription ids are I-…/S-… style; anything else is treated as absent. */
function cleanSubscrId(v) {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(s) ? s : null;
}

const subscriptionToken = (subscrId) => `subscr:${subscrId}`;

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

// PayPal-eligible tiers (RE + Community). Restricting `custom` and amount
// inference to these avoids collisions with add-on / archived web3 tiers that
// share dollar amounts.
const IPN_ELIGIBLE_TIERS = ['single', 'full', 'bogo', 'retainer', 'enterprise', 'comm_monthly', 'comm_lifetime'];

/** Pass Type for a multi-item cart: add-ons, never an NFT tier. */
export const ADDONS_PASS_TYPE = 'addons';

function canonicalizeIpnTier(raw) {
  if (!raw) return null;
  const canonical = canonicalTier(String(raw).trim());
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

function rawCartCount(ipn) {
  return String(ipn.num_cart_items ?? '').trim();
}

/** More than one line item (cart, or an express checkout with several items). */
function isMultiItem(ipn) {
  const n = Number.parseInt(rawCartCount(ipn), 10);
  return Number.isFinite(n) && n > 1;
}

/** Amount inference only for a single-item, non-cart payment. */
function amountInferenceAllowed(ipn) {
  if (ipnTxnType(ipn) === 'cart') return false;
  const n = rawCartCount(ipn);
  return n === '' || n === '1';
}

/** PAYPAL_ITEM_TIERS[item_number] (item_number1 for a single-item cart). */
function mappedTierFromItem(ipn) {
  const { map } = paypalItemTiers();
  let item = String(ipn.item_number ?? '').trim();
  if (!item && rawCartCount(ipn) === '1') item = String(ipn.item_number1 ?? '').trim();
  return item && Object.hasOwn(map, item) ? map[item] : null;
}

/**
 * Tier for a payment IPN, or null. Every source must match the money: a forged
 * Buy Now form aimed at PAYPAL_BUSINESS_EMAIL controls `custom` AND
 * `item_number`, but not what was paid.
 *
 *   non-USD                      → null
 *   more than one item           → 'addons' (never an NFT, whatever custom says)
 *   custom tier                  → only if USD paid is within $1 of its price
 *   PAYPAL_ITEM_TIERS[item]      → only if USD paid is within $1 of its price
 *   amount inference             → only when txn_type !== 'cart' and num_cart_items is absent or 1
 */
export function inferTierFromIPN(ipn) {
  // Catalog prices are USD. mc_gross is in mc_currency — a 2499 JPY/MXN/HUF
  // payment must not resolve as Enterprise. Missing currency stays USD so
  // hosted NCP IPNs that omit the field still match.
  if (!ipnCurrencyIsUsd(ipn)) return null;

  // 2 × $125 Sensitivity add-ons = $250 must not resolve as Full Package.
  if (isMultiItem(ipn)) return ADDONS_PASS_TYPE;

  const amount = parseFloat(ipn.mc_gross ?? '0');

  // Anyone can host a PayPal Buy Now form aimed at PAYPAL_BUSINESS_EMAIL with
  // custom={"tier":"enterprise"} and amount=1. Trust custom only when the
  // USD paid matches that tier's catalog price (same $1 window as amount inference).
  const claimed = claimedTierFromCustom(ipn.custom);
  if (claimed && amountMatchesTier(claimed, amount)) return claimed;

  // Same rule for the item_number map: item_number is form-controlled too.
  const mapped = mappedTierFromItem(ipn);
  if (mapped && amountMatchesTier(mapped, amount)) return mapped;

  if (!amountInferenceAllowed(ipn)) return null;
  const inferred = Number.isFinite(amount) && amount > 0
    ? inferTierFromAmount(Math.round(amount * 100))
    : null;
  return inferred && IPN_ELIGIBLE_TIERS.includes(inferred) ? inferred : null;
}

// One alert per distinct bad PAYPAL_ITEM_TIERS value (the map is then ignored).
let itemTiersAlertedFor = null;
async function alertIfItemTiersInvalid() {
  const cfg = paypalItemTiers();
  if (!(cfg.invalid || cfg.dropped.length > 0) || itemTiersAlertedFor === cfg.raw) return;
  itemTiersAlertedFor = cfg.raw;
  const reason = cfg.invalid ? 'invalid_json' : 'unknown_tier';
  console.error(`[PayPal IPN] PAYPAL_ITEM_TIERS ${reason} — ${cfg.invalid ? 'map ignored' : `dropped ${cfg.dropped.length} entr${cfg.dropped.length === 1 ? 'y' : 'ies'}`}`);
  await sendAlert('paypal.item_tiers_invalid', {
    reason,
    ...(cfg.invalid ? {} : { dropped: cfg.dropped.slice(0, 20) }),
  }).catch(() => {});
}

/** Fail-closed receiver gate. Returns true only for a payment/notice addressed to us. */
async function receiverIsUs(receiver, alertDetail) {
  // FAIL CLOSED: if PAYPAL_BUSINESS_EMAIL is unset we cannot prove the payment
  // was made to us, so we refuse rather than trusting an unverifiable receiver.
  // Compare case-insensitively — PayPal does not guarantee casing.
  const businessEmail = process.env.PAYPAL_BUSINESS_EMAIL;
  if (!businessEmail) {
    console.error('[PayPal IPN] PAYPAL_BUSINESS_EMAIL not set — refusing to process (fail-closed). Set this env var in production.');
    await sendAlert('paypal.business_email_unset', alertDetail);
    return false;
  }
  if (String(receiver ?? '').trim().toLowerCase() !== businessEmail.trim().toLowerCase()) {
    console.warn('[PayPal IPN] Receiver mismatch — IPN is not for PAYPAL_BUSINESS_EMAIL; ignoring');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Subscription billing (monthly membership only)
// ---------------------------------------------------------------------------

/**
 * A paid subscr_payment keeps a monthly (Genesis) member's billing active for
 * one more period. Ember / Obsidian are permanent passes — their member row is
 * never touched here (a write would clobber a Genesis member's entitlement).
 */
async function extendMonthlyBilling(email, tier, { txnId, subscrId, renewal }) {
  const entitlementKey = resolveEntitlementFromSku(tier);
  if (entitlementKey !== 'monthly_membership') {
    console.log(`[PayPal IPN] subscr_payment ${txnId} (${subscrId}) tier=${tier}: not a monthly membership — no billing write`);
    return;
  }
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS).toISOString();
  try {
    await updateEntitlementState(email, {
      entitlementType: entitlementKey, status: 'active', billingState: 'active', expiresAt,
    });
    console.log(`[PayPal IPN] Monthly billing active through ${expiresAt} (subscription ${subscrId})`);
  } catch (err) {
    console.error(`[PayPal IPN] updateEntitlementState (${renewal ? 'renewal' : 'first payment'}) failed: ${err.message}`);
    await sendAlert('paypal.entitlement_write_failed', {
      txnId, subscrId, source: renewal ? 'subscr_payment.renewal' : 'subscr_payment.first', error: err.message,
    }).catch(() => {});
  }
}

/** USD regular amount (mc_amount3 / amount3) a lifecycle IPN carries, or null if absent. */
function lifecycleRegularAmount(ipn) {
  const raw = ipn.mc_amount3 ?? ipn.amount3;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return parseFloat(raw);
}

/**
 * Is this subscription the monthly membership? Decided by, in order:
 *   1. its first payment's Payments row (Pass Type) — final when present;
 *   2. the regular amount the IPN carries (USD only) — final when present;
 *   3. the member row's Entitlement Type (legacy subscriptions with neither).
 * @returns {Promise<boolean|null>} null = could not decide (lookup failed; alerted)
 */
async function subscriptionIsMonthly(ipn, row, email, detail) {
  if (row) {
    return resolveEntitlementFromSku(canonicalTier(row.fields?.['Pass Type'] ?? '')) === 'monthly_membership';
  }
  const regular = lifecycleRegularAmount(ipn);
  if (regular !== null) {
    if (!ipnCurrencyIsUsd(ipn) || !Number.isFinite(regular) || regular <= 0) return false;
    const tier = inferTierFromAmount(Math.round(regular * 100));
    return tier === 'comm_monthly';
  }
  try {
    const member = await findMemberByEmail(email);
    return member?.fields?.['Entitlement Type'] === 'monthly_membership';
  } catch (err) {
    console.error(`[PayPal IPN] ${detail.txnType}: member lookup failed: ${err.message}`);
    await sendAlert('paypal.subscription_lifecycle_failed', { ...detail, step: 'member_lookup', error: err.message }).catch(() => {});
    return null;
  }
}

/**
 * Another PayPal monthly subscription for the same email paid within the last
 * period → hold (mirrors Stripe's monthly_change_held): cancelling an old
 * subscription after starting a new one must not cancel the member.
 * @returns {Promise<boolean>} true = hold (also when the scan fails)
 */
async function anotherMonthlySubscriptionActive(email, subscrId, detail) {
  try {
    const own = subscrId ? subscriptionToken(subscrId) : null;
    const cutoff = Date.now() - SUBSCRIPTION_PERIOD_DAYS * DAY_MS;
    const payments = await listPaymentsByEmail(email, 50);
    return (payments ?? []).some((p) => {
      const token = String(p?.fields?.['Token'] ?? '');
      if (!token.startsWith('subscr:') || token === own) return false;
      if (resolveEntitlementFromSku(canonicalTier(p.fields?.['Pass Type'] ?? '')) !== 'monthly_membership') return false;
      const paidAt = Date.parse(p.fields?.['Payment Date'] ?? '');
      return Number.isFinite(paidAt) && paidAt > cutoff;
    });
  } catch (err) {
    console.error(`[PayPal IPN] ${detail.txnType}: payment scan failed: ${err.message} — holding`);
    await sendAlert('paypal.subscription_lifecycle_failed', { ...detail, step: 'payment_scan', error: err.message }).catch(() => {});
    return true;
  }
}

/**
 * subscr_cancel / subscr_eot / subscr_failed — billing state only. A monthly
 * (Genesis) member is marked cancelled; Discord role removal happens in the
 * nightly reconcile. Ember / Obsidian subscriptions are permanent passes: log
 * only. Idempotent; no txn_id required; no Payments row written.
 */
async function handleSubscriptionLifecycle(ipn, txnType) {
  const subscrId = cleanSubscrId(ipn.subscr_id);
  const detail = { txnType, subscrId };
  const tag = `[PayPal IPN] ${txnType}${subscrId ? ` ${subscrId}` : ''}`;

  // Subscription notices may carry `business` instead of `receiver_email`.
  if (!(await receiverIsUs(ipn.receiver_email || ipn.business, detail))) return;

  let row = null;
  if (subscrId) {
    try {
      row = await findPaymentBySubscriptionId(subscrId);
    } catch (err) {
      console.error(`${tag}: subscription lookup failed: ${err.message} — no change`);
      await sendAlert('paypal.subscription_lifecycle_failed', { ...detail, step: 'subscription_lookup', error: err.message }).catch(() => {});
      return;
    }
  }

  const email = String(ipn.payer_email || row?.fields?.['Customer Email'] || '').trim();
  if (!email) {
    console.warn(`${tag}: no payer email — cannot resolve the member`);
    await sendAlert('paypal.subscription_lifecycle_failed', { ...detail, step: 'no_email' }).catch(() => {});
    return;
  }

  const monthly = await subscriptionIsMonthly(ipn, row, email, detail);
  if (monthly === null) return;
  if (!monthly) {
    console.log(`${tag}: not a monthly membership (permanent pass or not ours) — no billing change`);
    return;
  }

  if (await anotherMonthlySubscriptionActive(email, subscrId, detail)) {
    console.log(`${tag}: another monthly subscription is paid up for this member — holding`);
    await sendAlert('paypal.monthly_change_held', detail, { severity: 'info' }).catch(() => {});
    return;
  }

  try {
    await updateEntitlementState(email, { entitlementType: 'monthly_membership', billingState: 'cancelled' });
    console.log(`${tag}: monthly billing marked cancelled (role removal in reconcile)`);
  } catch (err) {
    console.error(`${tag}: updateEntitlementState failed: ${err.message}`);
    await sendAlert('paypal.entitlement_write_failed', { ...detail, source: txnType, error: err.message }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Core pipeline (mirrors stripe handler)
// ---------------------------------------------------------------------------

export async function handleVerifiedIPN(ipn) {
  const txnType = ipnTxnType(ipn);
  if (LIFECYCLE_TXN_TYPES.has(txnType)) {
    await handleSubscriptionLifecycle(ipn, txnType);
    return;
  }
  if (!FULFIL_TXN_TYPES.has(txnType)) {
    // subscr_signup, refunds/adjustments, new_case, masspay, … — never fulfil.
    console.log(`[PayPal IPN] Ignoring txn_type=${logToken(txnType)} — no fulfilment`);
    return;
  }

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

  console.log(`[PayPal IPN] Processing txnId=${txnId} txn_type=${txnType} amount=${amount} status=${paymentStatus}`);

  // Only process completed payments
  if (paymentStatus !== 'completed') {
    console.log(`[PayPal IPN] Skipping non-completed payment (status=${paymentStatus})`);
    return;
  }

  // Validate receiver email to prevent fraud (fail-closed, case-insensitive).
  if (!(await receiverIsUs(ipn.receiver_email, { txnId }))) return;

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

  await alertIfItemTiersInvalid();
  const tier = inferTierFromIPN(ipn);
  const passType = canonicalTier(tier ?? 'unknown');

  // Subscriptions: only the FIRST subscr_payment for a subscr_id fulfils. A
  // renewal (new txn_id each month) is recorded and extends billing — no mint.
  let subscrId = null;
  let renewal = false;
  if (txnType === 'subscr_payment') {
    subscrId = cleanSubscrId(ipn.subscr_id);
    if (!subscrId) {
      // Without the subscription id a renewal can't be told from a first
      // payment, and minting every month is worse than a manual review.
      console.error(`[PayPal IPN] subscr_payment ${txnId} has no usable subscr_id — refusing to fulfil`);
      await sendAlert('paypal.subscr_id_missing', { txnId, tier: passType }).catch(() => {});
      return;
    }
    try {
      renewal = Boolean(await findPaymentBySubscriptionId(subscrId));
    } catch (err) {
      // Fail closed: guessing "first payment" could mint again.
      console.error(`[PayPal IPN] subscription lookup failed for ${subscrId}: ${err.message} — aborting before marker`);
      await sendAlert('paypal.subscription_lookup_failed', { txnId, subscrId, error: err.message }).catch(() => {});
      return;
    }
  }

  const token = subscrId ? subscriptionToken(subscrId) : `paid_${passType}_${Date.now()}`;

  // Write Payments row — this is the idempotency MARKER and must land before the
  // irreversible Crossmint mint. If it fails we abort: minting without a persisted
  // marker would let a later IPN redelivery double-mint (the dedup check below
  // queries this table). No marker ⇒ no mint. (Mirrors the Stripe handler.)
  try {
    await createPayment({
      transactionId: txnId,
      method: 'PayPal',
      tier: passType,
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
    await sendAlert('paypal.payment_marker_failed', { txnId, tier: passType, error: err.message });
    return;
  }

  if (renewal) {
    // Recorded above (own txn_id). No mint, no NFT email, no confirmation.
    if (tier === null) {
      // Money arrived for a known subscription at a price that matches no tier.
      console.warn(`[PayPal IPN] Renewal ${txnId} for ${subscrId}: amount matches no tier — billing not extended`);
      await sendAlert('paypal.subscription_renewal_unmatched', { txnId, subscrId, gross: ipn.mc_gross ?? null }).catch(() => {});
      return;
    }
    await extendMonthlyBilling(customerEmail, passType, { txnId, subscrId, renewal: true });
    console.log(`[PayPal IPN] Renewal ${txnId} for subscription ${subscrId} recorded — no mint`);
    return;
  }

  // NFT fulfilment (mint → NFT_Mints row → delivery email) or, for tiers
  // without an NFT (bogo / single / add-ons / unknown), a purchase confirmation.
  const result = await fulfilNft({ transactionId: txnId, email: customerEmail, customerName, tier: passType, provider: 'paypal' });
  if (subscrId) await extendMonthlyBilling(customerEmail, passType, { txnId, subscrId, renewal: false });
  if (result.reason === 'no_nft') {
    console.log(`[PayPal IPN] Tier "${passType}" has no NFT. Sending purchase confirmation.`);
    try {
      await sendPurchaseConfirmation({ email: customerEmail, customerName, tier: passType, transactionId: txnId });
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
  const txnType = ipnTxnType(ipn);
  console.log(`[PayPal IPN] Verified. txn_type=${logToken(txnType)} txn_id=${ipn.txn_id}, payment_status=${ipn.payment_status}`);

  // Lifecycle notices (no txn_id) and ignored types (subscr_signup, …) never
  // write a Payments row, so they skip the txn_id idempotency check.
  if (!FULFIL_TXN_TYPES.has(txnType)) {
    await handleVerifiedIPN(ipn);
    return;
  }

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
