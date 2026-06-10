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
import { createPayment, createNftMint, updateDiscordSyncStatus, findMemberByEmail, findPaymentByTransactionId } from '../_lib/airtable.js';
import { sendNftDelivery, sendPurchaseConfirmation } from '../_lib/email.js';
import { resolveEntitlementFromSku, getRoleId, ENTITLEMENT_MAP } from '../_lib/entitlements.js';
import { removeRoleFromMember } from '../_lib/discord-bot.js';

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
  }

  // 7. Write NFT_Mints row — use serial as the reference; retry on collision (race condition guard)
  const reference = serial ?? `MINT_${sessionId.slice(-8)}_${nftType.replace(/\s+/g, '_')}`;
    let insertedSerial = serial;

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
