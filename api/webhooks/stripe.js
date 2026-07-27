/**
 * Stripe webhook handler — POST /api/webhooks/stripe
 *
 * Vercel serverless function (ESM, Node 20+).
 * Handles checkout.session.completed → mints NFT → updates Airtable → sends email.
 */

import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { TIER_NFT_MAP, inferTierFromAmount, getNextSerial, formatSerial } from '../_lib/tiers.js';
import { mintToEmail } from '../_lib/crossmint.js';
import { createPayment, createNftMint, updateDiscordSyncStatus, findMemberByEmail, findPaymentByTransactionId, updateEntitlementState } from '../_lib/airtable.js';
import { sendNftDelivery, sendPurchaseConfirmation } from '../_lib/email.js';
import { resolveEntitlementFromSku, getRoleId, ENTITLEMENT_MAP } from '../_lib/entitlements.js';
import { removeRoleFromMember } from '../_lib/discord-bot.js';
import { sendAlert } from '../_lib/alert.js';

// ---------------------------------------------------------------------------
// Stripe signature verification (no Stripe SDK dependency)
// ---------------------------------------------------------------------------

function verifyStripeSignature(rawBody, sigHeader, secret) {
    if (!sigHeader) throw new Error('Missing Stripe-Signature header');

  const parts = Object.fromEntries(
        sigHeader.split(',').map((part) => part.split('='))
      );
    const timestamp = parts['t'];
    const v1 = parts['v1'];

  if (!timestamp || !v1) throw new Error('Malformed Stripe-Signature header');

  // Reject events older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
          throw new Error('Stripe webhook timestamp too old — possible replay attack');
    }

  const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

  const v1Buf = Buffer.from(v1, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (v1Buf.length !== expBuf.length) throw new Error('Stripe signature length mismatch');
    const match = crypto.timingSafeEqual(v1Buf, expBuf);

  if (!match) throw new Error('Stripe signature mismatch');
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

export async function handleCheckoutSessionCompleted(session) {
    const sessionId = session.id;
    const customerEmail = session.customer_details?.email ?? session.customer_email;
    const customerName = session.customer_details?.name ?? 'Aurevon Member';
    const amountTotal = session.amount_total ?? 0; // cents

  if (!customerEmail) {
        console.error(`[Stripe] No customer email on session ${sessionId} — aborting pipeline`);
        return;
  }

  // ── Idempotency guard ──────────────────────────────────────────────────────
  // Stripe redelivers an event whenever it doesn't receive a 2xx (network blip,
  // timeout). The Payments row written below is the dedup marker: if one already
  // exists for this session, this is a redelivery and we must NOT mint again.
  // If the lookup itself fails we abort rather than risk a blind double-mint —
  // Stripe (or the reconcile cron) can retry once Airtable is healthy.
  try {
        const prior = await findPaymentByTransactionId(sessionId);
        if (prior) {
                console.log(`[Stripe] Session ${sessionId} already processed (Payments row exists) — skipping to avoid double-mint`);
                return;
        }
  } catch (err) {
        console.error(`[Stripe] Idempotency lookup failed for ${sessionId}: ${err.message} — aborting before mint`);
        await sendAlert('stripe.idempotency_lookup_failed', { sessionId, error: err.message });
        return;
  }

  console.log(`[Stripe] Processing session ${sessionId} for ${customerEmail} amount=${amountTotal}`);

  // 1. Resolve tier — prefer metadata, fall back to amount
  let tier = session.metadata?.tier ?? null;
    if (!tier) {
          tier = inferTierFromAmount(amountTotal);
          console.log(`[Stripe] No metadata.tier — inferred tier="${tier}" from amount ${amountTotal}`);
    }
    if (!tier) {
          console.warn(`[Stripe] Could not determine tier for session ${sessionId}. Treating as unknown.`);
          tier = 'unknown';
    }

  const amount = amountTotal / 100;
    const token = `paid_${tier}_${Date.now()}`;
    const now = new Date().toISOString();

  // 2. Write Payments row — this is the idempotency MARKER and must land before
  //    the irreversible Crossmint mint. If it fails we abort: minting without a
  //    persisted marker would let a later redelivery double-mint. No marker ⇒ no mint.
  try {
        await createPayment({
                transactionId: sessionId,
                method: 'Stripe Card',
                tier,
                amount,
                customerEmail,
                customerName,
                status: 'Succeeded',
                token,
        });
  } catch (err) {
        console.error(`[Stripe] createPayment (idempotency marker) failed for ${sessionId}: ${err.message} — aborting before mint`);
        await sendAlert('stripe.payment_marker_failed', { sessionId, tier, error: err.message });
        return;
  }

  // If subscription mode, save customer email in subscription metadata
  // so customer.subscription.deleted events can identify the customer
  if (session.mode === 'subscription' && session.subscription && customerEmail) {
    try {
      const StripeSDK = (await import('stripe')).default;
      const stripeClient = new StripeSDK(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
      await stripeClient.subscriptions.update(session.subscription, {
        metadata: { email: customerEmail, tier },
      });
      console.log(`[Stripe] Saved email to subscription ${session.subscription} metadata`);
    } catch (err) {
      console.error(`[Stripe] Could not update subscription metadata: ${err.message}`);
    }
  }

  // 3. Determine NFT mapping
  const tierConfig = TIER_NFT_MAP[tier] ?? null;
    const nftType = tierConfig?.nft ?? null;
    const templateKey = tierConfig?.template ?? null;
    const serialPrefix = tierConfig?.serialPrefix ?? null;
    const collectionName = tierConfig?.collectionName ?? null;

  // 4. No NFT tier — send confirmation only
  if (!nftType) {
        console.log(`[Stripe] Tier "${tier}" has no NFT. Sending purchase confirmation email.`);
        try {
                await sendPurchaseConfirmation({ email: customerEmail, customerName, tier });
        } catch (err) {
                console.error(`[Stripe] Confirmation email failed: ${err.message}`);
        }
        return;
  }

  // 5. Get next serial number for this collection
  let serial = null;
    if (serialPrefix) {
          try {
                  serial = await getNextSerial(serialPrefix);
                  console.log(`[Stripe] Assigned serial ${serial} for tier "${tier}"`);
          } catch (err) {
                  console.error(`[Stripe] getNextSerial failed: ${err.message}. Continuing without serial.`);
          }
    }

  // 6. Mint NFT via Crossmint
  let mintId = null;
    let imageUrl = null;
    let mintStatus;
    let mintNotes = '';

  try {
        const result = await mintToEmail({
                email: customerEmail,
                nftType,
                customerName,
                templateKey,
                serial,
                collectionName,
                tierKey: tier,
                // Idempotency key = Stripe session id. If this mint succeeds but the
                // NFT_Mints write below fails, orphan-recovery → retry-mints re-calls
                // Crossmint with THIS SAME key, which returns the existing NFT instead
                // of minting a second on-chain asset (the double-mint fix).
                idempotencyKey: sessionId,
        });
        if (!result.ok) throw new Error(result.error ?? 'Crossmint API returned ok:false');
        mintId = result.actionId;
        imageUrl = result.imageUrl ?? null;
        mintStatus = 'Sent';
        console.log(`[Stripe] Mint succeeded: mintId=${mintId}, serial=${serial}`);
  } catch (err) {
        mintStatus = 'Failed';
        mintNotes = `Crossmint error: ${err.message}`;
        console.error(`[Stripe] Crossmint mint failed: ${err.message}`);
        await sendAlert('stripe.mint_failed', { sessionId, tier, nftType, error: err.message });
  }

  // 7. Write NFT_Mints row — use serial as the reference; retry on collision (race condition guard)
  const reference = serial ?? `MINT_${sessionId.slice(-8)}_${nftType.replace(/\s+/g, '_')}`;
    let insertedSerial = serial;
    let mintRowWritten = false;

  for (let attempt = 0; attempt < 3; attempt++) {
        const ref = attempt === 0 ? reference : (() => {
                if (!insertedSerial) {
                        // Null-serial tier (no serialPrefix): append retry index to avoid identical retries
                        return `${reference}_r${attempt}`;
                }
                const parts = insertedSerial.split('_');
                const prefix = parts[0];
                const num = parseInt(parts[1] ?? '0', 10) + 1;
                insertedSerial = formatSerial(prefix, num);
                return insertedSerial;
        })();

      try {
              await createNftMint({
                        reference: ref,
                        email: customerEmail,
                        nftType,
                        tierSource: tier,
                        status: mintStatus,
                        sentDate: now,
                        emailDelivered: mintStatus === 'Sent',
                        notes: mintNotes,
                        mintId: mintId ?? '',
                        retryCount: 0,
              });
              if (!insertedSerial) insertedSerial = ref; // track actual ref for null-serial tiers
              mintRowWritten = true;
              console.log(`[Stripe] NFT_Mints record created with reference=${ref}`);
              break;
      } catch (err) {
              const isDuplicate = err.message.includes('422') || err.message.toLowerCase().includes('already exists') || err.message.toLowerCase().includes('duplicate');
              if (isDuplicate && attempt < 2) {
                        console.warn(`[Stripe] Reference collision on "${ref}" (attempt ${attempt + 1}) — incrementing serial and retrying`);
              } else {
                        console.error(`[Stripe] Airtable createNftMint failed (attempt ${attempt + 1}): ${err.message}`);
                        break;
              }
      }
  }

  // If the on-chain mint SUCCEEDED but no NFT_Mints row landed, this purchase is an
  // orphan: the mint exists but nothing records it. Orphan-recovery + the idempotent
  // mint key make it self-heal (no double-mint), but it must NOT be silent — alert so
  // it's confirmed rather than discovered by a customer complaint.
  if (!mintRowWritten) {
        await sendAlert('stripe.mint_row_dropped', { sessionId, tier, nftType, minted: mintStatus === 'Sent' });
  }

  // 8. Parse edition number from serial for email
  let edition = null;
    if (insertedSerial) {
          const parts = insertedSerial.split('_');
          if (parts[1]) edition = parseInt(parts[1], 10);
    }

  // 9. Send branded delivery email (even on mint failure — email with partial info)
  try {
        await sendNftDelivery({
                email: customerEmail,
                customerName,
                nftType,
                mintId: mintId ?? 'pending',
                nftImageUrl: imageUrl,
                discordInviteUrl: process.env.DISCORD_INVITE_URL,
                tier,
                serial: insertedSerial,
                edition,
        });
  } catch (err) {
        console.error(`[Stripe] Resend email failed: ${err.message}`);
  }

  console.log(`[Stripe] Pipeline complete for session ${sessionId}`);
}

// ---------------------------------------------------------------------------
// Subscription lifecycle handlers
// ---------------------------------------------------------------------------

async function handleSubscriptionDeleted(subscription) {
  const customerEmail = subscription.metadata?.email ?? null;
  const tier = subscription.metadata?.tier ?? null;
  if (!customerEmail) {
    console.warn('[Stripe] subscription.deleted — no email in subscription metadata, skipping revocation');
    return;
  }
  console.log(`[Stripe] Subscription cancelled for ${customerEmail} tier=${tier} — revoking access`);

  // Mark revoked in Airtable
  await updateDiscordSyncStatus(customerEmail, 'revoked').catch(e => {
    console.error(`[Stripe] Failed to mark revocation in Airtable: ${e.message}`);
  });

  // Immediately remove Discord role — only for entitlements that allow revocation on cancellation
  const entitlementKey = tier ? resolveEntitlementFromSku(tier) : null;
  const entitlementCfg = entitlementKey ? ENTITLEMENT_MAP[entitlementKey] : null;
  const roleId = entitlementCfg?.revokeOnCancel ? getRoleId(entitlementKey) : null;
  if (roleId) {
    try {
      const member = await findMemberByEmail(customerEmail).catch(() => null);
      const discordId = member?.fields?.['Discord ID'];
      if (discordId) {
        await removeRoleFromMember(discordId, roleId);
        console.log(`[Stripe] Removed Discord role ${roleId} from discordId=${discordId}`);
      } else {
        console.log(`[Stripe] No Discord ID for ${customerEmail} — role removal skipped`);
      }
    } catch (err) {
      console.error(`[Stripe] Discord role removal failed: ${err.message}`);
    }
  } else {
    console.log(`[Stripe] Entitlement "${entitlementKey}" for tier="${tier}" is not revocable — Discord role retained`);
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
  const tier = inferTierFromAmount(amountPaid);
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
  const email = subscription.metadata?.email ?? null;
  const tier = subscription.metadata?.tier ?? null;
  const entitlementKey = tier ? resolveEntitlementFromSku(tier) : null;
  if (!email) {
    console.warn('[Stripe] subscription.updated — no email in subscription metadata, skipping billing-state write');
    return;
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
  try {
    await updateEntitlementState(email, { billingState, expiresAt });
    console.log(`[Stripe] Billing state → ${billingState} (subscription status=${status})`);
  } catch (err) {
    console.error(`[Stripe] updateEntitlementState (subscription.updated) failed: ${err.message}`);
    await sendAlert('stripe.entitlement_write_failed', { source: 'customer.subscription.updated', error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
    if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed' });
    }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
          console.error('[Stripe] STRIPE_WEBHOOK_SECRET not set');
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

  // Register the pipeline with waitUntil BEFORE acking 200. Vercel keeps the
  // function alive until the registered promise settles, so the work runs
  // durably instead of being frozen after res.end(). Acking fast (rather than
  // awaiting the full pipeline) keeps us inside Stripe's ~10s window and avoids
  // the timeout→redelivery loop that could disable the endpoint. The idempotency
  // guard above makes any redelivery that does occur a safe no-op.
  if (event.type === 'checkout.session.completed') {
        waitUntil(
                handleCheckoutSessionCompleted(event.data.object).catch((err) => {
                        console.error(`[Stripe] Unhandled pipeline error: ${err.message}`, err.stack);
                })
        );
  } else if (event.type === 'customer.subscription.deleted') {
        waitUntil(
                handleSubscriptionDeleted(event.data.object).catch((err) => {
                        console.error(`[Stripe] Unhandled subscription.deleted error: ${err.message}`, err.stack);
                })
        );
  } else if (event.type === 'invoice.payment_succeeded') {
        waitUntil(
                handleInvoicePaymentSucceeded(event.data.object).catch((err) => {
                        console.error(`[Stripe] Unhandled invoice.payment_succeeded error: ${err.message}`, err.stack);
                })
        );
  } else if (event.type === 'customer.subscription.updated') {
        waitUntil(
                handleSubscriptionUpdated(event.data.object).catch((err) => {
                        console.error(`[Stripe] Unhandled subscription.updated error: ${err.message}`, err.stack);
                })
        );
  } else if (event.type === 'invoice.payment_failed') {
        console.log(`[Stripe] invoice.payment_failed for subscription ${event.data.object.subscription} — logged only`);
  } else {
        console.log(`[Stripe] Ignoring event type="${event.type}"`);
  }

  // Acknowledge receipt. Work continues in the background via waitUntil.
  res.status(200).json({ received: true });
}

// Disable Vercel's automatic body parsing so we get the raw body for signature verification
export const config = {
    api: {
          bodyParser: false,
    },
};
