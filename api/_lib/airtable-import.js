/**
 * One-way bridge: copy any rows still in Airtable into Supabase.
 *
 * Runs at the start of the nightly reconcile while AIRTABLE_PAT and
 * AIRTABLE_BASE_ID are still set. Idempotent: rows already in Supabase are
 * never overwritten (members/customer_auth match on email, payments on
 * Transaction ID, mints/leads on the Airtable record id). Delete the AIRTABLE_*
 * env vars once a run reports nothing new and the bridge switches itself off.
 */

import { FIELDS, toRow, supabase } from './db.js';

const TABLES = [
  { table: 'members',       env: 'AIRTABLE_TABLE_MEMBERS',       def: 'tblYPn7hxnrgH723B', conflict: 'email' },
  { table: 'payments',      env: 'AIRTABLE_TABLE_PAYMENTS',      def: 'tbl6KlhM9fIH19W5i', conflict: 'transaction_id' },
  { table: 'nft_mints',     env: 'AIRTABLE_TABLE_NFT_MINTS',     def: 'tbliXEGJdoEIAJU06', conflict: 'airtable_id' },
  { table: 'customer_auth', env: 'AIRTABLE_TABLE_CUSTOMER_AUTH', def: 'tblbCS7TL65FcOiWn', conflict: 'email' },
  { table: 'leads',         env: 'AIRTABLE_TABLE_LEADS',         def: 'tblDuezyOsxy7sNES', conflict: 'airtable_id' },
];

export function airtableImportEnabled() {
  return Boolean((process.env.AIRTABLE_PAT ?? process.env.AIRTABLE_API_KEY) && process.env.AIRTABLE_BASE_ID);
}

async function listAll(tableId) {
  const pat = process.env.AIRTABLE_PAT ?? process.env.AIRTABLE_API_KEY;
  const out = [];
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
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

/** Keep only fields the schema knows; Airtable-only columns are dropped. */
export function mapAirtableRecord(table, rec) {
  const known = {};
  for (const [name, value] of Object.entries(rec.fields ?? {})) {
    if (FIELDS[table][name] !== undefined) known[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const row = toRow(table, known);
  row.airtable_id = rec.id;
  if (rec.createdTime) row.created_at = rec.createdTime;
  return row;
}

/** Returns { table: { read, written } | { error } } for every table. */
export async function importFromAirtable() {
  const report = {};
  for (const { table, env, def, conflict } of TABLES) {
    try {
      const recs = await listAll(process.env[env] ?? def);
      const rows = recs.map((r) => mapAirtableRecord(table, r)).filter((r) => {
        if (table === 'members' || table === 'customer_auth' || table === 'nft_mints') return Boolean(r.email);
        if (table === 'payments') return Boolean(r.transaction_id);
        return true;
      });
      let written = 0;
      if (rows.length) {
        const { data, error } = await supabase().from(table)
          .upsert(rows, { onConflict: conflict, ignoreDuplicates: true }).select('id');
        if (error) throw new Error(error.message);
        written = data?.length ?? 0;
      }
      report[table] = { read: recs.length, written };
    } catch (err) {
      report[table] = { error: err.message };
    }
  }
  return report;
}
