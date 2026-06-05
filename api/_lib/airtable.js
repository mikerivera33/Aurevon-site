/**
 * Airtable REST API client — Aurevon Operations base
 *
 * Base: appI9X8vcRcK1QZ1l  (Aurevon Operations)
 *
 * Table IDs (set via AIRTABLE_TABLE_* env vars or defaults below):
 *   CustomerAuth  → tblbCS7TL65FcOiWn
 *   Payments      → tbl6KlhM9fIH19W5i
 *   NFT_Mints     → tbliXEGJdoEIAJU06
 *   Members       → tblYPn7hxnrgH723B
 *   Leads         → tblDuezyOsxy7sNES  (lead captures)
 *
 * Field names follow the Airtable UI names (spaces allowed, used in filter formulas).
 * Airtable API accepts the exact display name.
 */

const BASE_URL = 'https://api.airtable.com/v0';

// ── Table ID registry ─────────────────────────────────────────────────────────
const TABLE = {
  CustomerAuth: process.env.AIRTABLE_TABLE_CUSTOMER_AUTH ?? 'tblbCS7TL65FcOiWn',
  Payments:     process.env.AIRTABLE_TABLE_PAYMENTS       ?? 'tbl6KlhM9fIH19W5i',
  NFT_Mints:    process.env.AIRTABLE_TABLE_NFT_MINTS      ?? 'tbliXEGJdoEIAJU06',
  Members:      process.env.AIRTABLE_TABLE_MEMBERS        ?? 'tblYPn7hxnrgH723B',
  Leads:        process.env.AIRTABLE_TABLE_LEADS          ?? 'tblDuezyOsxy7sNES',
};

function getBase() {
  return process.env.AIRTABLE_BASE_ID ?? 'appI9X8vcRcK1QZ1l';
}

function getHeaders() {
  const pat = process.env.AIRTABLE_PAT ?? process.env.AIRTABLE_API_KEY;
  if (!pat) throw new Error('Missing AIRTABLE_PAT env var');
  return { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' };
}

// ── Core primitives ───────────────────────────────────────────────────────────

async function createRecord(tableId, fields) {
  const url = `${BASE_URL}/${getBase()}/${tableId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Airtable createRecord [${tableId}] (${res.status}): ${txt}`);
  }
  return res.json();
}

async function updateRecord(tableId, recordId, fields) {
  const url = `${BASE_URL}/${getBase()}/${tableId}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Airtable updateRecord [${tableId}/${recordId}] (${res.status}): ${txt}`);
  }
  return res.json();
}

/**
 * List records with optional filter + field projection.
 * Paginates automatically when maxRecords is large enough to trigger it.
 */
async function listRecords(tableId, { filterFormula, fields = [], maxRecords = 100 } = {}) {
  const params = new URLSearchParams({ maxRecords: String(maxRecords) });
  if (filterFormula) params.set('filterByFormula', filterFormula);
  for (const f of fields) params.append('fields[]', f);

  const url = `${BASE_URL}/${getBase()}/${tableId}?${params}`;
  const res = await fetch(url, { headers: getHeaders() });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Airtable listRecords [${tableId}] (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return data.records ?? [];
}

async function upsertRecord(tableId, filterFormula, fields) {
  const existing = await listRecords(tableId, { filterFormula, maxRecords: 1 });
  if (existing.length > 0) {
    return updateRecord(tableId, existing[0].id, fields);
  }
  return createRecord(tableId, fields);
}

// ── NFT_Mints ─────────────────────────────────────────────────────────────────
// Field names match the Airtable UI in the Aurevon Operations base.
// If your Airtable field names differ, adjust the strings below.

/**
 * Count mints whose Reference starts with `prefix_`.
 * Used to determine next serial number.
 */
export async function countNftMintsByPrefix(prefix) {
  const filter = `FIND("${prefix}_",{Reference})=1`;
  const params = new URLSearchParams({
    filterByFormula: filter,
    'fields[]': 'Reference',
    maxRecords: '10000',
  });

  let all = [];
  let offset = null;
  do {
    if (offset) params.set('offset', offset);
    const url = `${BASE_URL}/${getBase()}/${TABLE.NFT_Mints}?${params}`;
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) { const t = await res.text(); throw new Error(`countNftMintsByPrefix (${res.status}): ${t}`); }
    const data = await res.json();
    all = all.concat(data.records ?? []);
    offset = data.offset ?? null;
  } while (offset);

  return all.length;
}

/**
 * Create a new NFT_Mints record.
 *
 * Maps our internal names → Airtable field names.
 * Airtable field names in the Operations base (portal/data.js evidence):
 *   Email, NFT Type, Token ID, Mint Status, Mint Date,
 *   Transaction Hash, Discord Role Assigned, Reference,
 *   Tier Source, Email Delivered, Notes, Retry Count
 */
export async function createNftMint({
  reference,
  email,
  nftType,
  tierSource,
  status,
  sentDate,
  emailDelivered = false,
  notes = '',
  mintId = '',
  retryCount = 0,
  entitlementType = '',
}) {
  return createRecord(TABLE.NFT_Mints, {
    'Reference':           reference,
    'Email':               email,
    'NFT Type':            nftType,
    'Tier Source':         tierSource,
    'Mint Status':         status,
    'Mint Date':           sentDate,
    'Email Delivered':     emailDelivered,
    'Notes':               notes,
    'Token ID':            mintId,
    'Retry Count':         retryCount,
    'Entitlement Type':    entitlementType,
    'Discord Synced':      false,
  });
}

/**
 * Update fields on an NFT_Mints record.
 */
export async function updateNftMint(recordId, fields) {
  return updateRecord(TABLE.NFT_Mints, recordId, fields);
}

/**
 * List NFT_Mints rows matching a filter.
 */
export async function listNftMints(filterFormula, { maxRecords = 100 } = {}) {
  return listRecords(TABLE.NFT_Mints, { filterFormula, maxRecords });
}

/**
 * Find the most recent active mint for an email address.
 * Returns null if none found.
 */
export async function findActiveMintByEmail(email) {
  const formula = `AND(LOWER({Email})="${email.toLowerCase()}",OR({Mint Status}="Minted",{Mint Status}="Sent",{Mint Status}="Queued"))`;
  const recs = await listRecords(TABLE.NFT_Mints, { filterFormula: formula, maxRecords: 1 });
  return recs[0] ?? null;
}

/**
 * Find mints that succeeded but haven't been Discord-synced yet.
 */
export async function listUnsynced({ maxRecords = 50 } = {}) {
  const formula = `AND(OR({Mint Status}="Minted",{Mint Status}="Sent"),{Discord Synced}=FALSE())`;
  return listRecords(TABLE.NFT_Mints, { filterFormula: formula, maxRecords });
}

/**
 * Find NFT_Mints rows where the mint failed and can be retried.
 */
export async function listFailedMints({ maxRecords = 50 } = {}) {
  const formula = `{Mint Status}="Failed"`;
  return listRecords(TABLE.NFT_Mints, { filterFormula: formula, maxRecords });
}

// ── Payments ──────────────────────────────────────────────────────────────────

/**
 * Create a Payments record.
 * Field names match the Aurevon Operations Payments table.
 */
export async function createPayment({
  transactionId,
  method,
  tier,
  amount,
  customerEmail,
  customerName,
  status,
  token,
}) {
  return createRecord(TABLE.Payments, {
    'Transaction ID':    transactionId,
    'Payment Provider':  method,
    'Pass Type':         tier,
    'Amount':            amount,
    'Customer Email':    customerEmail,
    'Customer Name':     customerName,
    'Status':            status,
    'Token':             token,
    'Payment Date':      new Date().toISOString(),
  });
}

/**
 * Find a Payments row by its Transaction ID (Stripe session id / PayPal txn_id).
 * Used as the idempotency marker so webhook redelivery cannot double-process.
 * Returns the record, or null if none exists.
 */
export async function findPaymentByTransactionId(transactionId) {
  const formula = `{Transaction ID}="${transactionId}"`;
  const recs = await listRecords(TABLE.Payments, { filterFormula: formula, maxRecords: 1 });
  return recs[0] ?? null;
}

// ── Members ───────────────────────────────────────────────────────────────────

/**
 * Upsert a member record by email.
 * Creates a new member if one doesn't exist; patches fields if it does.
 *
 * Requires these fields to exist in the Members Airtable table:
 *   Email, Customer Name, Join Date, Active, Member Tier,
 *   Discord Username, Discord ID, Discord Linked At, Wallet Address,
 *   Entitlement Type, Discord Sync Status, Discord Sync At
 */
export async function upsertMemberByEmail(email, fields) {
  const normalized = email.toLowerCase().trim();
  const formula = `LOWER({Email})="${normalized}"`;
  return upsertRecord(TABLE.Members, formula, { 'Email': normalized, ...fields });
}

/**
 * Find a member record by email. Returns null if not found.
 */
export async function findMemberByEmail(email) {
  const formula = `LOWER({Email})="${email.toLowerCase().trim()}"`;
  const recs = await listRecords(TABLE.Members, { filterFormula: formula, maxRecords: 1 });
  return recs[0] ?? null;
}

/**
 * Update Discord link information on a member record.
 * Also sets Discord Sync Status to 'pending' so the reconcile job picks it up.
 */
export async function upsertDiscordLink(email, { discordId, discordUsername }) {
  return upsertMemberByEmail(email, {
    'Discord ID':          discordId,
    'Discord Username':    discordUsername ?? '',
    'Discord Linked At':   new Date().toISOString(),
    'Discord Sync Status': 'pending',
  });
}

/**
 * Mark a member's Discord sync as succeeded or failed.
 */
export async function updateDiscordSyncStatus(email, status, { error = '' } = {}) {
  const fields = {
    'Discord Sync Status': status,
    'Discord Sync At':     new Date().toISOString(),
  };
  if (error) fields['Discord Sync Error'] = error;
  return upsertMemberByEmail(email, fields);
}

/**
 * List members where Discord sync is pending (waiting for role assignment).
 */
export async function listPendingDiscordSync({ maxRecords = 50 } = {}) {
  const formula = `{Discord Sync Status}="pending"`;
  return listRecords(TABLE.Members, { filterFormula: formula, maxRecords });
}

/**
 * List monthly members whose entitlement should be revoked (expired + past grace period).
 * Checks for `Entitlement Expires At` field being in the past beyond the grace period.
 */
export async function listOutOfSyncEntitlements({ graceDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - graceDays * 86_400_000).toISOString().split('T')[0];
  const formula = `AND({Entitlement Type}="monthly_membership",{Entitlement Status}="active",IS_BEFORE({Entitlement Expires At},"${cutoff}"))`;
  return listRecords(TABLE.Members, { filterFormula: formula, maxRecords: 100 });
}

// ── Leads ─────────────────────────────────────────────────────────────────────

export async function createLead({ name, email, tier = '', source = 'Stripe' }) {
  return createRecord(TABLE.Leads, {
    'Name':        name,
    'Email':       email,
    'Tier':        tier,
    'Source':      source,
    'Created At':  new Date().toISOString(),
  });
}
