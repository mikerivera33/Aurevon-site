/**
 * Member claim + reconcile endpoint — /api/member/claim
 *
 * POST  body: { email, discordId?, discordUsername?, walletAddress? }
 *   → Links Discord/wallet to member record
 *   → If active entitlement exists and Discord is linked, assigns role immediately
 *   → Returns member status
 *
 * GET  ?action=reconcile&secret=<RECONCILE_SECRET>
 *   → Finds members with Discord linked but sync pending
 *   → Assigns roles for all pending members
 *   → Finds monthly members whose access should be revoked
 *   → Returns reconcile report
 *
 * GET  ?action=status&email=<email>&secret=<RECONCILE_SECRET>
 *   → Returns member entitlement + sync status
 *
 * POST ?action=mint
 *   body: { recipientEmail, walletAddress?, passType, metadata? }
 *   → Mints the correct NFT via Crossmint (absorbed from api/crossmint/mint.js)
 */

import crypto from 'node:crypto';
import { upsertMemberByEmail, findMemberByEmail, findActiveMintByEmail, listNftMints, listPendingDiscordSync, listOutOfSyncEntitlements, listFailedMints, updateDiscordSyncStatus, updateNftMint } from '../_lib/airtable.js';
import { addRoleToMember, removeRoleFromMember } from '../_lib/discord-bot.js';
import { resolveEntitlementFromNftType, getRoleId, shouldRevokeAccess } from '../_lib/entitlements.js';
import { onDiscordLinkReminder, onSubscriptionCancelled } from '../_lib/engage.js';

const DOMAIN = process.env.DOMAIN ?? 'https://www.aurevonvc.com';

// Two callers authenticate here with DIFFERENT secrets:
//   - operator.html / manual retries  → ?secret=<RECONCILE_SECRET>
//   - Vercel cron (retry-mints, reconcile) → Authorization: Bearer <CRON_SECRET>
// Vercel only attaches that Bearer header when CRON_SECRET is set in the env.
// Accepting EITHER configured secret means both paths authenticate even when
// the two values differ — previously getReconcileSecret() returned only one,
// so the cron path silently 401'd and the reconcile/retry jobs no-op'd forever.
function getReconcileSecrets() {
  return [process.env.RECONCILE_SECRET, process.env.CRON_SECRET].filter(Boolean);
}

export function validateReconcileSecret(req) {
  const secrets = getReconcileSecrets();
  if (secrets.length === 0) return false;
  const provided = req.query?.secret ?? req.headers?.['authorization']?.replace('Bearer ', '') ?? '';
  if (!provided) return false;
  return secrets.some((secret) => {
    if (provided.length !== secret.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    } catch {
      return false;
    }
  });
}

// ── POST ?action=mint: direct NFT mint via Crossmint ─────────────────────────

const CROSSMINT_API_KEY = process.env.CROSSMINT_API_KEY;
const CROSSMINT_COLLECTION_ID = process.env.CROSSMINT_COLLECTION_ID;

const TEMPLATE_MAP = {
  OBSIDIAN: process.env.CROSSMINT_TEMPLATE_OBSIDIAN,
  EMBER:    process.env.CROSSMINT_TEMPLATE_EMBER,
  INSIDER:  process.env.CROSSMINT_TEMPLATE_INSIDER,
  CHROME:   process.env.CROSSMINT_TEMPLATE_CHROME,
  GENESIS:  process.env.CROSSMINT_TEMPLATE_GENESIS,
};

async function handleMint(req, res) {
  if (!CROSSMINT_API_KEY) return res.status(503).json({ error: 'Crossmint not configured', hint: 'Add CROSSMINT_API_KEY to Vercel env vars' });

  const { recipientEmail, walletAddress, passType, metadata } = req.body || {};
  if (!passType) return res.status(400).json({ error: 'Missing passType' });
  if (!recipientEmail && !walletAddress) return res.status(400).json({ error: 'Provide recipientEmail or walletAddress' });

  const templateId = TEMPLATE_MAP[passType.toUpperCase()];
  const recipient = walletAddress
    ? { walletAddress }
    : { email: recipientEmail };

  const mintPayload = {
    recipient,
    metadata: {
      name: `Aurevon ${passType} Pass`,
      description: `Official Aurevon ${passType} membership pass. On-chain on Base (ETH L2).`,
      image: `https://www.aurevonvc.com/nfts/${passType.toLowerCase()}`,
      attributes: [
        { trait_type: 'Pass Tier', value: passType },
        { trait_type: 'Network', value: 'Base' },
        { trait_type: 'Issuer', value: 'Aurevon Ventures LLC' },
        ...(metadata?.attributes || [])
      ]
    }
  };

  const url = `https://www.crossmint.com/api/2022-06-09/collections/${CROSSMINT_COLLECTION_ID}/nfts`;
  if (templateId) mintPayload.templateId = templateId;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-KEY': CROSSMINT_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(mintPayload)
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: 'Crossmint error', detail: data });
    return res.status(200).json({ ok: true, actionId: data.actionId, id: data.id, data });
  } catch (err) {
    return res.status(500).json({ error: 'Mint failed', message: err.message });
  }
}

// ── POST: claim / link ───────────────────────────────────────────────────────

async function handleClaim(req, res) {
  const { email, discordId, discordUsername, walletAddress } = req.body ?? {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const now = new Date().toISOString();

  // Build the fields to upsert on the member record
  const memberFields = { 'Active': true };
  if (discordId)       memberFields['Discord ID']       = discordId;
  if (discordUsername) memberFields['Discord Username']  = discordUsername;
  if (walletAddress)   memberFields['Wallet Address']    = walletAddress;
  if (discordId)       memberFields['Discord Linked At'] = now;

  // Upsert member
  try {
    await upsertMemberByEmail(normalizedEmail, memberFields);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to update member record', detail: err.message });
  }

  // Find active mint
  let mintRecord = null;
  try {
    mintRecord = await findActiveMintByEmail(normalizedEmail);
  } catch (err) {
    console.error(`[Claim] findActiveMintByEmail error: ${err.message}`);
  }

  if (!mintRecord) {
    return res.status(200).json({
      ok: true,
      message: 'Member record updated. No active NFT found yet — check back after purchase.',
      discordLinked: Boolean(discordId),
      nftFound: false,
    });
  }

  const nftType        = mintRecord.fields['NFT Type'] ?? '';
  const entitlementKey = resolveEntitlementFromNftType(nftType);
  const roleId         = entitlementKey ? getRoleId(entitlementKey) : null;

  // If Discord ID provided and role configured, assign role immediately
  let roleAssigned = false;
  let roleError    = null;

  if (discordId && roleId) {
    try {
      await addRoleToMember(discordId, roleId);
      await updateDiscordSyncStatus(normalizedEmail, 'synced');
      await updateNftMint(mintRecord.id, {
        'Discord Synced':    true,
        'Discord Synced At': now,
      });
      roleAssigned = true;
    } catch (err) {
      roleError = err.message;
      await updateDiscordSyncStatus(normalizedEmail, 'failed', { error: err.message }).catch(() => {});
      console.error(`[Claim] Role assignment failed: ${err.message}`);
    }
  } else {
    if (discordId && !roleId) console.warn(`[Claim] Discord ID provided but no roleId for entitlement="${entitlementKey}"`);
    await updateDiscordSyncStatus(normalizedEmail, 'pending').catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    email: normalizedEmail,
    nftFound: true,
    nftType,
    entitlementKey,
    discordLinked: Boolean(discordId),
    roleAssigned,
    roleError,
    discordAuthUrl: !discordId
      ? `${DOMAIN}/api/discord?action=auth&email=${encodeURIComponent(normalizedEmail)}`
      : null,
  });
}

// ── GET: reconcile ───────────────────────────────────────────────────────────

async function handleReconcile() {
  console.log('[Reconcile] Starting reconcile pass...');
  const now = new Date().toISOString();
  const report = {
    pendingSyncs: 0,
    roleAssigned: 0,
    syncFailed:   0,
    revokeChecked:0,
    revokeApplied:0,
    errors: [],
  };

  // 1. Find members with Discord linked but pending sync
  let pendingMembers = [];
  try {
    pendingMembers = await listPendingDiscordSync({ maxRecords: 50 });
    report.pendingSyncs = pendingMembers.length;
    console.log(`[Reconcile] ${pendingMembers.length} members pending Discord sync`);
  } catch (err) {
    report.errors.push(`listPendingDiscordSync: ${err.message}`);
  }

  for (const member of pendingMembers) {
    const email     = member.fields?.['Email'] ?? '';
    const discordId = member.fields?.['Discord ID'];
    if (!discordId || !email) continue;

    try {
      const mintRecord = await findActiveMintByEmail(email);
      if (!mintRecord) continue;

      const nftType        = mintRecord.fields['NFT Type'] ?? '';
      const entitlementKey = resolveEntitlementFromNftType(nftType);
      const roleId         = entitlementKey ? getRoleId(entitlementKey) : null;
      if (!roleId) continue;

      await addRoleToMember(discordId, roleId);
      await updateDiscordSyncStatus(email, 'synced');
      await updateNftMint(mintRecord.id, { 'Discord Synced': true, 'Discord Synced At': now });
      report.roleAssigned++;
      console.log(`[Reconcile] Role assigned email=${email} discordId=${discordId}`);
    } catch (err) {
      report.syncFailed++;
      report.errors.push(`sync email=${email}: ${err.message}`);
      await updateDiscordSyncStatus(email, 'failed', { error: err.message }).catch(() => {});
    }
  }

  // 2. Find monthly members whose access should be revoked
  let expiredMembers = [];
  try {
    const graceDays = parseInt(process.env.ENTITLEMENT_GRACE_PERIOD_DAYS ?? '7', 10);
    expiredMembers = await listOutOfSyncEntitlements({ graceDays });
    report.revokeChecked = expiredMembers.length;
    console.log(`[Reconcile] ${expiredMembers.length} monthly members to review for revocation`);
  } catch (err) {
    report.errors.push(`listOutOfSyncEntitlements: ${err.message}`);
  }

  for (const member of expiredMembers) {
    const email        = member.fields?.['Email'] ?? '';
    const discordId    = member.fields?.['Discord ID'];
    const endsAt       = member.fields?.['Entitlement Expires At'];
    const gracePeriodDays = parseInt(process.env.ENTITLEMENT_GRACE_PERIOD_DAYS ?? '7', 10);

    const needsRevoke = shouldRevokeAccess({
      membershipMode: 'recurring',
      revokeOnCancel: true,
      billingState:   member.fields?.['Billing State'] ?? 'cancelled',
      endsAt,
      gracePeriodDays,
    });

    if (!needsRevoke) continue;

    report.revokeApplied++;

    // Remove the monthly role
    if (discordId) {
      const roleId = getRoleId('monthly_membership');
      if (roleId) {
        await removeRoleFromMember(discordId, roleId).catch((err) => {
          report.errors.push(`removeRole email=${email}: ${err.message}`);
        });
      }
    }

    // Update member record
    await updateDiscordSyncStatus(email, 'revoked').catch(() => {});

    // Fire Engage event
    onSubscriptionCancelled({ email, entitlementType: 'monthly_membership' }).catch(() => {});

    console.log(`[Reconcile] Revoked monthly access email=${email}`);
  }

  // 3. Find buyers who never linked Discord — send Engage reminder
  try {
    const cutoffDate = new Date(Date.now() - 24 * 3_600_000).toISOString(); // 24h ago
    const unlinkeds = await listNftMints(
      `AND(OR({Mint Status}="Minted",{Mint Status}="Sent"),{Discord Synced}=FALSE(),IS_BEFORE({Mint Date},"${cutoffDate}"))`,
      { maxRecords: 50 }
    );
    for (const rec of unlinkeds) {
      const email   = rec.fields['Email'] ?? '';
      const nftType = rec.fields['NFT Type'] ?? '';
      if (email) {
        onDiscordLinkReminder({ email, nftType }).catch(() => {});
      }
    }
    console.log(`[Reconcile] Sent Discord link reminders to ${unlinkeds.length} members`);
  } catch (err) {
    report.errors.push(`discordLinkReminders: ${err.message}`);
  }

  return report;
}

// ── GET: status ──────────────────────────────────────────────────────────────

async function handleStatus(email, res) {
  const normalizedEmail = email.toLowerCase().trim();
  const [member, mint] = await Promise.all([
    findMemberByEmail(normalizedEmail).catch(() => null),
    findActiveMintByEmail(normalizedEmail).catch(() => null),
  ]);

  return res.status(200).json({
    ok:            true,
    email:         normalizedEmail,
    memberFound:   Boolean(member),
    nftFound:      Boolean(mint),
    nftType:       mint?.fields?.['NFT Type'] ?? null,
    mintStatus:    mint?.fields?.['Mint Status'] ?? null,
    discordLinked: Boolean(member?.fields?.['Discord ID']),
    discordId:     member?.fields?.['Discord ID'] ?? null,
    discordSync:   member?.fields?.['Discord Sync Status'] ?? null,
    entitlementKey: mint ? resolveEntitlementFromNftType(mint.fields?.['NFT Type'] ?? '') : null,
    discordAuthUrl: !member?.fields?.['Discord ID']
      ? `${DOMAIN}/api/discord?action=auth&email=${encodeURIComponent(normalizedEmail)}`
      : null,
  });
}

// ── Cron: retry failed mints ─────────────────────────────────────────────────

async function handleRetryMints() {
  if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE_ID) {
    return { skipped: true, reason: 'Airtable not configured', retried: 0, errors: 0 };
  }

  const { TIER_NFT_MAP, getNextSerial } = await import('../_lib/tiers.js');
  const { mintToEmail } = await import('../_lib/crossmint.js');
  const retried = [];
  const errors = [];
  const failedMints = await listFailedMints({ maxRecords: 50 });

  for (const record of failedMints) {
    const email        = record.fields?.['Email'] ?? '';
    const nftType      = record.fields?.['NFT Type'] ?? '';
    const tier         = record.fields?.['Tier Source'] ?? '';
    if (!email || !nftType) continue;

    const tierConfig    = TIER_NFT_MAP[tier] ?? null;
    const templateKey   = tierConfig?.template ?? null;
    const serialPrefix  = tierConfig?.serialPrefix ?? null;
    const collectionName = tierConfig?.collectionName ?? null;

    let serial = null;
    if (serialPrefix) {
      try { serial = await getNextSerial(serialPrefix); } catch { /* continue without serial */ }
    }

    try {
      const result = await mintToEmail({ email, nftType, customerName: email, templateKey, serial, collectionName, tierKey: tier });
      await updateNftMint(record.id, { 'Mint Status': 'Sent', 'Token ID': result.actionId, 'Retry Count': (record.fields['Retry Count'] ?? 0) + 1 });
      retried.push({ email, nftType, mintId: result.mintId });
    } catch (err) {
      errors.push({ email, nftType, error: err.message });
      await updateNftMint(record.id, { 'Retry Count': (record.fields['Retry Count'] ?? 0) + 1, Notes: `Retry failed: ${err.message}` }).catch(() => {});
    }
  }

  return { retried: retried.length, errors: errors.length, details: { retried, errors } };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', DOMAIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const action = req.query?.action;
    if (action === 'mint') return handleMint(req, res);
    return handleClaim(req, res);
  }

  if (req.method === 'GET') {
    const action = req.query?.action ?? 'status';

    if (!validateReconcileSecret(req)) {
      return res.status(401).json({ error: 'Unauthorized — provide ?secret= or Authorization: Bearer header' });
    }

    if (action === 'reconcile') {
      try {
        const report = await handleReconcile();
        return res.status(200).json({ ok: true, report });
      } catch (err) {
        return res.status(500).json({ error: 'Reconcile failed', detail: err.message });
      }
    }

    if (action === 'retry-mints') {
      try {
        const report = await handleRetryMints();
        return res.status(200).json({ ok: true, report });
      } catch (err) {
        return res.status(500).json({ error: 'Retry-mints failed', detail: err.message });
      }
    }

    if (action === 'status') {
      const email = req.query?.email;
      if (!email) return res.status(400).json({ error: 'Missing ?email= param' });
      return handleStatus(email, res);
    }

    return res.status(400).json({ error: 'Invalid action', valid: ['reconcile', 'retry-mints', 'status'] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
