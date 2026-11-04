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
 *   body: { recipientEmail, walletAddress?, passType (INSIDER|EMBER|OBSIDIAN|GENESIS|CHROME), transactionId?, customerName? }
 *   → fulfilNft (same as a paid webhook): serial, idempotent Crossmint mint, NFT_Mints row, delivery email
 */

import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import {
  findMemberByEmail, findActiveMintByEmail, findActiveMintsByEmail, listUnlinkedMintsBefore, listPaymentsSince,
  findLatestPaymentByEmailAndTier, listPendingDiscordSync, listOutOfSyncEntitlements, listLapsedMonthlyWithoutExpiry,
  listFailedMints, listUndeliveredMints, findMintByPaymentId, findPaymentByTransactionId, listPaymentTransactionIds,
  recordOpsEvent, updateDiscordSyncStatus, updateNftMint, createNftMint, dbConfigured,
} from '../_lib/db.js';
import { addRoleToMember, removeRoleFromMember } from '../_lib/discord-bot.js';
import { ENTITLEMENT_MAP, resolveEntitlementFromNftType, resolveEntitlementFromSku, getRoleId, shouldRevokeAccess, pickGrantableMint } from '../_lib/entitlements.js';
import { onDiscordLinkReminder, onSubscriptionCancelled } from '../_lib/engage.js';
import { sendDiscordAccessLink, sendNftDelivery } from '../_lib/email.js';
import { sendAlert } from '../_lib/alert.js';
import { fulfilNft, serialFromReference } from '../_lib/fulfil.js';
import { airtableImportEnabled, importFromAirtable, importHasProblems } from '../_lib/airtable-import.js';

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

// Entitlement → the canonical tier key that earns it (fulfilNft takes a tier).
const MANUAL_MINT_TIER = {
  product_a_reward: 'full',          // Aurevon Insider
  product_b_reward: 'retainer',      // Aurevon Ember
  product_c_reward: 'enterprise',    // Aurevon Obsidian Executive
  monthly_membership: 'comm_monthly',  // 001 Genesis
  lifetime_membership: 'comm_lifetime', // 004 Chrome
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

  if (!process.env.CROSSMINT_API_KEY) return res.status(503).json({ error: 'Crossmint not configured', hint: 'Add CROSSMINT_API_KEY to Vercel env vars' });

  const body = req.body || {};
  const { recipientEmail, walletAddress, passType } = body;
  if (!passType) return res.status(400).json({ error: 'Missing passType' });
  if (!recipientEmail && !walletAddress) return res.status(400).json({ error: 'Provide recipientEmail or walletAddress' });

  // passType is a pass art key (INSIDER | EMBER | OBSIDIAN | GENESIS | CHROME) or a
  // canonical NFT type name; anything else is refused — only the five NFTs mint.
  const art = String(passType).trim().toUpperCase();
  const entitlementKey = Object.keys(ENTITLEMENT_MAP).find((k) => ENTITLEMENT_MAP[k].serialPrefix === art)
    ?? resolveEntitlementFromNftType(String(passType));
  if (!entitlementKey) return res.status(400).json({ error: 'Unknown passType' });

  // Same pipeline as a paid webhook: reserved serial, idempotent mint keyed on
  // the transaction id, NFT_Mints row, delivery email. A body `serial` is no
  // longer honoured (serials come from the atomic counter only).
  if (!recipientEmail) return res.status(400).json({ error: 'recipientEmail is required (the mint is recorded and emailed)' });
  try {
    const result = await fulfilNft({
      transactionId: body.transactionId ?? `manual-${crypto.randomUUID()}`,
      email: recipientEmail,
      walletAddress: walletAddress || null,
      customerName: body.customerName ?? 'Aurevon Member',
      tier: MANUAL_MINT_TIER[entitlementKey],
      provider: 'manual',
      source: 'manual',
    });
    const reply = { ok: result.minted, minted: result.minted, nftType: result.nftType, serial: result.serial ?? null };
    if (!result.minted) return res.status(502).json({ ...reply, error: 'Crossmint error' });
    return res.status(200).json(reply);
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
// This sweep finds recent NFT-tier payments with NO mint row for that payment and
// writes a 'Failed' dead-letter row (carrying the payment id), which the
// retry-mints cron then mints through fulfilNft.
//
// Dedupe is by payment id only: a buyer may own two passes of one type (two
// purchases), so an existing row for the same email + NFT type proves nothing.
// A Refunded / Disputed payment is never dead-lettered.
const REVERSED_PAYMENT = new Set(['Refunded', 'Disputed']);

export async function recoverOrphanPayments({ sinceDays = 3 } = {}) {
  const { TIER_NFT_MAP, inferTierFromAmount, canonicalTier } = await import('../_lib/tiers.js');
  let payments;
  try {
    payments = await listPaymentsSince(sinceDays);
  } catch (err) {
    console.error(`[Reconcile] listPaymentsSince failed: ${err.message}`);
    return { recovered: 0, errors: 1 };
  }

  let recovered = 0;
  let errors = 0;
  for (const p of payments) {
    const email = p.fields?.['Customer Email'] ?? '';
    const storedTier = p.fields?.['Pass Type'] ?? '';
    const txnId = p.fields?.['Transaction ID'] ?? '';
    if (!email || !storedTier || !txnId) continue;
    if (REVERSED_PAYMENT.has(p.fields?.['Status'])) continue; // refunded / disputed: never mint

    let tier = storedTier;
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
        if (nftType) tier = reTier;
      }
    }
    if (!nftType) continue; // genuine no-NFT tier (add-on / second opinion) — nothing to recover

    let existing;
    try {
      existing = await findMintByPaymentId(txnId);
    } catch (err) {
      // Unknown is not "none": skip this run rather than dead-letter a duplicate.
      console.error(`[Reconcile] mint lookup failed for payment ${txnId}: ${err.message}`);
      errors++;
      continue;
    }
    if (existing) continue; // this payment has a mint row (Sent/Failed/Queued) — other paths own it

    // Orphan: paid for an NFT tier but this payment has no mint row. Dead-letter it.
    try {
      await createNftMint({
        reference:            `RECOVER_${txnId}`,
        email,
        nftType,
        tierSource:           canonicalTier(tier),
        status:               'Failed',
        sentDate:             new Date().toISOString(),
        emailDelivered:       false,
        notes:                `Recovered orphan payment ${txnId} (paid, NFT tier, no mint row) — queued for retry-mints`,
        paymentTransactionId: txnId,
        entitlementType:      resolveEntitlementFromNftType(nftType) ?? '',
        retryCount:           0,
      });
    } catch (err) {
      if (err.code === 'DUPLICATE_PAYMENT_MINT') continue; // a live run wrote it meanwhile
      console.error(`[Reconcile] dead-letter write failed for ${txnId}: ${err.message}`);
      errors++;
      continue;
    }
    recovered++;
    console.log(`[Reconcile] Dead-lettered orphan payment ${txnId} (${nftType})`);
  }
  return { recovered, errors };
}

// ── Stripe-side reconcile ────────────────────────────────────────────────────
// Every recovery path above starts from a Payments row. If the webhook never
// wrote one (event never delivered, endpoint misconfigured, every redelivery
// 500'd), nothing on our side knows the sale happened. This pass asks Stripe
// for recent complete Checkout Sessions and runs any settled one that has no
// Payments row through the webhook's own two steps (marker, then fulfilment).
const STRIPE_RECOVERY_MAX_PAGES = 5;

function chargeReversed(charge, isFullRefund) {
  return Boolean(charge && typeof charge === 'object' && (charge.disputed === true || isFullRefund(charge)));
}

export async function recoverUnrecordedStripeSessions({ sinceDays = 3, budgetMs = 30_000 } = {}) {
  const report = { skipped: false, scanned: 0, recovered: 0, errors: 0, reversed: 0, deferred: 0 };
  if (!process.env.STRIPE_SECRET_KEY) return { ...report, skipped: true };

  const [{ default: Stripe }, webhook] = await Promise.all([import('stripe'), import('../webhooks/stripe.js')]);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  const gte = Math.floor((Date.now() - sinceDays * 86_400_000) / 1000);
  const startedAt = Date.now();
  const recoveredIds = [];
  const errorIds = [];

  let startingAfter;
  for (let page = 0; page < STRIPE_RECOVERY_MAX_PAGES; page++) {
    const params = {
      status: 'complete',
      created: { gte },
      limit: 100,
      // A session refunded / disputed before it was ever recorded must not mint.
      expand: ['data.payment_intent.latest_charge', 'data.invoice.charge'],
    };
    if (startingAfter) params.starting_after = startingAfter;

    let res;
    let recorded;
    try {
      res = await stripe.checkout.sessions.list(params);
      // Only sessions this site's checkout created carry metadata.tier; anything
      // else on the account is not ours to record or email.
      const candidates = (res?.data ?? []).filter((s) => webhook.isSettledCheckout(s) && s.metadata?.tier);
      recorded = await listPaymentTransactionIds(candidates.map((s) => s.id));
    } catch (err) {
      console.error(`[Reconcile] Stripe session scan failed (page ${page + 1}): ${err.message}`);
      report.errors++;
      break;
    }

    const sessions = res?.data ?? [];
    for (const session of sessions) {
      report.scanned++;
      if (!webhook.isSettledCheckout(session) || !session.metadata?.tier) continue;
      if (recorded.has(session.id)) continue;
      if (chargeReversed(session.payment_intent?.latest_charge, webhook.isFullRefund)
        || chargeReversed(session.invoice?.charge, webhook.isFullRefund)) {
        console.log(`[Reconcile] Stripe session ${session.id} has no Payments row but was refunded/disputed — not recovering`);
        report.reversed++;
        continue;
      }
      if (Date.now() - startedAt > budgetMs) {
        report.deferred++; // next run (the window is days wide)
        continue;
      }
      try {
        const result = await webhook.recordCheckoutPayment(session);
        if (result?.status !== 'recorded') continue;
        await webhook.fulfilCheckout(session, { redelivery: false });
        report.recovered++;
        recoveredIds.push(session.id);
        console.log(`[Reconcile] Recovered unrecorded Stripe session ${session.id}`);
      } catch (err) {
        console.error(`[Reconcile] Stripe session ${session.id} recovery failed: ${err.message}`);
        report.errors++;
        errorIds.push(session.id);
      }
    }

    if (!res?.has_more || sessions.length === 0) break;
    startingAfter = sessions[sessions.length - 1].id;
  }

  if (report.recovered > 0) {
    await sendAlert('reconcile.stripe_sessions_recovered', { count: report.recovered, sessionIds: recoveredIds },
      { severity: 'high' }).catch(() => {});
  }
  if (report.errors > 0) {
    await sendAlert('reconcile.stripe_session_errors', { count: report.errors, sessionIds: errorIds },
      { severity: 'high' }).catch(() => {});
  }
  if (report.deferred > 0) {
    await sendAlert('reconcile.stripe_sessions_deferred', { count: report.deferred },
      { severity: 'warning' }).catch(() => {});
  }
  return report;
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

  // 0. Bridge: copy rows still in Airtable into Supabase (stops once AIRTABLE_* env is removed).
  if (airtableImportEnabled()) {
    report.airtableImport = await importFromAirtable().catch((err) => ({ all: { error: err.message } }));
    console.log(`[Reconcile] Airtable import: ${JSON.stringify(report.airtableImport)}`);
    if (importHasProblems(report.airtableImport)) {
      await sendAlert('reconcile.airtable_import_problems', report.airtableImport).catch(() => {});
    }
  }

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
      const mints = await findActiveMintsByEmail(email);
      if (!mints.length) continue;
      const mintRecord = pickGrantableMint(mints, member.fields);
      if (!mintRecord) {
        // Mark it so the row leaves the pending window (listPendingDiscordSync
        // caps the batch) instead of crowding out members who can be granted.
        console.log(`[Reconcile] Pending sync denied for lapsed monthly member=${member.id} — marking revoked`);
        await updateDiscordSyncStatus(email, 'revoked').catch(() => {});
        continue;
      }

      const nftType        = mintRecord.fields['NFT Type'] ?? '';
      const entitlementKey = resolveEntitlementFromNftType(nftType);
      const roleId         = entitlementKey ? getRoleId(entitlementKey) : null;
      if (!roleId) continue;

      await addRoleToMember(discordId, roleId);
      await updateDiscordSyncStatus(email, 'synced');
      await updateNftMint(mintRecord.id, { 'Discord Synced': true, 'Discord Synced At': now });
      report.roleAssigned++;
      console.log(`[Reconcile] Role assigned member=${member.id}`);
    } catch (err) {
      report.syncFailed++;
      report.errors.push(`sync member=${member.id}: ${err.message}`);
      await updateDiscordSyncStatus(email, 'failed', { error: err.message }).catch(() => {});
    }
  }

  // 2. Find monthly members whose access should be revoked
  const gracePeriodDays = parseInt(process.env.ENTITLEMENT_GRACE_PERIOD_DAYS ?? '7', 10);
  const revokeIfLapsed = async (member, endsAt) => {
    const email     = member.fields?.['Email'] ?? '';
    const discordId = member.fields?.['Discord ID'];
    const needsRevoke = shouldRevokeAccess({
      membershipMode: 'recurring',
      revokeOnCancel: true,
      billingState:   member.fields?.['Billing State'] ?? 'cancelled',
      endsAt,
      gracePeriodDays,
    });
    if (!needsRevoke || !email) return;

    report.revokeApplied++;

    // Remove the monthly role
    if (discordId) {
      const roleId = getRoleId('monthly_membership');
      if (roleId) {
        await removeRoleFromMember(discordId, roleId).catch((err) => {
          report.errors.push(`removeRole member=${member.id}: ${err.message}`);
        });
      }
    }

    // Update member record
    await updateDiscordSyncStatus(email, 'revoked').catch(() => {});

    // Fire Engage event
    onSubscriptionCancelled({ email, entitlementType: 'monthly_membership' }).catch(() => {});

    console.log(`[Reconcile] Revoked monthly access member=${member.id}`);
  };

  let expiredMembers = [];
  try {
    expiredMembers = await listOutOfSyncEntitlements({ graceDays: gracePeriodDays });
    report.revokeChecked += expiredMembers.length;
    console.log(`[Reconcile] ${expiredMembers.length} monthly members to review for revocation`);
  } catch (err) {
    report.errors.push(`listOutOfSyncEntitlements: ${err.message}`);
  }
  for (const member of expiredMembers) {
    await revokeIfLapsed(member, member.fields?.['Entitlement Expires At']);
  }

  // 2b. Lapsed monthly members with no Entitlement Expires At (cancelled before
  // any invoice stamped one): the grace window runs from the last Discord sync,
  // else the join date.
  let undatedMembers = [];
  try {
    undatedMembers = await listLapsedMonthlyWithoutExpiry({ maxRecords: 100 });
    report.revokeChecked += undatedMembers.length;
  } catch (err) {
    report.errors.push(`listLapsedMonthlyWithoutExpiry: ${err.message}`);
  }
  for (const member of undatedMembers) {
    await revokeIfLapsed(member, member.fields?.['Discord Sync At'] ?? member.fields?.['Join Date'] ?? null);
  }

  // 3. Find buyers who never linked Discord — send Engage reminder
  try {
    const cutoffDate = new Date(Date.now() - 24 * 3_600_000).toISOString(); // 24h ago
    const unlinkeds = await listUnlinkedMintsBefore(cutoffDate, { maxRecords: 50 });
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

  // 4a. Stripe-side: settled Checkout Sessions with no Payments row at all
  // (webhook never delivered). Runs first so 4b sees the rows it writes.
  // Both recovery passes count their own per-row errors instead of throwing;
  // those counts go into report.errors so reconcile.errors alerts on them.
  report.stripeSessionErrors = 0;
  report.orphanErrors = 0;
  try {
    report.stripeSessions = await recoverUnrecordedStripeSessions({ sinceDays: 3 });
    report.stripeSessionErrors = Number(report.stripeSessions?.errors) || 0;
    if (report.stripeSessionErrors > 0) report.errors.push(`stripe_session_errors: ${report.stripeSessionErrors}`);
  } catch (err) {
    report.errors.push(`recoverUnrecordedStripeSessions: ${err.message}`);
  }

  // 4b. Recover orphan payments (paid, NFT tier, but no mint row — webhook died mid-pipeline)
  try {
    const { recovered, errors } = await recoverOrphanPayments({ sinceDays: 3 });
    report.orphansRecovered = recovered;
    report.orphanErrors = Number(errors) || 0;
    if (recovered > 0) console.log(`[Reconcile] Dead-lettered ${recovered} orphan payment(s) for retry-mints`);
    if (report.orphanErrors > 0) report.errors.push(`orphan_errors: ${report.orphanErrors}`);
  } catch (err) {
    report.errors.push(`recoverOrphanPayments: ${err.message}`);
  }

  // Vercel Cron discards the HTTP response body, so these error tallies would
  // otherwise vanish. Surface them proactively (no PII — counts only).
  if (report.errors.length > 0) {
    await sendAlert('reconcile.errors', { count: report.errors.length, syncFailed: report.syncFailed });
  }
  if (report.orphansRecovered > 0) {
    await sendAlert('reconcile.orphans_recovered', { count: report.orphansRecovered });
  }

  await heartbeat('cron.reconcile.ok', {
    roleAssigned: report.roleAssigned,
    syncFailed: report.syncFailed,
    revokeChecked: report.revokeChecked,
    revokeApplied: report.revokeApplied,
    orphansRecovered: report.orphansRecovered,
    stripeSessionsRecovered: report.stripeSessions?.recovered ?? 0,
    ...(report.orphanErrors > 0 ? { orphanErrors: report.orphanErrors } : {}),
    ...(report.stripeSessionErrors > 0 ? { stripeSessionErrors: report.stripeSessionErrors } : {}),
    errors: report.errors.length,
  });

  return report;
}

/** Cron heartbeat for the ops log. A failed write is logged, never thrown. */
async function heartbeat(event, detail) {
  try {
    await recordOpsEvent({ event, severity: 'info', detail });
  } catch (err) {
    console.error(`[cron] heartbeat ${event} not recorded: ${err.message}`);
  }
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

/**
 * Crossmint PUT key for a Failed-row retry. Prefixes (`RECOVER_`, `PAY_`) and
 * Stripe session ids carry the payment id already. A serial Reference must be
 * resolved through Payments — that is the key the webhook used on the first try.
 */
export async function resolveRetryIdempotencyKey({ reference, email, tier, recordId }) {
  const ref = String(reference ?? '');
  if (ref.startsWith('RECOVER_')) return ref.slice('RECOVER_'.length);
  if (ref.startsWith('PAY_')) return ref.slice('PAY_'.length);
  if (/^cs_(live|test)_/.test(ref)) return ref;
  if (email && tier) {
    // No .catch: a database error must not fall through to the serial key
    // (that reopens the double-mint). The caller skips the row this run.
    const payment = await findLatestPaymentByEmailAndTier(email, tier);
    const txnId = payment?.fields?.['Transaction ID'];
    if (txnId) return String(txnId);
  }
  return ref || `retry_${recordId}`;
}

const MAX_MINT_RETRIES = 5;
// A row this young may belong to a run that is still sending its email.
const UNDELIVERED_MIN_AGE_MS = 10 * 60_000;

/**
 * The tier fulfilNft should mint a Failed row as: its Tier Source when that
 * earns an NFT, else the canonical tier of its NFT Type (older rows may carry
 * an 'unknown' / unmapped Tier Source).
 */
function retryTier(fields) {
  const tierSource = fields?.['Tier Source'] ?? '';
  if (resolveEntitlementFromSku(tierSource)) return tierSource;
  const key = resolveEntitlementFromNftType(fields?.['NFT Type'] ?? '');
  return key ? MANUAL_MINT_TIER[key] : null;
}

/**
 * Cron (every 15 min): finish the NFT pipeline for rows that did not.
 *
 * 1. Failed mint rows (≤10 per run, under the retry cap) go back through
 *    fulfilNft with their payment id — it retries in place: stored serial,
 *    same Crossmint idempotency key, Retry Count / Last Error, minted email +
 *    Email Delivered on success. Dedupe is by payment id, never email + type.
 *    Legacy rows without a payment id resolve one (resolveRetryIdempotencyKey),
 *    and only proceed when no OTHER row already holds that payment; the id is
 *    backfilled first so every later run dedupes by payment.
 * 2. Minted/Sent rows whose delivery email never went out are re-sent.
 * 3. Heartbeat `cron.retry_mints.ok` in ops_events.
 */
export async function handleRetryMints() {
  if (!dbConfigured()) {
    return { skipped: true, reason: 'Database not configured', retried: 0, errors: 0 };
  }

  const stats = {
    retried: 0, minted: 0, failed: 0, gaveUp: 0, delivered: 0, remaining: 0,
    skippedLookupErrors: 0, legacySkipped: 0, reversed: 0, emailFailed: 0, resendSkipped: 0,
  };
  const touched = new Set();

  const giveUp = async (rowId, reason) => {
    stats.gaveUp++;
    console.error(`[retry-mints] row ${rowId} gave up (${reason}) — needs an operator`);
    await sendAlert('retry_mints.gave_up', { rowId, reason }, { severity: 'high', dedupeKey: `gave_up:${rowId}` }).catch(() => {});
  };

  const failedRows = await listFailedMints({ maxRecords: 10, maxRetries: MAX_MINT_RETRIES });

  for (const row of failedRows) {
    const f = row.fields ?? {};
    const email = f['Email'] ?? '';
    if (!email) continue;
    const retryCount = Number(f['Retry Count'] ?? 0);
    if (retryCount >= MAX_MINT_RETRIES) {
      await giveUp(row.id, 'retry cap reached');
      continue;
    }
    const tier = retryTier(f);
    if (!tier) {
      // Not one of the five NFTs: nothing can mint it. Park it off the queue.
      await updateNftMint(row.id, { 'Retry Count': MAX_MINT_RETRIES, 'Last Error': 'No NFT tier for this row' }).catch(() => {});
      await giveUp(row.id, 'no NFT tier');
      continue;
    }

    // ── payment id (the dedupe + Crossmint idempotency key) ──
    let transactionId = f['Payment Transaction ID'] || null;
    if (!transactionId) {
      try {
        transactionId = await resolveRetryIdempotencyKey({ reference: f['Reference'], email, tier: f['Tier Source'] || tier, recordId: row.id });
        const holder = await findMintByPaymentId(transactionId);
        if (holder && holder.id !== row.id) {
          // Another row already holds this payment: this one is a stale
          // duplicate. Retrying would mint the payment twice. Park it.
          stats.legacySkipped++;
          await updateNftMint(row.id, {
            'Retry Count': MAX_MINT_RETRIES,
            'Last Error': `Not retried: payment ${transactionId} already has mint row ${holder.id}`,
          }).catch(() => {});
          await sendAlert('retry_mints.legacy_row_skipped', { rowId: row.id, transactionId, holderId: holder.id },
            { severity: 'warning', dedupeKey: `legacy:${row.id}` }).catch(() => {});
          continue;
        }
        if (!holder) await updateNftMint(row.id, { 'Payment Transaction ID': transactionId });
      } catch (err) {
        // A failed lookup / backfill is not "no other row": skip this run.
        console.error(`[retry-mints] payment resolution failed for row ${row.id}: ${err.message} — skipping this run`);
        stats.skippedLookupErrors++;
        continue;
      }
    }

    let payment;
    try {
      payment = await findPaymentByTransactionId(transactionId);
    } catch (err) {
      console.error(`[retry-mints] payment lookup failed for row ${row.id}: ${err.message} — skipping this run`);
      stats.skippedLookupErrors++;
      continue;
    }
    if (REVERSED_PAYMENT.has(payment?.fields?.['Status'])) {
      // Refunded / disputed before the retry: never mint it.
      stats.reversed++;
      await updateNftMint(row.id, {
        'Mint Status': 'Revoked',
        'Revoked At': new Date().toISOString(),
        'Last Error': `Not retried: payment ${payment.fields['Status']}`,
      }).catch(() => {});
      continue;
    }

    stats.retried++;
    touched.add(row.id);
    let result;
    try {
      result = await fulfilNft({
        transactionId,
        email,
        customerName: payment?.fields?.['Customer Name'] ?? 'Aurevon Member',
        tier,
        provider: 'retry',
        source: 'cron',
      });
    } catch (err) {
      // fulfilNft only throws on programmer errors; count it so the cap applies.
      result = { minted: false };
      await updateNftMint(row.id, { 'Retry Count': retryCount + 1, 'Last Error': err.message }).catch(() => {});
    }

    if (result.minted) {
      stats.minted++;
    } else {
      stats.failed++;
      if (retryCount + 1 >= MAX_MINT_RETRIES) await giveUp(row.id, 'retry cap reached');
    }
  }

  // ── Delivery emails that never went out ──
  // The query itself drops legacy rows (no payment id: they predate delivery
  // tracking) and rows under 10 minutes old (a live run may still be sending),
  // so neither can fill the 20-row window ahead of a deliverable row.
  let undelivered = [];
  try {
    undelivered = await listUndeliveredMints({
      maxRecords: 20,
      createdBefore: new Date(Date.now() - UNDELIVERED_MIN_AGE_MS).toISOString(),
    });
  } catch (err) {
    console.error(`[retry-mints] listUndeliveredMints failed: ${err.message}`);
  }
  // A row that can never be sent leaves the window: flagged delivered, with why.
  const skipForGood = async (row, reason) => {
    stats.resendSkipped++;
    const prior = row.fields?.['Notes'] ? `${row.fields['Notes']} | ` : '';
    await updateNftMint(row.id, { 'Email Delivered': true, 'Notes': `${prior}resend skipped: ${reason}` }).catch((err) => {
      console.error(`[retry-mints] could not park undelivered row ${row.id}: ${err.message}`);
    });
  };
  for (const row of undelivered) {
    const f = row.fields ?? {};
    if (touched.has(row.id)) continue;                       // handled by the retry above
    if (!['Sent', 'Minted'].includes(f['Mint Status'])) continue;
    if (f['Email Delivered'] === true) continue;
    const transactionId = f['Payment Transaction ID'] || null;
    if (!transactionId) continue;                            // the query excludes these
    if (!f['Email']) { await skipForGood(row, 'no recipient email'); continue; }
    const entitlementKey = resolveEntitlementFromNftType(f['NFT Type'] ?? '');
    if (!entitlementKey) { await skipForGood(row, 'no entitlement for this NFT type'); continue; }

    const payment = await findPaymentByTransactionId(transactionId).catch(() => null);
    if (REVERSED_PAYMENT.has(payment?.fields?.['Status'])) {
      await skipForGood(row, `payment ${payment.fields['Status']}`);
      continue;
    }
    try {
      await sendNftDelivery({
        email: f['Email'],
        customerName: payment?.fields?.['Customer Name'] ?? 'Aurevon Member',
        nftType: f['NFT Type'],
        mintId: f['Crossmint Action ID'] || f['Token ID'] || 'minted',
        discordInviteUrl: process.env.DISCORD_INVITE_URL,
        serial: serialFromReference(f['Reference'], ENTITLEMENT_MAP[entitlementKey].serialPrefix),
        status: 'minted',
        transactionId,
      });
    } catch (err) {
      stats.emailFailed++;
      console.error(`[retry-mints] delivery email failed for row ${row.id}: ${err.message}`);
      await sendAlert('retry_mints.email_failed', { rowId: row.id, transactionId, error: err.message },
        { severity: 'warning', dedupeKey: `email:${row.id}` }).catch(() => {});
      continue;
    }
    stats.delivered++;
    await updateNftMint(row.id, { 'Email Delivered': true }).catch((err) => {
      console.error(`[retry-mints] could not flag Email Delivered on ${row.id}: ${err.message}`);
    });
  }

  // Rows from this batch still queued for a later run.
  stats.remaining = stats.failed - stats.gaveUp + stats.skippedLookupErrors;
  if (stats.remaining < 0) stats.remaining = 0;

  if (stats.failed > 0) {
    await sendAlert('retry_mints.errors', { count: stats.failed, retried: stats.retried }).catch(() => {});
  }
  const { retried, minted, failed, gaveUp, delivered, remaining } = stats;
  await heartbeat('cron.retry_mints.ok', { retried, minted, failed, gaveUp, delivered, remaining });

  return { ...stats, errors: stats.failed };
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
