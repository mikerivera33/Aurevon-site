/**
 * POST /api/intake/submit
 *
 * Records an Aurevon Capital deal-intake submission as a Leads row. The page
 * still posts the same form to Formspree (owner email + attachments); this is
 * the database copy the CRM reads.
 *
 * Same payment gate as /api/intake/verify: the Stripe session / PayPal txn id
 * is re-verified here, so a lead can't be written without a paid underwriting
 * purchase.
 *
 * Body (JSON): { sessionId | txnId, full_name, email, phone, company,
 *   tier | plan | package, property_address, purchase_price, asset_type,
 *   hold_period, deal_summary, addons[], promo_code }  →  { ok: true }
 */

import { verifyIntakePayment } from '../_lib/intake-verify.js';
import { createLead, listLeadsByPaymentToken } from '../_lib/db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One payment can cover several deals (BOGO, retainers), but not unlimited ones.
const MAX_LEADS_PER_PAYMENT_PER_DAY = 20;
const DAY_MS = 86_400_000;

/** Trimmed string capped at `max` chars; non-strings become ''. */
export function clean(value, max = 200) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // Postgres text rejects NUL bytes.
  return String(value).split('\u0000').join('').trim().slice(0, max);
}

/** "$1,250,000" → 1250000; anything not a finite non-negative number → null. */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const s = clean(value, 40).replace(/[$,\s]/g, '');
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n <= 1e12 ? n : null;
}

function cleanAddons(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
  return list.map((a) => clean(a, 80)).filter(Boolean).slice(0, 12).join(', ');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  let paid;
  try {
    paid = await verifyIntakePayment({
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      txnId: typeof body.txnId === 'string' ? body.txnId : undefined,
    });
  } catch (err) {
    console.error(`[intake-submit] verify: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'submit_failed' });
  }
  if (!paid.ok) {
    return res.status(paid.status || 403).json({ ok: false, error: 'payment_not_verified' });
  }

  const name = clean(body.full_name, 120);
  const email = clean(body.email, 254).toLowerCase();
  if (!name || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_input' });
  }

  const paymentToken = clean(body.sessionId, 255) || clean(body.txnId, 64);
  // The verified tier from Stripe / Payments wins over what the page sent.
  const tier = clean(paid.tier, 60) || clean(body.tier, 60) || clean(body.plan, 60) || clean(body.package, 60);

  const propertyAddress = clean(body.property_address, 300);
  try {
    const recent = await listLeadsByPaymentToken(paymentToken, new Date(Date.now() - DAY_MS).toISOString());
    // Same deal sent twice (double click, retry): already saved.
    const same = (a) => String(a ?? '').trim().toLowerCase() === propertyAddress.toLowerCase();
    if (recent.some((r) => same(r.fields?.['Property Address']) && r.fields?.['Email'] === email)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (recent.length >= MAX_LEADS_PER_PAYMENT_PER_DAY) {
      return res.status(429).json({ ok: false, error: 'too_many_submissions' });
    }
  } catch (err) {
    console.error(`[intake-submit] duplicate check: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'submit_failed' });
  }

  try {
    await createLead({
      'Name': name,
      'Email': email,
      'Phone': clean(body.phone, 40),
      'Company': clean(body.company, 160),
      'Tier': tier,
      'Source': 'Deal intake',
      'Status': 'New',
      'Property Address': propertyAddress,
      'Purchase Price': parsePrice(body.purchase_price),
      'Asset Type': clean(body.asset_type, 60),
      'Hold Period': clean(body.hold_period, 60),
      'Deal Summary': clean(body.deal_summary, 5000),
      'Add-ons': cleanAddons(body.addons),
      'Promo Code': clean(body.promo_code, 40).toUpperCase(),
      'Payment Token': paymentToken,
    });
  } catch (err) {
    console.error(`[intake-submit] createLead: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'submit_failed' });
  }

  return res.status(200).json({ ok: true });
}
