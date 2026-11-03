/**
 * One-way bridge: copy any rows still in Airtable into Supabase.
 *
 * Runs at the start of the nightly reconcile while AIRTABLE_PAT and
 * AIRTABLE_BASE_ID are still set (run it on demand with "Run" on the reconcile
 * cron in Vercel). Idempotent: rows already in Supabase are never overwritten
 * (members/customer_auth match on email, payments on Transaction ID,
 * mints/leads on the Airtable record id). Remove the AIRTABLE_* env vars once a
 * run reports nothing new; the bridge then switches itself off.
 */

import { FIELDS, toRow, supabase } from './db.js';

const TABLES = [
  { table: 'members',       env: 'AIRTABLE_TABLE_MEMBERS',       def: 'tblYPn7hxnrgH723B', conflict: 'email' },
  { table: 'payments',      env: 'AIRTABLE_TABLE_PAYMENTS',      def: 'tbl6KlhM9fIH19W5i', conflict: 'transaction_id' },
  { table: 'nft_mints',     env: 'AIRTABLE_TABLE_NFT_MINTS',     def: 'tbliXEGJdoEIAJU06', conflict: 'airtable_id' },
  { table: 'customer_auth', env: 'AIRTABLE_TABLE_CUSTOMER_AUTH', def: 'tblbCS7TL65FcOiWn', conflict: 'email' },
  // The CRM's lead pipeline lived in this table of the Operations base.
  { table: 'leads',         env: 'AIRTABLE_TABLE_LEADS',         def: 'tbllVIcSRXdZwofbs', conflict: 'airtable_id' },
];

// Column types the migration declares, for coercing Airtable values.
const BOOLEAN = new Set(['active', 'email_delivered', 'discord_synced', 'session_active']);
const INTEGER = new Set(['retry_count']);
const NUMERIC = new Set(['amount', 'purchase_price']);
const TIMESTAMP = new Set([
  'join_date', 'discord_linked_at', 'discord_sync_at', 'entitlement_expires_at', 'payment_date',
  'mint_date', 'discord_synced_at', 'token_expires', 'last_login',
]);
// NOT NULL columns with defaults: Airtable omits empty fields, so fill them.
const DEFAULTS = {
  nft_mints: { email_delivered: false, discord_synced: false, retry_count: 0 },
  customer_auth: { session_active: false },
  payments: { deliverable_status: 'Not Started' },
  leads: { status: 'New' },
};

export function airtableImportEnabled() {
  return Boolean((process.env.AIRTABLE_PAT || process.env.AIRTABLE_API_KEY) && process.env.AIRTABLE_BASE_ID);
}

async function listAll(tableId, formula) {
  const pat = process.env.AIRTABLE_PAT || process.env.AIRTABLE_API_KEY;
  const out = [];
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (formula) params.set('filterByFormula', formula);
    if (offset) params.set('offset', offset);
    const res = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${tableId}?${params}`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!res.ok) throw new Error(`Airtable ${tableId} (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    out.push(...(data.records ?? []));
    offset = data.offset ?? null;
  } while (offset);
  return out;
}

function coerce(col, v) {
  if (v === null || v === undefined || v === '') return null;
  if (BOOLEAN.has(col)) return v === true || v === 'true' || v === 1;
  if (INTEGER.has(col)) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  if (NUMERIC.has(col)) {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (TIMESTAMP.has(col)) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  return typeof v === 'string' ? v : String(v);
}

/** Keep only fields the schema knows, coerced to the column type; Airtable-only columns are dropped. */
export function mapAirtableRecord(table, rec) {
  const known = {};
  for (const [name, value] of Object.entries(rec.fields ?? {})) {
    if (FIELDS[table][name] !== undefined) known[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const raw = toRow(table, known);
  const row = { ...(DEFAULTS[table] ?? {}) };
  for (const [col, v] of Object.entries(raw)) {
    const c = coerce(col, v);
    if (c !== null) row[col] = c;
  }
  row.airtable_id = rec.id;
  if (rec.createdTime) row.created_at = rec.createdTime;
  return row;
}

async function upsert(table, rows, conflict) {
  const { data, error } = await supabase().from(table)
    .upsert(rows, { onConflict: conflict, ignoreDuplicates: true, defaultToNull: false }).select('id');
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

/**
 * Returns { table: { read, written, failed?, errors? } | { error } } for every table.
 * A batch that fails is retried row by row so one bad row can't block the rest.
 */
export async function importFromAirtable() {
  const report = {};
  for (const { table, env, def, conflict } of TABLES) {
    try {
      const recs = await listAll(process.env[env] || def);
      const rows = recs.map((r) => mapAirtableRecord(table, r)).filter((r) => {
        if (table === 'members' || table === 'customer_auth' || table === 'nft_mints') return Boolean(r.email);
        if (table === 'payments') return Boolean(r.transaction_id);
        return true;
      });
      const entry = { read: recs.length, written: 0 };
      if (rows.length) {
        try {
          entry.written = await upsert(table, rows, conflict);
        } catch {
          entry.failed = 0;
          entry.errors = [];
          for (const row of rows) {
            try { entry.written += await upsert(table, [row], conflict); } catch (e) {
              entry.failed += 1;
              if (entry.errors.length < 5) entry.errors.push(`${row.airtable_id}: ${e.message}`);
            }
          }
        }
      }
      report[table] = entry;
    } catch (err) {
      report[table] = { error: err.message };
    }
  }
  return report;
}

/** True when any table errored or had rows that would not import. */
export function importHasProblems(report) {
  return Object.values(report ?? {}).some((r) => r?.error || r?.failed);
}

/** Mints in Airtable whose Reference starts with `${prefix}_` (keeps serials unique until import). */
export async function countAirtableMintsByPrefix(prefix) {
  const tableId = process.env.AIRTABLE_TABLE_NFT_MINTS || 'tbliXEGJdoEIAJU06';
  const safe = String(prefix).replace(/[^A-Z0-9]/gi, '');
  const recs = await listAll(tableId, `FIND("${safe}_",{Reference})=1`);
  return recs.length;
}
