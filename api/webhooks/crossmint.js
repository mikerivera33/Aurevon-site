/**
 * Crossmint webhook handler — POST /api/webhooks/crossmint
 *
 * Crossmint sends events when mint status changes.
 * We listen for successful mints and trigger Discord role assignment.
 *
 * Crossmint webhook event shapes (2022-06-09 API):
 *   { type: "action.succeeded", data: { id, actionId, onChain: { status } }, nft: { ... } }
 *   { type: "action.failed",    data: { ... } }
 *   { type: "nft.minted",       data: { ... } }
 *
 * Set CROSSMINT_WEBHOOK_SECRET in Vercel to enable HMAC verification.
 * If not set, we still process but log a warning.
 */

import crypto from 'node:crypto';
import { updateNftMint, findMemberByEmail, listNftMints } from '../_lib/airtable.js';
import { resolveEntitlementFromNftType, getRoleId } from '../_lib/entitlements.js';
import { addRoleToMember } from '../_lib/discord-bot.js';
import { updateDiscordSyncStatus } from '../_lib/airtable.js';
import { onEntitlementActivated } from '../_lib/engage.js';

// ── Signature verification ───────────────────────────────────────────────────

function verifyCrossmintSignature(rawBody, sigHeader) {
  const secret = process.env.CROSSMINT_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Crossmint Webhook] CROSSMINT_WEBHOOK_SECRET not set — proceeding without verification');
    return true;
  }
  if (!sigHeader) {
    console.warn('[Crossmint Webhook] Missing crossmint-signature header');
    return false;
  }
  // Crossmint signature header format: "t=<timestamp>,v1=<hex>"
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => p.split('=').map((s) => s.trim()))
  );
  const timestamp = parts['t'];
  const receivedSig = parts['v1'];
  if (!timestamp || !receivedSig) {
    console.warn('[Crossmint Webhook] Malformed signature header');
    return false;
  }
  // Reject events older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
    console.warn('[Crossmint Webhook] Event timestamp too old — possible replay');
    return false;
  }
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSig, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

// ── Mint success handler ─────────────────────────────────────────────────────

async function handleMintSuccess(event) {
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
  if (!mintRecord) {
    console.warn(`[Crossmint Webhook] No NFT_Mints record for mintId=${mintId} email=${recipientEmail}`);
    return;
  }

  const recordId = mintRecord.id;
  const email = mintRecord.fields['Email'] ?? recipientEmail ?? '';
  const nftType = mintRecord.fields['NFT Type'] ?? nftData.metadata?.name ?? '';
  const txHash = event.data?.onChain?.txId ?? '';
  const now = new Date().toISOString();

  await updateNftMint(recordId, {
    'Mint Status': 'Minted',
    'Mint Date': now,
    'Transaction Hash': txHash,
    'Token ID': mintId ?? mintRecord.fields['Token ID'] ?? '',
  });
  console.log(`[Crossmint Webhook] Updated NFT_Mints recordId=${recordId} → Minted`);

  const entitlementKey = resolveEntitlementFromNftType(nftType);
  if (!entitlementKey) {
    console.warn(`[Crossmint Webhook] No entitlement key for nftType="${nftType}"`);
    return;
  }
  const roleId = getRoleId(entitlementKey);
  if (!roleId) {
    console.warn(`[Crossmint Webhook] No roleId for entitlement="${entitlementKey}" — check env vars`);
    return;
  }
  if (!email) {
    console.warn('[Crossmint Webhook] No email available for Discord sync');
    return;
  }

  const member = await findMemberByEmail(email).catch(() => null);
  const discordId = member?.fields?.['Discord ID'];
  if (discordId) {
    try {
      await addRoleToMember(discordId, roleId);
      await updateNftMint(recordId, { 'Discord Synced': true, 'Discord Synced At': now });
      await updateDiscordSyncStatus(email, 'synced');
      console.log(`[Crossmint Webhook] Discord role assigned discordId=${discordId} roleId=${roleId}`);
      onEntitlementActivated({
        email,
        name: member?.fields?.['Customer Name'] ?? '',
        entitlementType: entitlementKey,
        nftType,
        serial: mintRecord.fields['Reference'] ?? '',
      }).catch(() => {});
    } catch (err) {
      console.error(`[Crossmint Webhook] Discord role assignment failed: ${err.message}`);
      await updateDiscordSyncStatus(email, 'pending').catch(() => {});
    }
  } else {
    console.log(`[Crossmint Webhook] No Discord ID for email=${email} — marking sync pending`);
    await updateDiscordSyncStatus(email, 'pending').catch(() => {});
  }
}

async function handleMintFailure(event) {
  const mintId = event.data?.id ?? event.data?.actionId ?? null;
  const errorMsg = event.data?.error?.message ?? JSON.stringify(event.data?.error ?? {});
  console.warn(`[Crossmint Webhook] Mint failed mintId=${mintId} error=${errorMsg}`);
  if (mintId) {
    const recs = await listNftMints(`{Token ID}="${mintId}"`, { maxRecords: 1 }).catch(() => []);
    if (recs[0]) {
      await updateNftMint(recs[0].id, {
        'Mint Status': 'Failed',
        'Notes': `Crossmint failed: ${errorMsg}`,
      }).catch((e) => console.error(`[Crossmint Webhook] Airtable update failed: ${e.message}`));
    }
  }
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try {
    rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  } catch (_err) {
    return res.status(400).json({ error: 'Failed to read body' });
  }

  const sigHeader = req.headers['crossmint-signature'] ?? req.headers['x-crossmint-signature'] ?? '';
  if (!verifyCrossmintSignature(rawBody, sigHeader)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = event.type ?? '';
  console.log(`[Crossmint Webhook] Received type="${eventType}"`);

  // Acknowledge immediately
  res.status(200).json({ received: true });

  const isSuccess = ['action.succeeded', 'nft.minted', 'mint.succeeded'].includes(eventType);
  const isFailure = ['action.failed', 'mint.failed'].includes(eventType);

  if (isSuccess) {
    handleMintSuccess(event).catch((e) =>
      console.error(`[Crossmint Webhook] handleMintSuccess error: ${e.message}`, e.stack)
    );
  } else if (isFailure) {
    handleMintFailure(event).catch((e) =>
      console.error(`[Crossmint Webhook] handleMintFailure error: ${e.message}`)
    );
  } else {
    console.log(`[Crossmint Webhook] Ignoring event type="${eventType}"`);
  }
}

export const config = { api: { bodyParser: false } };
