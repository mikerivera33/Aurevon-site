/**
 * Stripe webhook handler — POST /api/webhooks/stripe
 *
 * Vercel serverless function (ESM, Node 20+).
 * Handles settled Checkout Sessions (card: checkout.session.completed with
 * payment_status paid; Afterpay/Cash App/ACH: checkout.session.async_payment_succeeded)
 * → Payments marker (before the 200 ack) → fulfilNft (mint → record → email) or a
 * purchase confirmation; subscription lifecycle → billing state; full refunds and
 * disputes → Payments status + pass revocation. See REQUIRED_STRIPE_EVENTS.
 */

import crypto from 'node:crypto';
import Stripe from 'stripe';
import { waitUntil } from '@vercel/functions';
import { inferTierFromAmount } from '../_lib/tiers.js';
import { fulfilNft } from '../_lib/fulfil.js';
import {
  createPayment, updateDiscordSyncStatus, findMemberByEmail, findPaymentByTransactionId, updateEntitlementState,
  updatePaymentStatus, findMintByPaymentId, updateNftMint, findActiveMintsByEmail,
} from '../_lib/db.js';
import { sendPurchaseConfirmation } from '../_lib/email.js';
import { resolveEntitlementFromSku, resolveEntitlementFromNftType, getRoleId, ENTITLEMENT_MAP } from '../_lib/entitlements.js';
import { removeRoleFromMember } from '../_lib/discord-bot.js';
import { sendAlert } from '../_lib/alert.js';

const STRIPE_API_VERSION = '2023-10-16';

function stripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

function subscriptionIdFrom(sessionOrSub) {
  const value = sessionOrSub?.subscription ?? sessionOrSub?.id;
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

function customerIdFrom(subscription) {
  const customer = subscription?.customer;
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

/**
 * Cancel/update events only carry metadata.email if checkout.session.completed
 * managed to PATCH the subscription. That write is best-effort and is skipped
 * entirely on idempotent retry (Payments row already exists). Fall back to the
 * Stripe Customer — Checkout always creates one with the buyer's email.
 */
// The Stripe Customer is the payer Stripe settled the subscription for, so it
// is authoritative. metadata.email is only a fallback (written by
// persistSubscriptionIdentity from the settled checkout email) for when the
// Customer can't be read — never from the unauthenticated checkout request.
export async function resolveSubscriptionEmail(subscription) {
  const fromMeta = subscription?.metadata?.email || null;
  const expanded = subscription?.customer;
  if (expanded && typeof expanded === 'object' && !expanded.deleted && expanded.email) {
    return expanded.email;
  }
  const customerId = customerIdFrom(subscription);
  if (!customerId || !process.env.STRIPE_SECRET_KEY) return fromMeta;
  try {
    const customer = await stripeClient().customers.retrieve(customerId);
    if (customer && !customer.deleted && customer.email) return customer.email;
    return fromMeta;
  } catch (err) {
    console.error(`[Stripe] Could not resolve customer email for ${customerId}: ${err.message}`);
    return fromMeta;
  }
}

async function persistSubscriptionIdentity(session, customerEmail, tier) {
  if (session?.mode !== 'subscription' || !customerEmail) return;
  const subId = subscriptionIdFrom(session);
  if (!subId || !process.env.STRIPE_SECRET_KEY) return;
  try {
    const metadata = { email: customerEmail };
    if (tier) metadata.tier = tier;
    await stripeClient().subscriptions.update(subId, { metadata });
    console.log(`[Stripe] Saved email to subscription ${subId} metadata`);
  } catch (err) {
    console.error(`[Stripe] Could not update subscription metadata: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Stripe signature verification (no Stripe SDK dependency)
// ---------------------------------------------------------------------------

// Stripe sends one `v1=` entry per active endpoint secret (two while a secret
// is being rolled), so the header is valid when ANY v1 entry matches.
export function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) throw new Error('Missing Stripe-Signature header');

  let timestamp = null;
  const v1s = [];
  for (const part of String(sigHeader).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) v1s.push(value);
  }

  if (!timestamp || v1s.length === 0) throw new Error('Malformed Stripe-Signature header');

  // Reject events older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    throw new Error('Stripe webhook timestamp too old — possible replay attack');
  }

  const expBuf = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest();

  const match = v1s.some((v1) => {
    const v1Buf = Buffer.from(v1, 'hex');
    return v1Buf.length === expBuf.length && crypto.timingSafeEqual(v1Buf, expBuf);
  });

  if (!match) throw new Error('Stripe signature mismatch');
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/** Stripe marks a session settled as "paid", or "no_payment_required" for $0 / 100% promo. */
export function isSettledCheckout(session) {
  return session?.payment_status === 'paid' || session?.payment_status === 'no_payment_required';
}

// The facts every checkout step needs. Tier: metadata first, then the amount.
function checkoutFacts(session) {
  const sessionId = session?.id;
  const customerEmail = session?.customer_details?.email ?? session?.customer_email ?? null;
  const customerName = session?.customer_details?.name ?? 'Aurevon Member';
  const amountTotal = session?.amount_total ?? 0; // cents
  let tier = session?.metadata?.tier ?? null;
  if (!tier) {
    tier = inferTierFromAmount(amountTotal);
    if (tier) console.log(`[Stripe] No metadata.tier — inferred tier="${tier}" from amount ${amountTotal}`);
  }
  if (!tier) {
    console.warn(`[Stripe] Could not determine tier for session ${sessionId}. Treating as unknown.`);
    tier = 'unknown';
  }
  return { sessionId, customerEmail, customerName, amountTotal, tier };
}

function withStage(err, stage) {
  if (err && typeof err === 'object') err.stage = stage;
  return err;
}

/**
 * Step 1 — the Payments idempotency marker. The webhook runs this BEFORE it
 * acks, so a database failure becomes a 500 and Stripe redelivers. (After a
 * 200 nothing would retry it: reconcile only scans existing Payments rows.)
 *
 * @returns {Promise<{ status: 'recorded'|'duplicate'|'skipped', tier?: string,
 *   customerEmail?: string|null, customerName?: string, concurrent?: boolean,
 *   paymentStatus?: string|null, reason?: string }>}
 *   `duplicate` + `concurrent: true` — a parallel delivery inserted the marker
 *   moments ago (DUPLICATE_PAYMENT) and owns fulfilment.
 * @throws on a real database failure (err.stage 'lookup' | 'marker');
 *   never for DUPLICATE_PAYMENT.
 */
export async function recordCheckoutPayment(session) {
  const sessionId = session?.id;

  // Delayed methods (Afterpay, Cash App Pay, ACH) send checkout.session.completed
  // with payment_status:"unpaid" before funds settle. Fulfilling here would mint
  // the NFT and write Payments status=Succeeded even if the charge later fails.
  // Wait for payment_status paid (or the later async_payment_succeeded event).
  if (!isSettledCheckout(session)) {
    console.log(`[Stripe] Session ${sessionId} payment_status=${session?.payment_status ?? 'missing'} — not settled, skipping fulfillment`);
    // Fulfilment now depends on checkout.session.async_payment_succeeded
    // reaching this endpoint. Alert so a missing event subscription (or a
    // payment that never settles) can't leave a buyer unfulfilled silently.
    await sendAlert('stripe.checkout_awaiting_payment', {
      sessionId,
      paymentStatus: session?.payment_status ?? null,
      tier: session?.metadata?.tier ?? null,
    }).catch(() => {});
    return { status: 'skipped', reason: 'unsettled' };
  }

  const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;
  if (!customerEmail) {
    console.error(`[Stripe] No customer email on session ${sessionId} — aborting pipeline`);
    // Settled money with nobody to fulfil: never silent.
    await sendAlert('stripe.paid_session_no_email', { sessionId, tier: checkoutFacts(session).tier },
      { severity: 'critical', dedupeKey: sessionId }).catch(() => {});
    return { status: 'skipped', reason: 'no_email' };
  }

  // ── Idempotency guard ──────────────────────────────────────────────────────
  // Stripe redelivers an event whenever it doesn't receive a 2xx (network blip,
  // timeout). The Payments row written below is the dedup marker: if one already
  // exists for this session, this is a redelivery and we must NOT mint again.
  // If the lookup itself fails we throw rather than risk a blind double-mint —
  // the webhook answers 500 and Stripe retries once the database is healthy.
  let prior;
  try {
    prior = await findPaymentByTransactionId(sessionId);
  } catch (err) {
    console.error(`[Stripe] Idempotency lookup failed for ${sessionId}: ${err.message} — aborting before mint`);
    throw withStage(err, 'lookup');
  }

  const { customerName, amountTotal, tier } = checkoutFacts(session);
  if (prior) {
    console.log(`[Stripe] Session ${sessionId} already processed (Payments row exists) — skipping to avoid double-mint`);
    return { status: 'duplicate', tier, customerEmail, customerName, paymentStatus: prior.fields?.['Status'] ?? null };
  }

  console.log(`[Stripe] Processing session ${sessionId} amount=${amountTotal}`);

  // Write Payments row — this is the idempotency MARKER and must land before
  // the irreversible Crossmint mint. No marker ⇒ no mint.
  try {
    await createPayment({
      transactionId: sessionId,
      method: 'Stripe Card',
      tier,
      amount: amountTotal / 100,
      customerEmail,
      customerName,
      status: 'Succeeded',
      token: `paid_${tier}_${Date.now()}`,
    });
  } catch (err) {
    if (err.code === 'DUPLICATE_PAYMENT') {
      // A concurrent delivery of this session already wrote the marker and owns fulfilment.
      console.log(`[Stripe] Session ${sessionId} already being processed — skipping duplicate delivery`);
      return { status: 'duplicate', concurrent: true, tier, customerEmail, customerName };
    }
    console.error(`[Stripe] createPayment (idempotency marker) failed for ${sessionId}: ${err.message} — aborting before mint`);
    throw withStage(err, 'marker');
  }

  return { status: 'recorded', tier, customerEmail, customerName };
}

/**
 * Step 2 — everything after the marker; runs in waitUntil after the 200.
 *
 * First delivery: subscription identity → monthly billing reset → fulfilNft
 * (mint → NFT_Mints row → delivery email) or, for tiers without an NFT
 * (bogo / single / add-ons), a purchase confirmation.
 *
 * Redelivery (Payments row already existed): re-persist identity and billing
 * (a first run may have died before them), and call fulfilNft again — it
 * dedupes on the payment id, so a first run that died before minting
 * self-heals. No second purchase confirmation. A payment already marked
 * Refunded / Disputed (`paymentStatus`) is never fulfilled again.
 *
 * Concurrent duplicate (`concurrent: true`): the other in-flight run owns the
 * whole pipeline; nothing is done here. Calling fulfilNft now could race the
 * owner before its mint row exists (second serial reserved). Orphan recovery
 * picks up a Payments row whose owner died.
 */
const REVERSED_PAYMENT = new Set(['Refunded', 'Disputed']);

export async function fulfilCheckout(session, { redelivery = false, concurrent = false, paymentStatus = null } = {}) {
  if (concurrent) return;
  if (REVERSED_PAYMENT.has(paymentStatus)) {
    console.log(`[Stripe] Session ${session?.id} is ${paymentStatus} — not fulfilling redelivery`);
    return;
  }
  const { sessionId, customerEmail, customerName, tier } = checkoutFacts(session);
  if (!customerEmail) return;

  // If subscription mode, save customer email in subscription metadata
  // so customer.subscription.deleted events can identify the customer.
  // Best-effort: cancel handlers also resolve email from the Stripe Customer.
  // On redelivery only a tier Stripe itself carries is written back.
  const identityTier = redelivery ? (session.metadata?.tier ?? null) : tier;
  await persistSubscriptionIdentity(session, customerEmail, identityTier);
  await activateMonthlyBilling(session, customerEmail, identityTier, { redelivery });

  if (tier === 'unknown') {
    // Settled money that matches no tier: the Payments row is recorded, but
    // there is nothing to fulfil and no "Item: …" email for a product we can't
    // name. The owner reviews it by hand.
    console.warn(`[Stripe] Session ${sessionId} resolved to no tier — recorded, no fulfilment, no email`);
    await sendAlert('stripe.tier_unresolved',
      { txnId: sessionId, gross: (session?.amount_total ?? 0) / 100, currency: session?.currency ?? null },
      { severity: 'high', dedupeKey: sessionId }).catch(() => {});
    return;
  }

  const result = await fulfilNft({ transactionId: sessionId, email: customerEmail, customerName, tier, provider: 'stripe' });
  if (result.reason === 'no_nft') {
    if (redelivery) return;
    console.log(`[Stripe] Tier "${tier}" has no NFT. Sending purchase confirmation email.`);
    try {
      await sendPurchaseConfirmation({ email: customerEmail, customerName, tier, transactionId: sessionId });
    } catch (err) {
      console.error(`[Stripe] Confirmation email failed: ${err.message}`);
    }
    return;
  }

  console.log(`[Stripe] Pipeline complete for session ${sessionId}${redelivery ? ' (redelivery)' : ''}`);
}

/**
 * recordCheckoutPayment then fulfilCheckout in one call (direct callers and
 * tests). Never throws for a database failure: it alerts and returns, as before
 * the split. On a duplicate it only restores subscription identity and billing
 * — it never mints; the webhook handler is what re-drives fulfilNft on a
 * redelivery.
 */
export async function handleCheckoutSessionCompleted(session) {
  let recorded;
  try {
    recorded = await recordCheckoutPayment(session);
  } catch (err) {
    if (err.stage === 'lookup') {
      await sendAlert('stripe.idempotency_lookup_failed', { sessionId: session?.id, error: err.message });
    } else {
      await sendAlert('stripe.payment_marker_failed', { sessionId: session?.id, tier: checkoutFacts(session).tier, error: err.message });
    }
    return;
  }
  if (recorded.status === 'skipped') return;
  if (recorded.status === 'duplicate') {
    if (recorded.concurrent) return;
    // Still persist identity: a prior run may have written the Payments
    // marker and then died before subscriptions.update, leaving cancel
    // events with empty metadata — and the billing reset, likewise.
    const tier = session.metadata?.tier ?? null;
    await persistSubscriptionIdentity(session, recorded.customerEmail, tier);
    await activateMonthlyBilling(session, recorded.customerEmail, tier, { redelivery: true });
    return;
  }
  await fulfilCheckout(session, { redelivery: false });
}

// ---------------------------------------------------------------------------
// Subscription lifecycle handlers
// ---------------------------------------------------------------------------

// A paid monthly checkout (first purchase or a re-subscribe after cancel)
// resets Billing State to active: grant paths refuse 'cancelled', and
// invoice.payment_succeeded may not reach this endpoint. Runs on redelivery
// too (the first run may have died before it). The subscription's live
// status decides, so a stale redelivered checkout can't re-activate a member
// who has since cancelled; if Stripe can't be read, only a first-pass event
// (just paid) is trusted.
async function activateMonthlyBilling(session, customerEmail, tier, { redelivery }) {
  if (resolveEntitlementFromSku(tier) !== 'monthly_membership' || !customerEmail) return;
  const subId = subscriptionIdFrom(session);
  let live = null;
  let periodEndUnix = null;
  if (subId && process.env.STRIPE_SECRET_KEY) {
    try {
      const sub = await stripeClient().subscriptions.retrieve(subId);
      live = sub?.status ?? null;
      periodEndUnix = sub?.current_period_end ?? null;
    } catch (err) { console.error(`[Stripe] subscription status lookup failed for ${subId}: ${err.message}`); }
  }
  if (live ? !['active', 'trialing'].includes(live) : redelivery) {
    console.log(`[Stripe] Not re-activating monthly billing (subscription status=${live ?? 'unknown'}, redelivery=${redelivery})`);
    return;
  }
  const state = { entitlementType: 'monthly_membership', status: 'active', billingState: 'active' };
  // Paid-through date from the live subscription, so the revocation backstop
  // has an expiry even if invoice.payment_succeeded never reaches us.
  if (live && periodEndUnix) state.expiresAt = new Date(periodEndUnix * 1000).toISOString();
  await updateEntitlementState(customerEmail, state).catch(async (err) => {
    console.error(`[Stripe] updateEntitlementState (checkout) failed: ${err.message}`);
    await sendAlert('stripe.entitlement_write_failed', { source: 'checkout.session.completed', error: err.message });
  });
}

// Before a monthly cancellation/lapse mutates a member, make sure the event
// is about the subscription that actually entitles them. Checkout is
// unauthenticated, so anyone can open (and cancel, or abandon) a $29.99
// subscription under a member's email. Returns:
//   'yes'     — the email still has ANOTHER active/trialing monthly sub: don't revoke
//   'no'      — checked every customer/subscription for the email: safe to revoke
//   'unknown' — Stripe errored, or more records than the scan cap (an
//               attacker can create customers to bury the real one): don't revoke,
//               alert for a manual check.
const OTHER_SUB_SCAN_CAP = 1000;
async function listAll(listFn, params) {
  const out = [];
  let starting_after;
  for (;;) {
    const page = await listFn({ ...params, limit: 100, ...(starting_after ? { starting_after } : {}) });
    const data = page?.data ?? [];
    out.push(...data);
    if (out.length > OTHER_SUB_SCAN_CAP) throw new Error('scan cap exceeded');
    if (!page?.has_more || !data.length) return out;
    starting_after = data[data.length - 1].id;
  }
}
async function otherActiveMonthlySubscription(email, excludeSubId) {
  // No Stripe configured (local dev) — nothing to check against.
  if (!email || !process.env.STRIPE_SECRET_KEY) return 'no';
  try {
    const stripe = stripeClient();
    const customers = await listAll((p) => stripe.customers.list(p), { email });
    let scanned = 0;
    for (const c of customers) {
      const subs = await listAll((p) => stripe.subscriptions.list(p), { customer: c.id, status: 'all' });
      scanned += subs.length;
      if (scanned > OTHER_SUB_SCAN_CAP) throw new Error('scan cap exceeded');
      for (const sub of subs) {
        if (sub.id === excludeSubId || !['active', 'trialing'].includes(sub.status)) continue;
        const cents = sub.items?.data?.[0]?.price?.unit_amount;
        const isMonthly = sub.metadata?.tier
          ? resolveEntitlementFromSku(sub.metadata.tier) === 'monthly_membership'
          : typeof cents === 'number' && inferTierFromAmount(cents) === 'comm_monthly';
        if (isMonthly) return 'yes';
      }
    }
    return 'no';
  } catch (err) {
    console.error(`[Stripe] other-subscription check failed: ${err.message}`);
    return 'unknown';
  }
}

// True when this monthly event must NOT revoke/downgrade the member.
async function shouldHoldMonthlyChange(email, subscription, source) {
  const other = await otherActiveMonthlySubscription(email, subscription?.id);
  if (other === 'no') return false;
  if (other === 'unknown') {
    await sendAlert('stripe.monthly_change_held', { source, subscriptionId: subscription?.id ?? null }).catch(() => {});
  }
  console.warn(`[Stripe] ${source} for ${subscription?.id} held (other active monthly sub: ${other})`);
  return true;
}

// A subscription with no metadata.tier (older checkouts) falls back to the
// member's Entitlement Type — but not when the subscription's own price
// identifies a different plan: cancelling an untagged Pro Retainer must not
// touch the same email's monthly community membership.
function untaggedSubscriptionIsMonthly(subscription, member) {
  if (member?.fields?.['Entitlement Type'] !== 'monthly_membership') return false;
  const cents = subscription?.items?.data?.[0]?.price?.unit_amount;
  if (typeof cents !== 'number') return true;
  return inferTierFromAmount(cents) === 'comm_monthly';
}

export async function handleSubscriptionDeleted(subscription) {
  const customerEmail = await resolveSubscriptionEmail(subscription);
  const tier = subscription.metadata?.tier ?? null;
  if (!customerEmail) {
    console.warn('[Stripe] subscription.deleted — could not resolve customer email, skipping revocation');
    await sendAlert('stripe.subscription_deleted_no_email', {
      subscriptionId: subscription?.id ?? null,
      customerId: customerIdFrom(subscription),
    });
    return;
  }
  // A subscription that never became active (abandoned / unpaid checkout)
  // never entitled anyone, so its deletion must not revoke anything.
  if (subscription?.status === 'incomplete_expired') {
    console.log(`[Stripe] subscription.deleted for never-activated ${subscription?.id} — nothing to revoke`);
    return;
  }
  console.log(`[Stripe] Subscription ${subscription?.id ?? 'unknown'} cancelled tier=${tier} — revoking access`);

  const member = await findMemberByEmail(customerEmail).catch(() => null);
  let entitlementKey = tier ? resolveEntitlementFromSku(tier) : null;
  // Historical subs whose checkout PATCH never ran have empty metadata.tier.
  // invoice.payment_succeeded still stamped Members.Entitlement Type.
  if (!entitlementKey && untaggedSubscriptionIsMonthly(subscription, member)) {
    entitlementKey = 'monthly_membership';
  }

  if (entitlementKey === 'monthly_membership'
      && await shouldHoldMonthlyChange(customerEmail, subscription, 'subscription.deleted')) {
    return;
  }

  if (entitlementKey === 'monthly_membership') {
    await updateEntitlementState(customerEmail, { billingState: 'cancelled' }).catch((e) => {
      console.error(`[Stripe] Failed to stamp cancelled billing state: ${e.message}`);
    });
  }

  // Immediately remove Discord role — only for entitlements that allow revocation on cancellation
  const entitlementCfg = entitlementKey ? ENTITLEMENT_MAP[entitlementKey] : null;

  // Mark revoked only when this cancellation actually revokes
  // something; cancelling a permanent-entitlement sub (retainer/enterprise)
  // must not flag the member's other, still-valid Discord access.
  if (entitlementCfg?.revokeOnCancel) {
    await updateDiscordSyncStatus(customerEmail, 'revoked').catch(e => {
      console.error(`[Stripe] Failed to mark revocation: ${e.message}`);
    });
  }
  const roleId = entitlementCfg?.revokeOnCancel ? getRoleId(entitlementKey) : null;
  let removed = true;
  if (roleId) {
    try {
      const discordId = member?.fields?.['Discord ID'];
      if (discordId) {
        await removeRoleFromMember(discordId, roleId);
        console.log(`[Stripe] Removed Discord role ${roleId} from discordId=${discordId}`);
      } else {
        console.log(`[Stripe] No Discord ID for subscription ${subscription?.id ?? 'unknown'} member — role removal skipped`);
      }
    } catch (err) {
      removed = false;
      console.error(`[Stripe] Discord role removal failed: ${err.message}`);
    }
  } else {
    console.log(`[Stripe] Entitlement "${entitlementKey}" for tier="${tier}" is not revocable — Discord role retained`);
  }

  // Revocation done: entitlement_status 'revoked' takes the member off the
  // nightly out-of-sync list (no repeat revocation). A failed role removal
  // stays 'active' so reconcile retries it after the grace window.
  if (entitlementCfg?.revokeOnCancel && removed) {
    await updateEntitlementState(customerEmail, { status: 'revoked' }).catch((e) => {
      console.error(`[Stripe] Failed to mark entitlement revoked: ${e.message}`);
    });
  }
}

// A subscription invoice paid — the FIRST payment and every renewal. This is what
// keeps the revocation backstop alive: it stamps the monthly member's entitlement
// state so listOutOfSyncEntitlements can find (and shouldRevokeAccess can judge)
// them. Without it, those fields were never written and the backstop matched no one,
// so cancelled monthly members kept their Discord role forever.
//
// Only comm_monthly is recurring+revocable; retainer/enterprise subscriptions are
// permanent, so we skip them (identified by the paid amount). Uses invoice.customer_email,
// NOT subscription metadata, so a renewal isn't blocked by the metadata-write bug.
export async function handleInvoicePaymentSucceeded(invoice) {
  const amountPaid = invoice.amount_paid ?? invoice.total ?? 0; // cents
  // The tier checkout stamped on the subscription beats amount inference
  // (a promo-discounted or $0 renewal doesn't match the list price).
  const metaTier = invoice.subscription_details?.metadata?.tier ?? invoice.lines?.data?.[0]?.metadata?.tier ?? null;
  const tier = metaTier ?? inferTierFromAmount(amountPaid);
  const entitlementKey = tier ? resolveEntitlementFromSku(tier) : null;
  if (entitlementKey !== 'monthly_membership') {
    console.log(`[Stripe] invoice.payment_succeeded amount=${amountPaid} tier=${tier} — not monthly membership, no entitlement write`);
    return;
  }
  const email = invoice.customer_email ?? invoice.subscription_details?.metadata?.email ?? null;
  if (!email) {
    console.warn('[Stripe] invoice.payment_succeeded (monthly) but no customer_email — skipping entitlement write');
    return;
  }
  // Same live-status gate as activateMonthlyBilling. Stripe redelivers this
  // event, and it can arrive after customer.subscription.deleted; without the
  // gate a cancelled monthly member is stamped active again and the grant paths
  // restore Genesis. Only ended statuses block: past_due / incomplete still
  // stamp (this payment is what recovers them), and so does an unreadable
  // Stripe (a paid invoice is never dropped on a lookup error).
  const invoiceSub = invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null;
  const subId = typeof invoiceSub === 'string' ? invoiceSub : invoiceSub?.id ?? null;
  if (subId && process.env.STRIPE_SECRET_KEY) {
    let live = null;
    try { live = (await stripeClient().subscriptions.retrieve(subId))?.status ?? null; }
    catch (err) { console.error(`[Stripe] subscription status lookup failed for ${subId}: ${err.message}`); }
    if (['canceled', 'incomplete_expired', 'paused'].includes(live)) {
      console.log(`[Stripe] invoice.payment_succeeded for an ended subscription (status=${live}) — not re-activating`);
      return;
    }
  }
  // Paid-through date. Pushing it forward each cycle keeps an active member out of the
  // revoke set; a genuinely lapsed member falls into it after the grace period.
  const periodEndUnix = invoice.lines?.data?.[0]?.period?.end ?? invoice.period_end ?? null;
  const expiresAt = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : undefined;
  try {
    await updateEntitlementState(email, {
      entitlementType: 'monthly_membership',
      status: 'active',
      expiresAt,
      billingState: 'active',
    });
    console.log(`[Stripe] Entitlement renewed through ${expiresAt ?? 'unknown'} for a monthly member`);
  } catch (err) {
    console.error(`[Stripe] updateEntitlementState (renewal) failed: ${err.message}`);
    await sendAlert('stripe.entitlement_write_failed', { source: 'invoice.payment_succeeded', error: err.message });
  }
}

// Subscription status changed (past_due / unpaid / canceled / reactivated). Records
// the billing state the revocation backstop reads, and refreshes the paid-through
// date. Only monthly membership is tracked (metadata.tier set at checkout).
export async function handleSubscriptionUpdated(subscription) {
  const email = await resolveSubscriptionEmail(subscription);
  const tier = subscription.metadata?.tier ?? null;
  let entitlementKey = tier ? resolveEntitlementFromSku(tier) : null;
  if (!email) {
    console.warn('[Stripe] subscription.updated — could not resolve customer email, skipping billing-state write');
    return;
  }
  if (!entitlementKey) {
    const member = await findMemberByEmail(email).catch(() => null);
    if (untaggedSubscriptionIsMonthly(subscription, member)) {
      entitlementKey = 'monthly_membership';
    }
  }
  if (entitlementKey !== 'monthly_membership') {
    console.log(`[Stripe] subscription.updated tier="${tier}" — not monthly membership, no billing-state write`);
    return;
  }
  const status = subscription.status ?? '';
  let billingState;
  if (status === 'active' || status === 'trialing') billingState = 'active';
  else if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') billingState = 'past_due';
  else if (status === 'canceled') billingState = 'cancelled';
  else billingState = status;
  const periodEndUnix = subscription.current_period_end ?? null;
  const expiresAt = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : undefined;
  if (billingState !== 'active' && await shouldHoldMonthlyChange(email, subscription, 'subscription.updated')) {
    return;
  }
  try {
    await updateEntitlementState(email, { billingState, expiresAt });
    console.log(`[Stripe] Billing state → ${billingState} (subscription status=${status})`);
  } catch (err) {
    console.error(`[Stripe] updateEntitlementState (subscription.updated) failed: ${err.message}`);
    await sendAlert('stripe.entitlement_write_failed', { source: 'customer.subscription.updated', error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Refunds and disputes
// ---------------------------------------------------------------------------

/** Only a full refund revokes; a partial refund (goodwill credit) keeps the pass. */
export function isFullRefund(charge) {
  if (charge?.refunded === true) return true;
  const amount = charge?.amount;
  const refunded = charge?.amount_refunded;
  return typeof amount === 'number' && typeof refunded === 'number' && amount > 0 && refunded >= amount;
}

// A Stripe reference that may be an id string or an expanded object.
function idOf(ref) {
  if (typeof ref === 'string') return ref || null;
  return ref?.id ?? null;
}

function paymentIntentIdFrom(obj) {
  return idOf(obj?.payment_intent);
}

/**
 * The Checkout Session (our Payments transaction id) behind a charge or dispute.
 *
 * One-time purchases: the session carries the PaymentIntent. Subscription-mode
 * sessions (Genesis, Ember, Obsidian) have payment_intent null — the charge
 * belongs to an invoice — so fall back to charge → invoice → subscription →
 * session. `charge.invoice` is absent on newer API versions; the PaymentIntent
 * still carries it. Returns { session, invoice } (invoice only on the
 * subscription path) or null.
 */
async function resolveReversalSession(source, { isDispute }) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const stripe = stripeClient();
  const paymentIntentId = paymentIntentIdFrom(source);

  if (paymentIntentId) {
    const page = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
    const session = page?.data?.[0] ?? null;
    if (session) return { session, invoice: null };
  }

  let invoiceId = null;
  if (isDispute) {
    const charge = source?.charge;
    if (charge && typeof charge === 'object') invoiceId = idOf(charge.invoice);
    else if (typeof charge === 'string') invoiceId = idOf((await stripe.charges.retrieve(charge))?.invoice);
  } else {
    invoiceId = idOf(source?.invoice);
  }
  if (!invoiceId && paymentIntentId) {
    invoiceId = idOf((await stripe.paymentIntents.retrieve(paymentIntentId))?.invoice);
  }
  if (!invoiceId) return null;

  const invoice = await stripe.invoices.retrieve(invoiceId);
  const subscriptionId = idOf(invoice?.subscription)
    ?? idOf(invoice?.parent?.subscription_details?.subscription);
  if (!subscriptionId) return null;
  const page = await stripe.checkout.sessions.list({ subscription: subscriptionId, limit: 1 });
  const session = page?.data?.[0] ?? null;
  return session ? { session, invoice } : null;
}

// The checkout's own (first) invoice — the one that paid for the pass.
function isFirstSubscriptionInvoice(invoice, session) {
  return invoice?.billing_reason === 'subscription_create'
    || (idOf(session?.invoice) !== null && idOf(session?.invoice) === invoice?.id);
}

/**
 * Revoke the pass bought by one payment: mint row → Revoked, and the Discord
 * role of THAT entitlement only — and only when no other active mint of the
 * same NFT type remains for the email (a second purchase still entitles them).
 * A Failed row is revoked too, so retry-mints can't mint a refunded purchase.
 */
async function revokeCheckoutEntitlement(transactionId, reason) {
  const mint = await findMintByPaymentId(transactionId);
  if (!mint) {
    console.log(`[Stripe] ${reason} for ${transactionId}: no mint row — nothing to revoke`);
    return;
  }
  const nftType = mint.fields?.['NFT Type'] ?? null;
  const email = mint.fields?.['Email'] ?? null;
  const entitlementKey = resolveEntitlementFromNftType(nftType);

  if (mint.fields?.['Mint Status'] !== 'Revoked') {
    await updateNftMint(mint.id, { 'Mint Status': 'Revoked', 'Revoked At': new Date().toISOString() });
  }
  if (!email || !entitlementKey) return;

  const others = (await findActiveMintsByEmail(email))
    .filter((r) => r.id !== mint.id && r.fields?.['NFT Type'] === nftType);
  if (others.length > 0) {
    console.log(`[Stripe] ${reason} for ${transactionId}: another active ${nftType} remains — role kept`);
    await sendAlert('stripe.entitlement_revoked', { transactionId, nftType, reason, roleRemoved: false, otherActive: others.length },
      { severity: 'info', dedupeKey: `${reason}:${transactionId}` }).catch(() => {});
    return;
  }

  if (entitlementKey === 'monthly_membership') {
    await updateEntitlementState(email, { entitlementType: 'monthly_membership', billingState: 'cancelled' });
  }

  let roleRemoved = false;
  let roleError = null;
  const roleId = getRoleId(entitlementKey);
  const discordId = roleId ? (await findMemberByEmail(email))?.fields?.['Discord ID'] : null;
  if (roleId && discordId) {
    try {
      await removeRoleFromMember(discordId, roleId);
      roleRemoved = true;
    } catch (err) {
      roleError = err.message;
      console.error(`[Stripe] ${reason}: Discord role removal failed for ${transactionId}: ${err.message}`);
    }
  }
  await sendAlert('stripe.entitlement_revoked', {
    transactionId, nftType, reason, roleRemoved, ...(roleError ? { roleError } : {}),
  }, { severity: roleError ? 'warning' : 'info', dedupeKey: `${reason}:${transactionId}` }).catch(() => {});
}

async function settleReversal(source, { status, reason, sourceId, isDispute = false }) {
  const resolved = await resolveReversalSession(source, { isDispute });
  if (!resolved) {
    const paymentIntentId = paymentIntentIdFrom(source);
    console.warn(`[Stripe] ${reason} ${sourceId}: no Checkout Session for payment_intent ${paymentIntentId ?? 'none'}`);
    await sendAlert('stripe.refund_unmatched', { reason, sourceId, paymentIntentId },
      { severity: 'info', dedupeKey: `${reason}:${sourceId}` }).catch(() => {});
    return;
  }
  const { session, invoice } = resolved;
  // Policy: only the subscription's first invoice bought the pass. Refunding
  // or disputing a later renewal changes nothing here (cancellation, if any,
  // arrives as customer.subscription.* events).
  if (invoice && !isFirstSubscriptionInvoice(invoice, session)) {
    console.log(`[Stripe] ${reason} ${sourceId}: renewal invoice ${invoice.id} of ${session.id} — no change`);
    await sendAlert('stripe.renewal_refund_ignored', { sessionId: session.id, invoiceId: invoice.id, tier: session.metadata?.tier ?? null },
      { severity: 'info', dedupeKey: invoice.id }).catch(() => {});
    return;
  }
  const transactionId = session.id;
  const payment = await updatePaymentStatus(transactionId, status);
  if (!payment) console.warn(`[Stripe] ${reason} for ${transactionId}: no Payments row to mark ${status}`);
  await revokeCheckoutEntitlement(transactionId, reason);
}

export async function handleChargeRefunded(charge) {
  if (!isFullRefund(charge)) {
    console.log(`[Stripe] charge.refunded ${charge?.id}: partial refund (${charge?.amount_refunded ?? 0}/${charge?.amount ?? 0}) — no change`);
    return;
  }
  await settleReversal(charge, { status: 'Refunded', reason: 'refund', sourceId: charge?.id ?? null });
}

export async function handleDisputeCreated(dispute) {
  await settleReversal(dispute, { status: 'Disputed', reason: 'dispute', sourceId: dispute?.id ?? null, isDispute: true });
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------

// Every event the live endpoint must be subscribed to; the handler below handles
// each one (a test keeps the two in step). Lives in a dependency-free module so
// /api/health can read it without loading this file's import graph.
export { REQUIRED_STRIPE_EVENTS } from '../_lib/stripe-events.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Stripe] STRIPE_WEBHOOK_SECRET not set');
    await sendAlert('stripe.webhook_unconfigured', {}, { severity: 'critical', dedupeKey: 'config' }).catch(() => {});
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // Read raw body — Vercel provides req.body as Buffer when bodyParser is disabled
  let rawBody;
  try {
    rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  } catch (err) {
    console.error(`[Stripe] Failed to read request body: ${err.message}`);
    return res.status(400).json({ error: 'Failed to read body' });
  }

  // Verify signature
  try {
    verifyStripeSignature(rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error(`[Stripe] Signature verification failed: ${err.message}`);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error(`[Stripe] Failed to parse event JSON: ${err.message}`);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log(`[Stripe] Received event type="${event.type}" id="${event.id}"`);

  // Background work is registered with waitUntil BEFORE acking 200: Vercel keeps
  // the function alive until it settles. Acking fast keeps us inside Stripe's
  // ~10s window. A crash there can't be retried by Stripe (it already got 200),
  // so it must page someone.
  const background = (promise) => waitUntil(promise.catch((err) => {
    console.error(`[Stripe] Unhandled ${event.type} error: ${err.message}`, err.stack);
    return sendAlert('stripe.pipeline_crashed', { eventId: event.id, type: event.type, error: err.message },
      { severity: 'critical', dedupeKey: event.id }).catch(() => {});
  }));

  const object = event.data?.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      // The Payments marker is written BEFORE the ack. If it can't be, answer
      // 500 so Stripe redelivers — a 200 here would lose the purchase.
      let recorded;
      try {
        recorded = await recordCheckoutPayment(object);
      } catch (err) {
        await sendAlert('stripe.payment_marker_failed', { sessionId: object?.id ?? null, error: err.message },
          { severity: 'critical', dedupeKey: object?.id ?? event.id }).catch(() => {});
        return res.status(500).json({ error: 'Payment not recorded' });
      }
      if (recorded.status === 'recorded') {
        background(fulfilCheckout(object, { redelivery: false }));
      } else if (recorded.status === 'duplicate') {
        background(fulfilCheckout(object, {
          redelivery: true, concurrent: recorded.concurrent === true, paymentStatus: recorded.paymentStatus ?? null,
        }));
      }
      break;
    }
    case 'checkout.session.async_payment_failed':
      console.log(`[Stripe] async payment failed for session ${object?.id} — not fulfilling`);
      break;
    case 'customer.subscription.deleted':
      background(handleSubscriptionDeleted(object));
      break;
    case 'customer.subscription.updated':
      background(handleSubscriptionUpdated(object));
      break;
    case 'invoice.payment_succeeded':
      background(handleInvoicePaymentSucceeded(object));
      break;
    case 'invoice.payment_failed':
      console.log(`[Stripe] invoice.payment_failed for subscription ${object?.subscription} — logged only`);
      break;
    case 'charge.refunded':
      background(handleChargeRefunded(object));
      break;
    case 'charge.dispute.created':
      background(handleDisputeCreated(object));
      break;
    default:
      console.log(`[Stripe] Ignoring event type="${event.type}"`);
  }

  // Acknowledge receipt. Work continues in the background via waitUntil.
  return res.status(200).json({ received: true });
}

// Disable Vercel's automatic body parsing so we get the raw body for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};
