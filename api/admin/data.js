/**
 * Owner console data — /api/admin/data
 *
 *   GET   ?table=leads|payments|nft_mints|members[&limit=200]  → { records: [{ id, fields }] }
 *   PATCH ?table=leads&id=<uuid>  body { fields: { Status, Notes, Analyst } } → { record }
 *
 * Used by aurevon-crm.html and operator.html. Auth: `Authorization: Bearer
 * <ADMIN_SECRET>` (fails closed when ADMIN_SECRET is unset). Records use the
 * same display-name field shape as api/_lib/db.js.
 */

import crypto from 'node:crypto';
import { listRecent, updateRecord } from '../_lib/db.js';

const READABLE = new Set(['leads', 'payments', 'nft_mints', 'members']);
// Owners triage leads in the CRM; everything else is written by the pipeline.
const WRITABLE = { leads: new Set(['Status', 'Notes', 'Analyst']) };

function authorized(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const raw = req.headers?.authorization ?? '';
  const provided = Buffer.from(raw.startsWith('Bearer ') ? raw.slice(7) : '');
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(provided, expected); } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const table = String(req.query?.table ?? '');
  if (!READABLE.has(table)) return res.status(400).json({ error: 'unknown_table' });

  try {
    if (req.method === 'GET') {
      const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 1000);
      return res.status(200).json({ records: await listRecent(table, { limit }) });
    }

    if (req.method === 'PATCH') {
      const allowed = WRITABLE[table];
      const id = String(req.query?.id ?? '');
      const fields = req.body?.fields ?? {};
      if (!allowed || !id) return res.status(400).json({ error: 'not_writable' });
      const bad = Object.keys(fields).filter((k) => !allowed.has(k));
      if (bad.length) return res.status(400).json({ error: 'field_not_writable', fields: bad });
      return res.status(200).json({ record: await updateRecord(table, id, fields) });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error(`[admin/data] ${req.method} ${table}: ${err.message}`);
    return res.status(500).json({ error: 'database_error' });
  }
}
