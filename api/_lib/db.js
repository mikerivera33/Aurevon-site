/**
 * Data layer — Supabase Postgres (project "aurevon-site").
 *
 * Replaces the Airtable REST client. Callers keep the same function names and
 * the same record shape they used with Airtable:
 *
 *   { id, fields: { 'Email': …, 'Mint Status': … } }
 *
 * Field names are the old Airtable display names; FIELDS maps them to columns.
 * Writing an unknown field throws (fail loud, like Airtable's 422), so drift
 * shows up in tests instead of silently dropping data.
 *
 * Env: SUPABASE_URL + SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY).
 * Server-only. Tables have RLS on and no client grants; only the secret key
 * (service_role) can read or write. Schema: supabase/migrations/.
 */

import { createClient } from '@supabase/supabase-js';

// ── Field maps (Airtable display name → column) ─────────────────────────────

export const FIELDS = {
  members: {
    'Email': 'email',
    'Customer Name': 'customer_name',
    'Member Tier': 'member_tier',
    'Active': 'active',
    'Join Date': 'join_date',
    'Wallet Address': 'wallet_address',
    'NFT Holdings': 'nft_holdings',
    'Discord ID': 'discord_id',
    'Discord Username': 'discord_username',
    'Discord Linked At': 'discord_linked_at',
    'Discord Sync Status': 'discord_sync_status',
    'Discord Sync At': 'discord_sync_at',
    'Discord Sync Error': 'discord_sync_error',
    // Consecutive failed role syncs; reconcile gives up after 3 (reset on success).
    'Discord Sync Attempts': 'discord_sync_attempts',
    'Discord Auth Nonce Used': 'discord_auth_nonce_used',
    'Entitlement Type': 'entitlement_type',
    'Entitlement Status': 'entitlement_status',
    'Entitlement Expires At': 'entitlement_expires_at',
    'Billing State': 'billing_state',
    'Notes': 'notes',
  },
  payments: {
    'Transaction ID': 'transaction_id',
    'Payment Provider': 'payment_provider',
    'Pass Type': 'pass_type',
    'Service Product': 'service_product',
    'Amount': 'amount',
    'Customer Email': 'customer_email',
    'Customer Name': 'customer_name',
    'Status': 'status',
    'Token': 'token',
    'Payment Date': 'payment_date',
    'Deliverable Status': 'deliverable_status',
    'Delivery Notes': 'delivery_notes',
  },
  nft_mints: {
    'Reference': 'reference',
    'Email': 'email',
    'NFT Type': 'nft_type',
    'Tier Source': 'tier_source',
    'Mint Status': 'mint_status',
    'Mint Date': 'mint_date',
    'Email Delivered': 'email_delivered',
    'Notes': 'notes',
    'Token ID': 'token_id',
    'Retry Count': 'retry_count',
    'Entitlement Type': 'entitlement_type',
    'Discord Synced': 'discord_synced',
    'Discord Synced At': 'discord_synced_at',
    'Transaction Hash': 'transaction_hash',
    'Wallet Address': 'wallet_address',
    'Payment Transaction ID': 'payment_transaction_id',
    'Crossmint Action ID': 'crossmint_action_id',
    'Revoked At': 'revoked_at',
    'Last Error': 'last_error',
    'Next Retry At': 'next_retry_at',
    // Crossmint idempotency-key suffix: bumped when Crossmint reports the mint
    // action failed, so the next retry mints under `<payment>-r<n>`.
    'Mint Key Suffix': 'mint_key_suffix',
  },
  customer_auth: {
    'Email': 'email',
    'Customer Name': 'customer_name',
    'Member Tier': 'member_tier',
    'Magic Token': 'magic_token',
    'Token Expires': 'token_expires',
    'Session Token': 'session_token',
    'Session Active': 'session_active',
    'Last Login': 'last_login',
  },
  leads: {
    'Name': 'name',
    'Email': 'email',
    'Phone': 'phone',
    'Company': 'company',
    'Tier': 'tier',
    'Source': 'source',
    'Status': 'status',
    'Property Address': 'property_address',
    'Purchase Price': 'purchase_price',
    'Asset Type': 'asset_type',
    'Hold Period': 'hold_period',
    'Deal Summary': 'deal_summary',
    'Add-ons': 'addons',
    'Promo Code': 'promo_code',
    'Payment Token': 'payment_token',
    'Analyst': 'analyst',
    'Notes': 'notes',
  },
  // Pipeline health log (crons, alert dedupe). Not readable from the owner consoles.
  ops_events: {
    'Event': 'event',
    'Severity': 'severity',
    'Dedupe Key': 'dedupe_key',
    'Detail': 'detail',
  },
};

// Columns where '' must become NULL (Postgres rejects '' for these types).
const NON_TEXT = new Set([
  'active', 'join_date', 'discord_linked_at', 'discord_sync_at', 'entitlement_expires_at',
  'amount', 'purchase_price', 'payment_date', 'mint_date', 'email_delivered', 'retry_count', 'discord_synced',
  'discord_synced_at', 'token_expires', 'session_active', 'last_login', 'revoked_at', 'detail',
  'next_retry_at', 'mint_key_suffix', 'discord_sync_attempts',
]);
const EMAIL_COLUMNS = new Set(['email', 'customer_email']);

const ACTIVE_MINT = ['Minted', 'Sent', 'Queued'];

// ── Client ───────────────────────────────────────────────────────────────────

let client = null;

export function supabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing SUPABASE_URL env var');
  if (!key) throw new Error('Missing SUPABASE_SECRET_KEY env var');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}

/** True when the Supabase env vars are present (crons skip cleanly otherwise). */
export function dbConfigured() {
  return Boolean((process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
    && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
}

/** Test hook: drop the cached client so env changes take effect. */
export function _resetClient() { client = null; }

// ── Mapping ──────────────────────────────────────────────────────────────────

const normEmail = (e) => String(e ?? '').trim().toLowerCase();

export function toRow(table, fields) {
  const map = FIELDS[table];
  const row = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    const col = map[name];
    if (!col) throw new Error(`Unknown field "${name}" for table ${table}`);
    let v = value;
    if (v === undefined) continue;
    if (v === '' && NON_TEXT.has(col)) v = null;
    if (EMAIL_COLUMNS.has(col) && typeof v === 'string') v = normEmail(v);
    row[col] = v;
  }
  return row;
}

export function toRecord(table, row) {
  if (!row) return null;
  const fields = {};
  for (const [name, col] of Object.entries(FIELDS[table])) {
    const v = row[col];
    if (v !== null && v !== undefined) fields[name] = (col === 'amount' || col === 'purchase_price') ? Number(v) : v;
  }
  if (row.created_at) fields['Created At'] = row.created_at;
  return { id: row.id, fields };
}

function check({ data, error }, what) {
  if (error) {
    const e = new Error(`Supabase ${what}: ${error.message}`);
    e.code = error.code;
    throw e;
  }
  return data;
}

async function insert(table, fields) {
  const res = await supabase().from(table).insert(toRow(table, fields)).select().single();
  return toRecord(table, check(res, `insert ${table}`));
}

async function update(table, id, fields) {
  const row = toRow(table, fields);
  if (Object.keys(row).length === 0) return null;
  const res = await supabase().from(table).update(row).eq('id', id).select().single();
  return toRecord(table, check(res, `update ${table}/${id}`));
}

async function upsertByEmail(table, email, fields) {
  const row = { ...toRow(table, fields), email: normEmail(email) };
  const res = await supabase().from(table).upsert(row, { onConflict: 'email' }).select().single();
  return toRecord(table, check(res, `upsert ${table}`));
}

async function many(table, query, what) {
  return (check(await query, what) ?? []).map((r) => toRecord(table, r));
}

async function one(table, query, what) {
  const rows = check(await query.limit(1), what) ?? [];
  return toRecord(table, rows[0] ?? null);
}

const from = (table) => supabase().from(table).select('*');

/** Health check: true when the database answers. Throws with the reason otherwise. */
export async function ping() {
  check(await supabase().from('payments').select('id', { head: true, count: 'exact' }).limit(1), 'ping');
  return true;
}

// ── NFT mints ────────────────────────────────────────────────────────────────

/** Number of mints whose Reference starts with `${prefix}_` (next serial). */
export async function countNftMintsByPrefix(prefix) {
  const res = await supabase().from('nft_mints')
    .select('id', { count: 'exact', head: true })
    .like('reference', `${prefix}\\_%`);
  check(res, 'countNftMintsByPrefix');
  return res.count ?? 0;
}

/**
 * Atomically reserve the next serial number for a prefix (public.next_serial:
 * INSERT … ON CONFLICT DO UPDATE last = last + 1). Concurrent webhooks never
 * get the same number.
 */
export async function nextSerial(prefix) {
  const res = await supabase().rpc('next_serial', { p_prefix: prefix });
  const n = Number(check(res, 'nextSerial'));
  if (!Number.isInteger(n) || n < 1) throw new Error(`Supabase nextSerial: unexpected result for ${prefix}`);
  return n;
}

/**
 * Insert an NFT mint row. Two UNIQUE indexes make this the mint idempotency
 * marker: a serial collision throws err.code === 'DUPLICATE_REFERENCE', and a
 * second mint for the same payment throws err.code === 'DUPLICATE_PAYMENT_MINT'.
 */
export async function createNftMint({
  reference, email, nftType, tierSource, status, sentDate,
  emailDelivered = false, notes = '', mintId = '', retryCount = 0, entitlementType = '',
  paymentTransactionId, crossmintActionId, nextRetryAt,
}) {
  try {
    return await insert('nft_mints', {
      'Reference': reference,
      'Email': email,
      'NFT Type': nftType,
      'Tier Source': tierSource,
      'Mint Status': status,
      'Mint Date': sentDate,
      'Email Delivered': emailDelivered,
      'Notes': notes,
      'Token ID': mintId,
      'Retry Count': retryCount,
      'Entitlement Type': entitlementType,
      'Discord Synced': false,
      'Payment Transaction ID': paymentTransactionId ? String(paymentTransactionId) : undefined,
      'Crossmint Action ID': crossmintActionId ? String(crossmintActionId) : undefined,
      'Next Retry At': nextRetryAt || undefined,
    });
  } catch (err) {
    if (err.code === '23505') {
      if (/nft_mints_payment_txn_key/.test(err.message)) err.code = 'DUPLICATE_PAYMENT_MINT';
      else if (/nft_mints_reference_key/.test(err.message)) err.code = 'DUPLICATE_REFERENCE';
    }
    throw err;
  }
}

/** The mint row created for one payment (webhook redelivery / retry dedupe). */
export async function findMintByPaymentId(transactionId) {
  if (!transactionId) return null;
  return one('nft_mints', from('nft_mints').eq('payment_transaction_id', String(transactionId)), 'findMintByPaymentId');
}

/** The mint row for a Crossmint action (Crossmint webhook correlation). */
export async function findMintByActionId(actionId) {
  if (!actionId) return null;
  return one('nft_mints', from('nft_mints').eq('crossmint_action_id', String(actionId)), 'findMintByActionId');
}

/** Patch a mint row. A Reference / payment collision throws DUPLICATE_REFERENCE / DUPLICATE_PAYMENT_MINT. */
export async function updateNftMint(recordId, fields) {
  try {
    return await update('nft_mints', recordId, fields);
  } catch (err) {
    if (err.code === '23505') {
      if (/nft_mints_payment_txn_key/.test(err.message)) err.code = 'DUPLICATE_PAYMENT_MINT';
      else if (/nft_mints_reference_key/.test(err.message)) err.code = 'DUPLICATE_REFERENCE';
    }
    throw err;
  }
}

export async function findMintByTokenId(tokenId) {
  if (!tokenId) return null;
  return one('nft_mints', from('nft_mints').eq('token_id', tokenId), 'findMintByTokenId');
}

export async function findActiveMintByEmail(email) {
  return one('nft_mints',
    from('nft_mints').eq('email', normEmail(email)).in('mint_status', ACTIVE_MINT)
      .order('created_at', { ascending: false }),
    'findActiveMintByEmail');
}

/** Every active mint for an email (a member can hold several passes). */
export async function findActiveMintsByEmail(email, maxRecords = 10) {
  return many('nft_mints',
    from('nft_mints').eq('email', normEmail(email)).in('mint_status', ACTIVE_MINT)
      .order('created_at', { ascending: false }).limit(maxRecords),
    'findActiveMintsByEmail');
}

/** Active mint of one type — retry-mints uses it to avoid a second on-chain asset. */
export async function findActiveMintByEmailAndType(email, nftType) {
  return one('nft_mints',
    from('nft_mints').eq('email', normEmail(email)).eq('nft_type', nftType).in('mint_status', ACTIVE_MINT),
    'findActiveMintByEmailAndType');
}

/** Active mint of one type that has no Token ID yet (null or ''). */
export async function findActiveMintByEmailAndTypeWithoutToken(email, nftType) {
  return one('nft_mints',
    from('nft_mints').eq('email', normEmail(email)).eq('nft_type', nftType).in('mint_status', ACTIVE_MINT)
      .or('token_id.is.null,token_id.eq.').order('created_at', { ascending: false }),
    'findActiveMintByEmailAndTypeWithoutToken');
}

/**
 * Every active, token-less mint of one type (newest first). Webhook correlation
 * uses it to act only when exactly one candidate exists.
 */
export async function listActiveMintsByEmailAndTypeWithoutToken(email, nftType, maxRecords = 5) {
  return many('nft_mints',
    from('nft_mints').eq('email', normEmail(email)).eq('nft_type', nftType).in('mint_status', ACTIVE_MINT)
      .or('token_id.is.null,token_id.eq.').order('created_at', { ascending: false }).limit(maxRecords),
    'listActiveMintsByEmailAndTypeWithoutToken');
}

/** Any mint row (incl. Failed) for an email + type — orphan-payment recovery. */
export async function findAnyMintByEmailAndType(email, nftType) {
  return one('nft_mints',
    from('nft_mints').eq('email', normEmail(email)).eq('nft_type', nftType),
    'findAnyMintByEmailAndType');
}

/** Every mint row for an email, any status (customer portal). */
export async function listMintsByEmail(email, maxRecords = 100) {
  return many('nft_mints',
    from('nft_mints').eq('email', normEmail(email)).order('created_at', { ascending: false }).limit(maxRecords),
    'listMintsByEmail');
}

/**
 * Rows stuck in Sent: a Crossmint action id but no webhook outcome after
 * `olderThanMinutes`. Reconcile polls Crossmint for them, oldest first.
 */
export async function listStuckSentMints({ olderThanMinutes = 60, maxRecords = 20 } = {}) {
  return many('nft_mints',
    from('nft_mints').eq('mint_status', 'Sent').not('crossmint_action_id', 'is', null).neq('crossmint_action_id', '')
      .lt('updated_at', minutesAgo(olderThanMinutes)).order('updated_at', { ascending: true }).limit(maxRecords),
    'listStuckSentMints');
}

/** Minted/Sent but not yet Discord-synced. */
export async function listUnsynced({ maxRecords = 50 } = {}) {
  return many('nft_mints',
    from('nft_mints').in('mint_status', ['Minted', 'Sent']).eq('discord_synced', false).limit(maxRecords),
    'listUnsynced');
}

/** Minted/Sent, never Discord-synced, minted before `cutoffIso` (link reminders). */
export async function listUnlinkedMintsBefore(cutoffIso, { maxRecords = 50 } = {}) {
  return many('nft_mints',
    from('nft_mints').in('mint_status', ['Minted', 'Sent']).eq('discord_synced', false)
      .lt('mint_date', cutoffIso).limit(maxRecords),
    'listUnlinkedMintsBefore');
}

/**
 * Failed mints under the retry cap whose backoff is due (next_retry_at null or
 * <= now): never-scheduled rows first, then the longest-due, then oldest.
 */
export async function listFailedMints({ maxRecords = 10, maxRetries = 8, now = new Date() } = {}) {
  const due = new Date(now).toISOString();
  return many('nft_mints',
    from('nft_mints').eq('mint_status', 'Failed').lt('retry_count', maxRetries)
      .or(`next_retry_at.is.null,next_retry_at.lte.${due}`)
      .order('next_retry_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: true }).limit(maxRecords),
    'listFailedMints');
}

/**
 * Minted/Sent mints whose delivery email has not gone out, oldest first. Only
 * rows tied to a payment (the pipeline that tracks delivery), and with
 * `createdBefore` only rows older than it (a live run may still be sending).
 * Filtering here, not in the caller, keeps rows the caller can never send from
 * filling the window ahead of ones it can.
 */
export async function listUndeliveredMints({ maxRecords = 20, createdBefore } = {}) {
  let q = from('nft_mints').in('mint_status', ['Minted', 'Sent']).eq('email_delivered', false)
    .not('payment_transaction_id', 'is', null);
  if (createdBefore) q = q.lt('created_at', new Date(createdBefore).toISOString());
  return many('nft_mints', q.order('created_at', { ascending: true }).limit(maxRecords), 'listUndeliveredMints');
}

// ── Ops health counts ────────────────────────────────────────────────────────

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

async function count(query, what) {
  const res = await query;
  check(res, what);
  return res.count ?? 0;
}
const head = (table) => supabase().from(table).select('*', { count: 'exact', head: true });

/** Mints in `status` (any status if omitted) not touched for `olderThanMinutes` (if given). */
export async function countMints({ status, olderThanMinutes } = {}) {
  let q = head('nft_mints');
  if (status) q = q.eq('mint_status', status);
  if (olderThanMinutes !== undefined && olderThanMinutes !== null) q = q.lt('updated_at', minutesAgo(olderThanMinutes));
  return count(q, 'countMints');
}

/** Members queued for Discord role sync whose row has not changed for `hours`. */
export async function countPendingDiscordSyncOlderThan(hours) {
  return count(
    head('members').eq('discord_sync_status', 'pending').lt('updated_at', minutesAgo(hours * 60)),
    'countPendingDiscordSyncOlderThan');
}

/** Minted/Sent mints whose delivery email has not gone out. */
export async function countUndeliveredEmails() {
  return count(
    head('nft_mints').in('mint_status', ['Minted', 'Sent']).eq('email_delivered', false),
    'countUndeliveredEmails');
}

// ── Ops events ───────────────────────────────────────────────────────────────

/** Append a pipeline event (cron heartbeat, alert sent, …). */
export async function recordOpsEvent({ event, severity = 'info', dedupeKey, detail } = {}) {
  if (!event) throw new Error('recordOpsEvent: event is required');
  return insert('ops_events', {
    'Event': event,
    'Severity': severity,
    'Dedupe Key': dedupeKey || undefined,
    'Detail': detail ?? undefined,
  });
}

/** Newest ops event of a kind (optionally for one dedupe key), or null. */
export async function lastOpsEvent(event, { dedupeKey } = {}) {
  let q = from('ops_events').eq('event', event);
  if (dedupeKey) q = q.eq('dedupe_key', dedupeKey);
  return one('ops_events', q.order('created_at', { ascending: false }), 'lastOpsEvent');
}

// ── Payments ─────────────────────────────────────────────────────────────────

/**
 * Insert the Payments row. Transaction ID is UNIQUE, so this is the atomic
 * idempotency marker: a concurrent redelivery fails here with
 * err.code === 'DUPLICATE_PAYMENT' instead of double-processing.
 */
export async function createPayment({
  transactionId, method, tier, amount, customerEmail, customerName, status, token,
}) {
  try {
    return await insert('payments', {
      'Transaction ID': transactionId,
      'Payment Provider': method,
      'Pass Type': tier,
      'Amount': amount,
      'Customer Email': customerEmail,
      'Customer Name': customerName,
      'Status': status,
      'Token': token,
      'Payment Date': new Date().toISOString(),
    });
  } catch (err) {
    if (err.code === '23505') err.code = 'DUPLICATE_PAYMENT';
    throw err;
  }
}

export async function findPaymentByTransactionId(transactionId) {
  if (!transactionId) return null;
  return one('payments', from('payments').eq('transaction_id', String(transactionId)), 'findPaymentByTransactionId');
}

/**
 * Earliest Payments row recorded for a PayPal subscription, or null. PayPal
 * writes `Token` = `subscr:<subscr_id>` (Subscribe buttons, kind 'subscr') or
 * `rpp:<recurring_payment_id>` (recurring-payment profiles, kind 'rpp'). A hit
 * means the subscription's first payment is already recorded, so a later
 * payment is a renewal (no mint) — the webhook and the orphan sweep both rely
 * on "earliest row = the one payment that may mint".
 */
export async function findPaymentBySubscriptionId(subscrId, kind = 'subscr') {
  if (!subscrId) return null;
  if (kind !== 'subscr' && kind !== 'rpp') throw new Error(`findPaymentBySubscriptionId: unknown kind ${kind}`);
  return one('payments',
    from('payments').eq('token', `${kind}:${String(subscrId)}`).order('payment_date', { ascending: true }),
    'findPaymentBySubscriptionId');
}

/**
 * Set Payments.Status by transaction id (Stripe refund / dispute → 'Refunded' | 'Disputed').
 * Returns the updated record, or null when no row has that transaction id.
 */
export async function updatePaymentStatus(transactionId, status) {
  if (!transactionId) return null;
  const res = await supabase().from('payments').update(toRow('payments', { 'Status': status }))
    .eq('transaction_id', String(transactionId)).select();
  const rows = check(res, 'updatePaymentStatus') ?? [];
  return toRecord('payments', rows[0] ?? null);
}

/** Latest Payments row for an email + pass type (retry-mints reuses its id). */
export async function findLatestPaymentByEmailAndTier(email, tier) {
  return one('payments',
    from('payments').eq('customer_email', normEmail(email)).eq('pass_type', tier)
      .order('payment_date', { ascending: false }),
    'findLatestPaymentByEmailAndTier');
}

/** Which of `transactionIds` already have a Payments row (Stripe-side reconcile). */
export async function listPaymentTransactionIds(transactionIds) {
  const ids = [...new Set((transactionIds ?? []).filter(Boolean).map(String))];
  if (ids.length === 0) return new Set();
  const res = await supabase().from('payments').select('transaction_id').in('transaction_id', ids);
  return new Set((check(res, 'listPaymentTransactionIds') ?? []).map((r) => r.transaction_id));
}

/** Payments in the last `days` days (orphan-payment recovery). */
export async function listPaymentsSince(days = 3) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return many('payments', from('payments').gt('payment_date', cutoff).limit(200), 'listPaymentsSince');
}

/** Every payment for an email (customer portal). */
export async function listPaymentsByEmail(email, maxRecords = 100) {
  return many('payments',
    from('payments').eq('customer_email', normEmail(email)).order('payment_date', { ascending: false }).limit(maxRecords),
    'listPaymentsByEmail');
}

// ── Members ──────────────────────────────────────────────────────────────────

/** Create or patch the member row for an email (atomic: ON CONFLICT (email)). */
export async function upsertMemberByEmail(email, fields) {
  const { Email: _ignored, ...rest } = fields ?? {};
  return upsertByEmail('members', email, rest);
}

export async function findMemberByEmail(email) {
  return one('members', from('members').eq('email', normEmail(email)), 'findMemberByEmail');
}

/** Store the Discord link and queue the member for role sync. */
export async function upsertDiscordLink(email, { discordId, discordUsername } = {}) {
  return upsertMemberByEmail(email, {
    'Discord ID': discordId,
    'Discord Username': discordUsername ?? '',
    'Discord Linked At': new Date().toISOString(),
    'Discord Sync Status': 'pending',
  });
}

/** Single-use bookkeeping for Discord access-token nonces (stores the last one). */
export async function isDiscordAuthNonceUsed(email, nonce) {
  if (!nonce) return false;
  const member = await findMemberByEmail(email);
  return member?.fields?.['Discord Auth Nonce Used'] === nonce;
}

export async function markDiscordAuthNonceUsed(email, nonce) {
  if (!nonce) return null;
  return upsertMemberByEmail(email, { 'Discord Auth Nonce Used': nonce });
}

/**
 * @param {{ error?: string, attempts?: number }} [opts] `attempts` writes
 *   Discord Sync Attempts (reconcile's consecutive-failure count) — only
 *   reconcile passes it.
 */
export async function updateDiscordSyncStatus(email, status, { error = '', attempts } = {}) {
  const fields = { 'Discord Sync Status': status, 'Discord Sync At': new Date().toISOString() };
  if (error) fields['Discord Sync Error'] = error;
  if (attempts !== undefined) fields['Discord Sync Attempts'] = attempts;
  return upsertMemberByEmail(email, fields);
}

/** Linked members queued for a role sync, least recently touched first. */
export async function listPendingDiscordSync({ maxRecords = 50 } = {}) {
  return many('members',
    from('members').eq('discord_sync_status', 'pending').not('discord_id', 'is', null)
      .order('updated_at', { ascending: true }).limit(maxRecords),
    'listPendingDiscordSync');
}

/**
 * Linked members whose last role sync failed more than `olderThanHours` ago and
 * who have not used up `maxAttempts` consecutive attempts, oldest first.
 */
export async function listFailedDiscordSync({ olderThanHours = 6, maxAttempts = 3, maxRecords = 20 } = {}) {
  return many('members',
    from('members').eq('discord_sync_status', 'failed').not('discord_id', 'is', null)
      .lt('discord_sync_at', minutesAgo(olderThanHours * 60)).lt('discord_sync_attempts', maxAttempts)
      .order('discord_sync_at', { ascending: true }).limit(maxRecords),
    'listFailedDiscordSync');
}

/** Recurring-membership state read by the nightly revocation backstop. */
export async function updateEntitlementState(email, { entitlementType, status, expiresAt, billingState } = {}) {
  const fields = {};
  if (entitlementType !== undefined) fields['Entitlement Type'] = entitlementType;
  if (status !== undefined) fields['Entitlement Status'] = status;
  if (expiresAt !== undefined) fields['Entitlement Expires At'] = expiresAt;
  if (billingState !== undefined) fields['Billing State'] = billingState;
  if (Object.keys(fields).length === 0) return null;
  return upsertMemberByEmail(email, fields);
}

/** Active monthly members whose entitlement ended more than `graceDays` ago. */
export async function listOutOfSyncEntitlements({ graceDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - graceDays * 86_400_000).toISOString();
  return many('members',
    from('members').eq('entitlement_type', 'monthly_membership').eq('entitlement_status', 'active')
      .lt('entitlement_expires_at', cutoff).limit(100),
    'listOutOfSyncEntitlements');
}

/**
 * Monthly members whose billing is not active but who have no Entitlement
 * Expires At (cancelled before any invoice stamped one). Reconcile judges their
 * grace window from Discord Sync At ?? Join Date. Already-revoked rows are left
 * out so the nightly pass does not revoke them again.
 */
export async function listLapsedMonthlyWithoutExpiry({ maxRecords = 100 } = {}) {
  return many('members',
    from('members').eq('entitlement_type', 'monthly_membership').neq('billing_state', 'active')
      .is('entitlement_expires_at', null)
      .or('discord_sync_status.is.null,discord_sync_status.neq.revoked')
      .limit(maxRecords),
    'listLapsedMonthlyWithoutExpiry');
}

// ── Customer portal auth ─────────────────────────────────────────────────────

export async function findCustomerAuth(email) {
  return one('customer_auth', from('customer_auth').eq('email', normEmail(email)), 'findCustomerAuth');
}

export async function upsertCustomerAuth(email, fields) {
  const { Email: _ignored, ...rest } = fields ?? {};
  return upsertByEmail('customer_auth', email, rest);
}

export async function updateCustomerAuth(recordId, fields) {
  return update('customer_auth', recordId, fields);
}

// ── Leads ────────────────────────────────────────────────────────────────────

/** Insert a lead. `fields` uses the display names in FIELDS.leads. */
export async function createLead(fields) {
  return insert('leads', fields);
}

/** Leads written for one payment (session / txn id) since `sinceIso`. */
export async function listLeadsByPaymentToken(token, sinceIso, { maxRecords = 50 } = {}) {
  if (!token) return [];
  return many('leads',
    from('leads').eq('payment_token', token).gt('created_at', sinceIso).limit(maxRecords),
    'listLeadsByPaymentToken');
}

/** Newest-first rows of a table, for the owner consoles (api/admin/data.js). */
export async function listRecent(table, { limit = 200, offset = 0 } = {}) {
  if (!FIELDS[table]) throw new Error(`Unknown table ${table}`);
  return many(table,
    from(table).order('created_at', { ascending: false }).order('id').range(offset, offset + limit - 1),
    `listRecent ${table}`);
}

/** Patch a row by id, for the owner consoles. */
export async function updateRecord(table, id, fields) {
  if (!FIELDS[table]) throw new Error(`Unknown table ${table}`);
  return update(table, id, fields);
}
