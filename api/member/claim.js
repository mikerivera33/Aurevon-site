/**
 * Member claim + reconcile endpoint — /api/member/claim
 *
 * POST  body: { email }   ("request my access link" — UNAUTHENTICATED, public)
 *   → Looks up membership READ-ONLY. If a real mint exists, emails a signed,
 *     email-bound, expiring, single-use Discord access link to that inbox.
 *   → ALWAYS returns the same uniform body — no membership/tier disclosure (M2),
 *     no member-row writes. Discord binding happens ONLY via the token-gated
 *     OAuth flow in api/discord.js.
 *
 * All GET actions are secret-gated. Secret is HEADER-ONLY (L2):
 *   Authorization: Bearer <RECONCILE_SECRET|CRON_SECRET>  (never ?secret=)
 *
 * GET  ?action=reconcile
 *   → Assigns roles for pending members, revokes expired monthly members, etc.
 *
 * GET  ?action=status&email=<email>
 *   → Operator-only: returns member entitlement + sync status.
 *
 * POST ?action=mint
 *   body: { recipientEmail, walletAddress?, passType, metadata? }
 *   → Mints the correct NFT via Crossmint (absorbed from api/crossmint/mint.js)
 */

import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { findMemberByEmail, findActiveMintByEmail, findActiveMintByEmailAndType, findAnyMintByEmailAndType, listNftMints, listPaymentsSince, listPendingDiscordSync, listOutOfSyncEntitlements, listFailedMints, updateDiscordSyncStatus, updateNftMint, createNftMint } from '../_lib/airtable.js';
import { addRoleToMember, removeRoleFromMember } from '../_lib/discord-bot.js';
import { resolveEntitlementFromNftType, getRoleId, shouldRevokeAccess } from '../_lib/entitlements.js';
import { onDiscordLinkReminder, onSubscriptionCancelled } from '../_lib/engage.js';
import { sendDiscordAccessLink } from '../_lib/email.js';

const DOMAIN = process.env.DOMAIN ?? 'https://www.aurevonvc.com';

// Two callers authenticate here with DIFFERENT secrets (both via header only, L2):
//   - operator.html / manual retries  → Authorization: Bearer <RECONCILE_SECRET>
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
  // Header-only (L2): the secret must arrive via `Authorization: Bearer <secret>`,
  // never via ?secret= — query strings are captured in Vercel/CDN access logs.
  // Vercel cron already sends the Bearer header; manual operator flows must too.
  const authHeader = req.headers?.['authorization'] ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
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
  // Authenticated server-to-server endpoint (Zapier/Make automation — see
  // AUTOMATION_PLAYBOOKS.md, which calls this with Authorization: Bearer
  // <INTERNAL_API_SECRET>). Without this gate ANYONE could trigger arbitrary,
  // irreversible Crossmint mints to any recipient email/wallet and drain the
  // mint budget. Accept the secret via Bearer header or x-internal-secret
  // (mirrors api/email/send.js).
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!internalSecret) {
    return res.status(500).json({ error: 'Mint endpoint not configured' });
  }
  const provided = (req.headers?.['authorization'] ?? '').replace('Bearer ', '').trim()
    || (req.headers?.['x-internal-secret'] ?? '');
  let authorized = false;
  if (provided.length === internalSecret.length) {
    try {
      authorized = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(internalSecret));
    } catch {
      authorized = false;
    }
  }
  if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

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

// Uniform, non-disclosing reply. Same body regardless of membership state so an
// anonymous caller cannot use this endpoint as a membership/tier enumeration oracle.
const CLAIM_UNIFORM_MESSAGE =
  "If this email has an Aurevon membership, we've emailed your secure access link. Check your inbox (and spam).";

async function handleClaim(req, res) {
  const { email } = req.body ?? {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // SECURITY (M2): this endpoint is UNAUTHENTICATED. It MUST NOT:
  //   (a) disclose membership/NFT/tier details (enumeration oracle), or
  //   (b) write member rows for arbitrary emails (table pollution — the old
  //       upsertMemberByEmail(email,{Active:true}) let anyone create Active members).
  // Instead we treat this as "request my access link": look up the mint READ-ONLY,
  // and if (and only if) a real membership exists, EMAIL a signed, email-bound,
  // expiring, single-use Discord access link to that address — so only the inbox
  // owner learns their status and can complete linking. We ALWAYS return the same
  // uniform body. We also do NOT honor any body-supplied discordId/wallet: the ONLY
  // way to bind a Discord account is the token-gated OAuth flow in api/discord.js.
  let mintRecord = null;
  try {
    mintRecord = await findActiveMintByEmail(normalizedEmail);
  } catch (err) {
    console.error(`[Claim] findActiveMintByEmail error: ${err.message}`);
  }

  if (mintRecord) {
    // Real membership — deliver the tokenized access link to the inbox owner.
    //
    // TIMING ORACLE (M2): findActiveMintByEmail runs in BOTH branches, so the
    // synchronous work is symmetric. But the Resend send is a ~100-800ms external
    // HTTPS round-trip; awaiting it ONLY on the member branch would make member
    // responses measurably slower than non-member responses, letting an anonymous
    // caller enumerate who is/isn't a member by latency alone — reopening the very
    // enumeration hole the uniform body closed. So we do NOT await the send here.
    //
    // We register it with waitUntil instead: the handler returns IMMEDIATELY in
    // both branches (identical timing), while Vercel keeps the function alive until
    // the send resolves. A bare un-awaited promise would NOT work — on Vercel it is
    // frozen/killed the moment the function returns, silently dropping the email.
    // Send failures are logged only (never surfaced) so nothing leaks into the
    // uniform response.
    waitUntil(
      sendDiscordAccessLink({ email: normalizedEmail })
        .then((result) => {
          if (!result?.ok) console.error(`[Claim] access-link send failed: ${result?.error}`);
        })
        .catch((err) => console.error(`[Claim] access-link send threw: ${err.message}`))
    );
  }

  return res.status(200).json({ ok: true, message: CLAIM_UNIFORM_MESSAGE });
}

// ── Orphan-payment recovery ──────────────────────────────────────────────────
// Closes the durability gap introduced by the webhook's fatal idempotency marker:
// if the function dies AFTER writing the Payments marker but BEFORE writing the
// NFT_Mints row (e.g. maxDuration hit during the Crossmint call), the marker
// makes every redelivery skip, so the mint is silently dropped and nothing
// recovers it (retry-mints needs a Failed row; reconcile never queried Payments).
// This sweep finds recent NFT-tier payments with NO mint row at all and writes a
// 'Failed' dead-letter row, which the (idempotent) retry-mints cron then recovers.
export async function recoverOrphanPayments({ sinceDays = 3 } = {}) {
  const { TIER_NFT_MAP, inferTierFromAmount } = await import('../_lib/tiers.js');
  let payments;
  try {
    payments = await listPaymentsSince(sinceDays);
  } catch (err) {
    console.error(`[Reconcile] listPaymentsSince failed: ${err.message}`);
    return { recovered: 0, errors: 1 };
  }

  let recovered = 0;
  for (const p of payments) {
    const email = p.fields?.['Customer Email'] ?? '';
    const tier  = p.fields?.['Pass Type'] ?? '';
    if (!email || !tier) continue;

    let nftType = TIER_NFT_MAP[tier]?.nft ?? null;
    // If the stored tier doesn't map to an NFT it may be a payment whose tier
    // inference failed at webhook time (stored as 'unknown' / an unmapped label).
    // Re-infer from the paid amount before concluding it's a genuine no-NFT tier
    // — otherwise an NFT-priced payment with a bad tier label is never recovered.
    if (!nftType) {
      const amount = parseFloat(p.fields?.['Amount']);
      if (amount > 0) {
        const reTier = inferTierFromAmount(Math.round(amount * 100));
        nftType = reTier ? (TIER_NFT_MAP[reTier]?.nft ?? null) : null;
      }
    }
    if (!nftType) continue; // genuine no-NFT tier (add-on / second opinion) — nothing to recover

    const existing = await findAnyMintByEmailAndType(email, nftType).catch(() => null);
    if (existing) continue; // a mint row exists (Sent/Failed/Queued) — handled by other paths

    // Orphan: paid for an NFT tier but no mint row exists at all. Dead-letter it.
    const txnId = p.fields?.['Transaction ID'] ?? p.id;
    await createNftMint({
      reference:       `RECOVER_${txnId}`,
      email,
      nftType,
      tierSource:      tier,
      status:          'Failed',
      sentDate:        new Date().toISOString(),
      emailDelivered:  false,
      notes:           `Recovered orphan payment ${txnId} (paid, NFT tier, no mint row) — queued for retry-mints`,
    }).catch((err) => console.error(`[Reconcile] dead-letter write failed for ${txnId}: ${err.message}`));
    recovered++;
    console.log(`[Reconcile] Dead-lettered orphan payment ${txnId} for ${email} (${nftType})`);
  }
  return { recovered };
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
    orphansRecovered: 0,
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

  // 4. Recover orphan payments (paid, NFT tier, but no mint row — webhook died mid-pipeline)
  try {
    const { recovered } = await recoverOrphanPayments({ sinceDays: 3 });
    report.orphansRecovered = recovered;
    if (recovered > 0) console.log(`[Reconcile] Dead-lettered ${recovered} orphan payment(s) for retry-mints`);
  } catch (err) {
    report.errors.push(`recoverOrphanPayments: ${err.message}`);
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
    // Operator-only (this handler is secret-gated). Do NOT emit a forgeable
    // ?email= auth URL — /api/discord?action=auth now requires a signed token that
    // only the member can obtain via their emailed access link. Point operators at
    // the member-claim page, which triggers that tokenized email.
    claimPageUrl: !member?.fields?.['Discord ID'] ? `${DOMAIN}/member-claim.html` : null,
  });
}

// ── Cron: retry failed mints ─────────────────────────────────────────────────

export async function handleRetryMints() {
  if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE_ID) {
    return { skipped: true, reason: 'Airtable not configured', retried: 0, errors: 0 };
  }

  const { TIER_NFT_MAP, getNextSerial } = await import('../_lib/tiers.js');
  const { mintToEmail } = await import('../_lib/crossmint.js');
  const retried = [];
  const errors = [];
  const skippedDup = [];
  const failedMints = await listFailedMints({ maxRecords: 50 });

  for (const record of failedMints) {
    const email        = record.fields?.['Email'] ?? '';
    const nftType      = record.fields?.['NFT Type'] ?? '';
    const tier         = record.fields?.['Tier Source'] ?? '';
    if (!email || !nftType) continue;

    // Idempotency: if an active mint of this type already exists for the email,
    // this "Failed" row is a stale artifact (the original mint actually went
    // through) — re-minting would create a SECOND on-chain asset. Resolve it
    // against the canonical record instead of re-minting.
    const existingActive = await findActiveMintByEmailAndType(email, nftType).catch(() => null);
    if (existingActive) {
      await updateNftMint(record.id, {
        'Mint Status': existingActive.fields?.['Mint Status'] ?? 'Sent',
        'Token ID':    existingActive.fields?.['Token ID'] ?? record.fields?.['Token ID'] ?? '',
        'Notes':       `Retry skipped: active mint already exists for ${email} (${nftType}); not re-minting.`,
      }).catch(() => {});
      skippedDup.push({ email, nftType });
      continue;
    }

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
      // mintToEmail returns {ok:false} on API failure (it only throws for config errors).
      // Without this check a failed retry was stamped 'Sent' with an undefined Token ID,
      // leaving listFailedMints forever and poisoning the idempotency guard.
      if (!result.ok) throw new Error(result.error ?? 'Crossmint returned ok:false');
      await updateNftMint(record.id, { 'Mint Status': 'Sent', 'Token ID': result.actionId ?? '', 'Retry Count': (record.fields['Retry Count'] ?? 0) + 1 });
      retried.push({ email, nftType, mintId: result.actionId });
    } catch (err) {
      errors.push({ email, nftType, error: err.message });
      await updateNftMint(record.id, { 'Retry Count': (record.fields['Retry Count'] ?? 0) + 1, Notes: `Retry failed: ${err.message}` }).catch(() => {});
    }
  }

  return {
    retried: retried.length,
    errors: errors.length,
    skippedDuplicates: skippedDup.length,
    details: { retried, errors, skippedDuplicates: skippedDup },
  };
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
      return res.status(401).json({ error: 'Unauthorized — provide Authorization: Bearer <secret> header' });
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
