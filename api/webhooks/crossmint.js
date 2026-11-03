/**
 * Crossmint webhook handler — POST /api/webhooks/crossmint
 *
 * Crossmint delivers webhooks through Svix. Every delivery carries:
 *   svix-id         unique message id
 *   svix-timestamp  unix seconds
 *   svix-signature  space-separated "v1,<base64>" entries
 * The signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256
 * keyed with the base64-decoded secret after its `whsec_` prefix, base64 output.
 *
 * Documented minting events (the only two we act on):
 *   { type: 'nfts.create.succeeded', actionId, data: { chain, txId,
 *       collection: { id, contractAddress }, recipient: { walletAddress, email },
 *       token: { id, tokenId } } }
 *   { type: 'nfts.create.failed', actionId, data: { ..., error: { reason, message } } }
 *
 * CROSSMINT_WEBHOOK_SECRET is REQUIRED (fail-closed): unset → 500 and nothing is
 * processed; a bad/missing/stale signature → 401. A forged success event must
 * never be able to grant Discord roles.
 */

import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import {
  updateNftMint, findMemberByEmail, findMintByActionId, findMintByTokenId,
  listActiveMintsByEmailAndTypeWithoutToken, findActiveMintsByEmail, updateDiscordSyncStatus,
} from '../_lib/db.js';
import {
  ENTITLEMENT_MAP, resolveEntitlementFromNftType, getRoleId, pickGrantableMint, UNKNOWN_BILLING_FIELDS,
} from '../_lib/entitlements.js';
import { syncMemberRoles } from '../_lib/discord-bot.js';
import { onEntitlementActivated } from '../_lib/engage.js';
import { sendAlert } from '../_lib/alert.js';

const TOLERANCE_SECONDS = 300;
const LOG = '[Crossmint Webhook]';

// ── Signature verification (Svix scheme) ─────────────────────────────────────

function headerValue(headers, name) {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Verify a Svix-signed Crossmint delivery.
 * @param {string} rawBody   exact request body as received
 * @param {Record<string, string|string[]|undefined>} headers  lower-cased request headers
 * @param {string} secret    CROSSMINT_WEBHOOK_SECRET (`whsec_<base64>`)
 * @returns {boolean}
 */
export function verifyCrossmintSignature(rawBody, headers, secret) {
  if (!secret) return false;
  const id = headerValue(headers, 'svix-id');
  const timestamp = headerValue(headers, 'svix-timestamp');
  const signature = headerValue(headers, 'svix-signature');
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return false;
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`, 'utf8')
    .digest();

  for (const entry of String(signature).split(' ')) {
    const [version, sig] = entry.split(',');
    if (version !== 'v1' || !sig) continue;
    const received = Buffer.from(sig, 'base64');
    if (received.length !== expected.length) continue;
    if (crypto.timingSafeEqual(received, expected)) return true;
  }
  return false;
}

// ── Correlation ──────────────────────────────────────────────────────────────

/** The one NFT type whose collection env equals this collection id, else null (shared/unknown). */
function nftTypeFromCollection(collectionId) {
  if (!collectionId) return null;
  const matches = Object.values(ENTITLEMENT_MAP)
    .filter((cfg) => process.env[cfg.collectionEnv] && process.env[cfg.collectionEnv] === collectionId);
  return matches.length === 1 ? matches[0].nftType : null;
}

const emptyToken = (row) => {
  const t = row?.fields?.['Token ID'];
  return t === null || t === undefined || t === '';
};

/**
 * Find the nft_mints row an event refers to:
 *   1. Crossmint Action ID
 *   2. Token ID === actionId (rows written before the action id had its own column)
 *   3. recipient email + NFT type (from the collection id): exactly one active token-less row
 *   4. shared/unknown collection: email only, when exactly one active row is token-less
 * Anything ambiguous returns null (→ unmatched alert) rather than guessing a row.
 */
async function findMintForEvent(event) {
  const actionId = event?.actionId ?? null;
  const data = event?.data ?? {};
  if (actionId) {
    const byAction = await findMintByActionId(actionId);
    if (byAction) return byAction;
    const byLegacyToken = await findMintByTokenId(actionId);
    if (byLegacyToken) return byLegacyToken;
  }
  const email = data.recipient?.email;
  if (!email) return null;
  const nftType = nftTypeFromCollection(data.collection?.id);
  if (nftType) {
    const typed = (await listActiveMintsByEmailAndTypeWithoutToken(email, nftType)) ?? [];
    return typed.length === 1 ? typed[0] : null;
  }
  const candidates = ((await findActiveMintsByEmail(email)) ?? []).filter(emptyToken);
  return candidates.length === 1 ? candidates[0] : null;
}

async function alertUnmatched(event) {
  console.warn(`${LOG} no nft_mints row for type=${event?.type} actionId=${event?.actionId ?? ''}`);
  await sendAlert('crossmint.webhook_unmatched',
    { type: event?.type ?? '', actionId: event?.actionId ?? '' },
    { dedupeKey: event?.actionId ?? undefined });
}

// ── Discord grant ────────────────────────────────────────────────────────────

function discordStatus(err) {
  const msg = String(err?.message ?? '');
  if (/not found in guild/.test(msg)) return 404;
  const m = msg.match(/\((\d{3})\)/);
  return m ? Number(m[1]) : 'error';
}

async function grantDiscordAccess(email, fallbackRow) {
  let member = null;
  let memberFields;
  try {
    member = await findMemberByEmail(email);
    memberFields = member?.fields;
  } catch (e) {
    console.error(`${LOG} member lookup failed (fail-closed for revocable): ${e.message}`);
    memberFields = UNKNOWN_BILLING_FIELDS;
  }
  const discordId = member?.fields?.['Discord ID'];
  if (!discordId) {
    console.log(`${LOG} member has no Discord ID yet — sync pending`);
    await updateDiscordSyncStatus(email, 'pending').catch(() => {});
    return;
  }

  const mints = await findActiveMintsByEmail(email).catch(() => [fallbackRow]);
  const grantMint = pickGrantableMint(mints?.length ? mints : [fallbackRow], memberFields);
  if (!grantMint) {
    console.warn(`${LOG} no grantable pass (lapsed/cancelled monthly) — no role granted`);
    return;
  }
  const nftType = grantMint.fields?.['NFT Type'] ?? '';
  const roleKey = resolveEntitlementFromNftType(nftType);
  const roleId = roleKey ? getRoleId(roleKey) : null;
  if (!roleId) {
    await sendAlert('discord.role_grant_failed', { roleKey, status: 'role_not_configured' });
    await updateDiscordSyncStatus(email, 'pending', { error: `No Discord role configured for ${roleKey}` }).catch(() => {});
    return;
  }

  try {
    await syncMemberRoles(discordId, roleId);
  } catch (err) {
    console.error(`${LOG} Discord role grant failed roleKey=${roleKey}`);
    await sendAlert('discord.role_grant_failed', { roleKey, status: discordStatus(err) });
    await updateDiscordSyncStatus(email, 'pending', { error: String(err?.message ?? '').slice(0, 300) }).catch(() => {});
    return;
  }

  const now = new Date().toISOString();
  await updateNftMint(grantMint.id, { 'Discord Synced': true, 'Discord Synced At': now });
  await updateDiscordSyncStatus(email, 'synced');
  console.log(`${LOG} Discord role granted roleKey=${roleKey}`);
  onEntitlementActivated({
    email,
    name: member?.fields?.['Customer Name'] ?? '',
    entitlementType: roleKey,
    nftType,
    serial: grantMint.fields?.['Reference'] ?? '',
  }).catch(() => {});
}

// ── Event handlers ───────────────────────────────────────────────────────────

export async function handleMintSuccess(event) {
  const data = event?.data ?? {};
  const row = await findMintForEvent(event);
  if (!row) return alertUnmatched(event);

  const tokenId = data.token?.tokenId ?? data.token?.id;
  const fields = {
    'Mint Status': 'Minted',
    'Mint Date': new Date().toISOString(),
    'Transaction Hash': data.txId ?? '',
    'Wallet Address': data.recipient?.walletAddress ?? '',
  };
  if (tokenId !== undefined && tokenId !== null && tokenId !== '') fields['Token ID'] = String(tokenId);
  await updateNftMint(row.id, fields);
  console.log(`${LOG} row ${row.id} → Minted actionId=${event?.actionId ?? ''}`);

  const email = row.fields?.['Email'] || data.recipient?.email;
  if (!email) {
    console.warn(`${LOG} no email on row ${row.id} — skipping Discord sync`);
    return;
  }
  await grantDiscordAccess(email, { ...row, fields: { ...row.fields, ...fields } });
}

export async function handleMintFailure(event) {
  const actionId = event?.actionId ?? '';
  const err = event?.data?.error ?? {};
  const message = err.message ?? 'unknown error';
  console.warn(`${LOG} mint failed actionId=${actionId} reason=${err.reason ?? ''}`);

  const row = await findMintForEvent(event);
  if (row) {
    await updateNftMint(row.id, {
      'Mint Status': 'Failed',
      'Notes': `Crossmint failed: ${message}`,
      'Last Error': `${err.reason ? `${err.reason}: ` : ''}${message}`.slice(0, 500),
    });
  } else {
    await alertUnmatched(event);
  }
  await sendAlert('crossmint.mint_failed_webhook', { actionId }, { dedupeKey: actionId || undefined });
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

  const secret = process.env.CROSSMINT_WEBHOOK_SECRET;
  if (!secret) {
    console.error(`${LOG} CROSSMINT_WEBHOOK_SECRET not configured — refusing to process`);
    await sendAlert('crossmint.webhook_unconfigured', {}, { severity: 'critical', dedupeKey: 'config' });
    return res.status(500).json({ error: 'Webhook verification not configured' });
  }
  if (!verifyCrossmintSignature(rawBody, req.headers ?? {}, secret)) {
    console.warn(`${LOG} rejected delivery: bad signature`);
    await sendAlert('crossmint.webhook_rejected', { reason: 'bad_signature' }, { dedupeKey: 'sig' });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = event?.type ?? '';
  res.status(200).json({ received: true });

  // waitUntil keeps the function alive for the post-ack work (row update +
  // Discord grant) instead of it being frozen once the response flushes.
  if (eventType === 'nfts.create.succeeded') {
    waitUntil(handleMintSuccess(event).catch((e) =>
      console.error(`${LOG} handleMintSuccess error: ${e.message}`)));
  } else if (eventType === 'nfts.create.failed') {
    waitUntil(handleMintFailure(event).catch((e) =>
      console.error(`${LOG} handleMintFailure error: ${e.message}`)));
  } else {
    console.log(`${LOG} ignored event type="${eventType}"`);
  }
}

export const config = { api: { bodyParser: false } };
