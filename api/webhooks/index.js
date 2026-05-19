/**
 * Consolidated webhook handler — POST /api/webhooks/:provider
 * Dispatches to Stripe / Crossmint / PayPal via ?provider= query param.
 *
 * All three providers require the raw body for signature/IPN verification,
 * so bodyParser is disabled for the whole function.
 */

import crypto from 'node:crypto';
import { TIER_NFT_MAP, inferTierFromAmount, getNextSerial, formatSerial } from '../_lib/tiers.js';
import { mintToEmail } from '../_lib/crossmint.js';
import {
  createPayment, createNftMint, updateNftMint,
  findMemberByEmail, listNftMints, updateDiscordSyncStatus,
} from '../_lib/airtable.js';
import { sendNftDelivery, sendPurchaseConfirmation } from '../_lib/email.js';
import { resolveEntitlementFromNftType, getRoleId } from '../_lib/entitlements.js';
import { addRoleToMember } from '../_lib/discord-bot.js';
import { onEntitlementActivated } from '../_lib/engage.js';

// ── Shared raw-body reader ────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── Shared NFT mint pipeline (used by both Stripe and PayPal webhooks) ───────

async function runMintPipeline({ label, txnId, customerEmail, customerName, amount, tier, paymentMethod, now }) {
  const token = `paid_${tier ?? 'unknown'}_${Date.now()}`;

  try {
    await createPayment({ transactionId: txnId, method: paymentMethod, tier: tier ?? 'unknown', amount, customerEmail, customerName, status: 'Succeeded', token });
  } catch (err) {
    console.error(`[${label}] Airtable createPayment failed: ${err.message}`);
  }

  const tierConfig = tier ? (TIER_NFT_MAP[tier] ?? null) : null;
  const nftType = tierConfig?.nft ?? null;
  const templateKey = tierConfig?.template ?? null;
  const serialPrefix = tierConfig?.serialPrefix ?? null;
  const collectionName = tierConfig?.collectionName ?? null;

  if (!nftType) {
    console.log(`[${label}] Tier "${tier}" has no NFT. Sending purchase confirmation.`);
    try { await sendPurchaseConfirmation({ email: customerEmail, customerName, tier: tier ?? 'unknown' }); }
    catch (err) { console.error(`[${label}] Confirmation email failed: ${err.message}`); }
    return;
  }

  let serial = null;
  if (serialPrefix) {
    try {
      serial = await getNextSerial(serialPrefix);
      console.log(`[${label}] Assigned serial ${serial} for tier "${tier}"`);
    } catch (err) {
      console.error(`[${label}] getNextSerial failed: ${err.message}. Continuing without serial.`);
    }
  }

  let mintId = null, imageUrl = null, mintStatus, mintNotes = '';
  try {
    const result = await mintToEmail({ email: customerEmail, nftType, customerName, templateKey, serial, collectionName, tierKey: tier });
    mintId = result.mintId; imageUrl = result.imageUrl; mintStatus = 'Sent';
    console.log(`[${label}] Mint succeeded: mintId=${mintId}, serial=${serial}`);
  } catch (err) {
    mintStatus = 'Failed'; mintNotes = `Crossmint error: ${err.message}`;
    console.error(`[${label}] Crossmint mint failed: ${err.message}`);
  }

  const reference = serial ?? `MINT_${txnId.slice(-8)}_${nftType.replace(/\s+/g, '_')}`;
  let insertedSerial = serial;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = attempt === 0 ? reference : (() => {
      if (!insertedSerial) return reference;
      const parts = insertedSerial.split('_');
      const num = parseInt(parts[1] ?? '0', 10) + 1;
      insertedSerial = formatSerial(parts[0], num);
      return insertedSerial;
    })();
    try {
      await createNftMint({ reference: ref, customerEmail, nftType, tierSource: tier, status: mintStatus, sentDate: now, emailDelivered: mintStatus === 'Sent', notes: mintNotes, mintId: mintId ?? '', retryCount: 0 });
      console.log(`[${label}] NFT_Mints record created with reference=${ref}`);
      break;
    } catch (err) {
      const isDuplicate = err.message.includes('422') || err.message.toLowerCase().includes('already exists') || err.message.toLowerCase().includes('duplicate');
      if (isDuplicate && attempt < 2) {
        console.warn(`[${label}] Reference collision on "${ref}" (attempt ${attempt + 1}) — incrementing serial and retrying`);
      } else {
        console.error(`[${label}] Airtable createNftMint failed (attempt ${attempt + 1}): ${err.message}`);
        break;
      }
    }
  }

  let edition = null;
  if (insertedSerial) {
    const parts = insertedSerial.split('_');
    if (parts[1]) edition = parseInt(parts[1], 10);
  }

  try {
    await sendNftDelivery({ email: customerEmail, customerName, nftType, mintId: mintId ?? 'pending', nftImageUrl: imageUrl, discordInviteUrl: process.env.DISCORD_INVITE_URL, tier, serial: insertedSerial, edition });
  } catch (err) {
    console.error(`[${label}] Resend email failed: ${err.message}`);
  }
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) throw new Error('Missing Stripe-Signature header');
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const timestamp = parts['t'], v1 = parts['v1'];
  if (!timestamp || !v1) throw new Error('Malformed Stripe-Signature header');
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10)) > 300) throw new Error('Stripe webhook timestamp too old');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('Stripe signature mismatch');
}

async function handleStripe(req, res, rawBody) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'Server misconfiguration' });

  try { verifyStripeSignature(rawBody, req.headers['stripe-signature'], webhookSecret); }
  catch (err) { console.error(`[Stripe] Signature verification failed: ${err.message}`); return res.status(400).json({ error: 'Invalid signature' }); }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  console.log(`[Stripe] Received event type="${event.type}" id="${event.id}"`);
  res.status(200).json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email ?? session.customer_email;
    const customerName = session.customer_details?.name ?? 'Aurevon Member';
    const amountTotal = session.amount_total ?? 0;
    let tier = session.metadata?.tier ?? inferTierFromAmount(amountTotal);
    if (!tier) { console.warn(`[Stripe] Could not determine tier for session ${session.id}`); tier = 'unknown'; }
    try {
      await runMintPipeline({ label: 'Stripe', txnId: session.id, customerEmail, customerName, amount: amountTotal / 100, tier, paymentMethod: 'Stripe Card', now: new Date().toISOString() });
    } catch (err) {
      console.error(`[Stripe] Unhandled pipeline error: ${err.message}`, err.stack);
    }
    console.log(`[Stripe] Pipeline complete for session ${session.id}`);
  } else {
    console.log(`[Stripe] Ignoring event type="${event.type}"`);
  }
}

// ── Crossmint ─────────────────────────────────────────────────────────────────

function verifyCrossmintSignature(rawBody, sigHeader) {
  const secret = process.env.CROSSMINT_WEBHOOK_SECRET;
  if (!secret) { console.warn('[Crossmint Webhook] CROSSMINT_WEBHOOK_SECRET not set — skipping verification'); return true; }
  if (!sigHeader) { console.warn('[Crossmint Webhook] Missing crossmint-signature header'); return false; }
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const timestamp = parts['t'], receivedSig = parts['v1'];
  if (!timestamp || !receivedSig) { console.warn('[Crossmint Webhook] Malformed signature header'); return false; }
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) { console.warn('[Crossmint Webhook] Event timestamp too old'); return false; }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(receivedSig, 'hex'), Buffer.from(expected, 'hex'));
}

async function handleCrossmintMintSuccess(event) {
  const mintId = event.data?.id ?? event.data?.actionId ?? null;
  const nftData = event.data?.nft ?? event.nft ?? {};
  const recipientEmail = nftData.recipient?.email ?? event.data?.recipient?.email ?? null;
  console.log(`[Crossmint Webhook] Mint success mintId=${mintId} email=${recipientEmail}`);

  let mintRecord = null;
  if (mintId) {
    const recs = await listNftMints(`{Token ID}="${mintId}"`, { maxRecords: 1 });
    mintRecord = recs[0] ?? null;
  }
  if (!mintRecord && recipientEmail) {
    const { findActiveMintByEmail } = await import('../_lib/airtable.js');
    mintRecord = await findActiveMintByEmail(recipientEmail);
  }
  if (!mintRecord) { console.warn(`[Crossmint Webhook] No NFT_Mints record for mintId=${mintId} email=${recipientEmail}`); return; }

  const recordId = mintRecord.id;
  const email = mintRecord.fields['Email'] ?? recipientEmail ?? '';
  const nftType = mintRecord.fields['NFT Type'] ?? nftData.metadata?.name ?? '';
  const txHash = event.data?.onChain?.txId ?? '';
  const now = new Date().toISOString();

  await updateNftMint(recordId, { 'Mint Status': 'Minted', 'Mint Date': now, 'Transaction Hash': txHash, 'Token ID': mintId ?? mintRecord.fields['Token ID'] ?? '' });
  console.log(`[Crossmint Webhook] Updated NFT_Mints recordId=${recordId} → Minted`);

  const entitlementKey = resolveEntitlementFromNftType(nftType);
  if (!entitlementKey) { console.warn(`[Crossmint Webhook] No entitlement key for nftType="${nftType}"`); return; }
  const roleId = getRoleId(entitlementKey);
  if (!roleId) { console.warn(`[Crossmint Webhook] No roleId for entitlement="${entitlementKey}"`); return; }
  if (!email) { console.warn('[Crossmint Webhook] No email available for Discord sync'); return; }

  const member = await findMemberByEmail(email).catch(() => null);
  const discordId = member?.fields?.['Discord ID'];

  if (discordId) {
    try {
      await addRoleToMember(discordId, roleId);
      await updateNftMint(recordId, { 'Discord Synced': true, 'Discord Synced At': now });
      await updateDiscordSyncStatus(email, 'synced');
      console.log(`[Crossmint Webhook] Discord role assigned discordId=${discordId} roleId=${roleId}`);
      onEntitlementActivated({ email, name: member?.fields?.['Customer Name'] ?? '', entitlementType: entitlementKey, nftType, serial: mintRecord.fields['Reference'] ?? '' }).catch(() => {});
    } catch (err) {
      console.error(`[Crossmint Webhook] Discord role assignment failed: ${err.message}`);
      await updateDiscordSyncStatus(email, 'pending').catch(() => {});
    }
  } else {
    console.log(`[Crossmint Webhook] No Discord ID for email=${email} — marking sync pending`);
    await updateDiscordSyncStatus(email, 'pending').catch(() => {});
  }
}

async function handleCrossmintMintFailure(event) {
  const mintId = event.data?.id ?? event.data?.actionId ?? null;
  const errorMsg = event.data?.error?.message ?? JSON.stringify(event.data?.error ?? {});
  console.warn(`[Crossmint Webhook] Mint failed mintId=${mintId} error=${errorMsg}`);
  if (mintId) {
    const recs = await listNftMints(`{Token ID}="${mintId}"`, { maxRecords: 1 }).catch(() => []);
    if (recs[0]) await updateNftMint(recs[0].id, { 'Mint Status': 'Failed', 'Notes': `Crossmint failed: ${errorMsg}` }).catch((e) => console.error(`[Crossmint Webhook] Airtable update failed: ${e.message}`));
  }
}

async function handleCrossmint(req, res, rawBody) {
  const sigHeader = req.headers['crossmint-signature'] ?? req.headers['x-crossmint-signature'] ?? '';
  if (!verifyCrossmintSignature(rawBody, sigHeader)) return res.status(401).json({ error: 'Invalid signature' });

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const eventType = event.type ?? '';
  console.log(`[Crossmint Webhook] Received type="${eventType}"`);
  res.status(200).json({ received: true });

  const isSuccess = ['action.succeeded', 'nft.minted', 'mint.succeeded'].includes(eventType);
  const isFailure = ['action.failed', 'mint.failed'].includes(eventType);
  if (isSuccess) handleCrossmintMintSuccess(event).catch((e) => console.error(`[Crossmint Webhook] handleMintSuccess error: ${e.message}`, e.stack));
  else if (isFailure) handleCrossmintMintFailure(event).catch((e) => console.error(`[Crossmint Webhook] handleMintFailure error: ${e.message}`));
  else console.log(`[Crossmint Webhook] Ignoring event type="${eventType}"`);
}

// ── PayPal IPN ────────────────────────────────────────────────────────────────

async function verifyPayPalIPN(rawBody) {
  const verifyUrl = process.env.PAYPAL_SANDBOX === 'true'
    ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
    : 'https://ipnpb.paypal.com/cgi-bin/webscr';
  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `cmd=_notify-validate&${rawBody}`,
  });
  const result = await response.text();
  console.log(`[PayPal IPN] Verification result: ${result}`);
  return result.trim() === 'VERIFIED';
}

function inferTierFromIPN(ipn) {
  if (ipn.custom) {
    try { const c = JSON.parse(ipn.custom); if (c.tier) return c.tier; }
    catch { if (TIER_NFT_MAP[ipn.custom]) return ipn.custom; }
  }
  const amount = parseFloat(ipn.mc_gross ?? '0');
  for (const [tier, config] of Object.entries(TIER_NFT_MAP)) {
    if (Math.abs(amount - config.amount) <= 1) return tier;
  }
  return null;
}

async function handlePaypalIPN(req, res, rawBody) {
  res.status(200).send('OK');

  let verified;
  try { verified = await verifyPayPalIPN(rawBody); }
  catch (err) { console.error(`[PayPal IPN] Verification request failed: ${err.message}`); return; }
  if (!verified) { console.warn('[PayPal IPN] IPN verification returned INVALID — discarding'); return; }

  const ipn = Object.fromEntries(new URLSearchParams(rawBody).entries());
  console.log(`[PayPal IPN] Verified. txn_id=${ipn.txn_id}, payment_status=${ipn.payment_status}`);

  if ((ipn.payment_status ?? '').toLowerCase() !== 'completed') { console.log(`[PayPal IPN] Skipping non-completed payment`); return; }
  const businessEmail = process.env.PAYPAL_BUSINESS_EMAIL;
  if (businessEmail && ipn.receiver_email !== businessEmail) { console.warn(`[PayPal IPN] Receiver mismatch`); return; }

  try {
    const tier = inferTierFromIPN(ipn);
    const customerName = [ipn.first_name, ipn.last_name].filter(Boolean).join(' ') || 'Aurevon Member';
    await runMintPipeline({ label: 'PayPal IPN', txnId: ipn.txn_id ?? `pp_${Date.now()}`, customerEmail: ipn.payer_email, customerName, amount: parseFloat(ipn.mc_gross ?? '0'), tier, paymentMethod: 'PayPal', now: new Date().toISOString() });
    console.log(`[PayPal IPN] Pipeline complete for txnId=${ipn.txn_id}`);
  } catch (err) {
    console.error(`[PayPal IPN] Unhandled pipeline error: ${err.message}`, err.stack);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (_err) { return res.status(400).json({ error: 'Failed to read body' }); }

  const provider = req.query.provider;
  if (provider === 'stripe')    return handleStripe(req, res, rawBody);
  if (provider === 'crossmint') return handleCrossmint(req, res, rawBody);
  if (provider === 'paypal')    return handlePaypalIPN(req, res, rawBody);
  return res.status(400).json({ error: 'Missing provider param', valid: ['stripe', 'crossmint', 'paypal'] });
}

export const config = { api: { bodyParser: false } };
