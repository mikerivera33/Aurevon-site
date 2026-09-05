/**
 * Intake paywall — /api/intake?action=grant|submit
 *
 * Hard paywall for the Aurevon Capital (RE) deal-intake form. The previous gate
 * was a client-generated `paid_*` token (forgeable); this enforces a real
 * payment server-side.
 *
 * POST ?action=grant
 *   body: { session_id }      (Stripe — verified live via the API, no webhook race)
 *      OR { email, tier }     (PayPal / fallback — confirmed against a Succeeded
 *                              Payments record for that email+tier)
 *   → 200 { ok:true, grant, tier }   HMAC-signed { tier, ref, exp }
 *   → 200 { ok:false, pending:true } payment not yet recorded (IPN delay) — client retries
 *   → 402 { ok:false }               no qualifying payment
 *
 * POST ?action=submit
 *   body: { grant, ...formFields }
 *   → verifies the grant HMAC + expiry, then forwards the submission to Formspree.
 *     Missing/invalid/expired grant → 401. This endpoint is the actual gate:
 *     the form posts here instead of straight to Formspree, so a forged client
 *     token can no longer submit a deal.
 *
 * Fails CLOSED: if the signing secret is unset the endpoint errors explicitly
 * (500) rather than silently accepting. Reuses STATE_SECRET (same secret the
 * Discord OAuth state HMAC uses) so there's no new env knob to set.
 */

import Stripe from 'stripe';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { findSucceededPaymentsByEmail } from './_lib/airtable.js';

const DOMAIN = process.env.DOMAIN ?? 'https://www.aurevonvc.com';
const GRANT_TTL_MS = 60 * 60 * 1000; // 1 hour to fill out the form after paying

// RE intake tiers (Stripe `re_*` + PayPal bare keys). A grant is only issued
// when the confirmed payment is one of these.
const INTAKE_TIERS = new Set([
  're_bogo', 're_single', 're_full', 're_retainer', 're_enterprise',
  'bogo', 'single', 'full', 'retainer', 'enterprise',
]);

// Read secrets at call time (not module load) so the env can be set in tests.
function grantSecret() {
  return process.env.INTAKE_SECRET ?? process.env.STATE_SECRET ?? '';
}
function formspreeUrl() {
  return process.env.FORMSPREE_INTAKE_URL ?? 'https://formspree.io/f/xykokyqe';
}

function normalizeTier(t) {
  return String(t ?? '').replace(/^re_/, '');
}

export function signGrant(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', grantSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyGrant(grant) {
  if (typeof grant !== 'string' || !grant.includes('.')) throw new Error('Malformed grant');
  const dot = grant.lastIndexOf('.');
  const body = grant.slice(0, dot);
  const received = grant.slice(dot + 1);
  const expected = createHmac('sha256', grantSecret()).update(body).digest('base64url');
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Grant HMAC mismatch');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || Date.now() > payload.exp) throw new Error('Grant expired');
  return payload;
}

// ── Body helpers ────────────────────────────────────────────────────────────
// bodyParser is disabled for this file (see config export) so the `submit` action
// can stream the raw multipart upload through to Formspree unparsed. That means
// `grant` must read+parse its own JSON body.

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  // Honor a pre-parsed body (dev-server / tests) before touching the stream.
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
  const buf = await readRawBody(req);
  if (!buf || !buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

// ── action=grant ──────────────────────────────────────────────────────────────

async function handleGrant(req, res) {
  if (!grantSecret()) return res.status(500).json({ error: 'Paywall not configured (signing secret unset)' });
  const { session_id, email, tier } = await readJsonBody(req);

  // Stripe path — verify the checkout session live (avoids the webhook race).
  if (session_id) {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
      const session = await stripe.checkout.sessions.retrieve(String(session_id));
      const paid = session?.payment_status === 'paid' || session?.status === 'complete';
      const sTier = session?.metadata?.tier;
      if (!paid || !sTier || !INTAKE_TIERS.has(sTier)) {
        return res.status(402).json({ ok: false, error: 'Payment not confirmed for an intake tier' });
      }
      const grant = signGrant({ tier: sTier, ref: `stripe:${session.id}`, exp: Date.now() + GRANT_TTL_MS });
      return res.status(200).json({ ok: true, grant, tier: sTier });
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'Could not verify Stripe session', detail: err.message });
    }
  }

  // Email + tier path (PayPal hosted links / fallback) — confirm a Succeeded
  // Payments record. The IPN is async, so a miss returns pending (client retries).
  if (email && tier) {
    if (!INTAKE_TIERS.has(tier)) return res.status(400).json({ error: 'Not an intake tier' });
    try {
      const rows = await findSucceededPaymentsByEmail(email, { sinceDays: 7 });
      const want = normalizeTier(tier);
      const match = rows.find((r) => normalizeTier(r.fields?.['Pass Type']) === want);
      if (!match) return res.status(200).json({ ok: false, pending: true });
      const grant = signGrant({ tier, ref: `pay:${match.id}`, exp: Date.now() + GRANT_TTL_MS });
      return res.status(200).json({ ok: true, grant, tier });
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'Could not verify payment', detail: err.message });
    }
  }

  return res.status(400).json({ error: 'Provide session_id (Stripe) or email + tier (PayPal)' });
}

// ── action=submit ───────────────────────────────────────────────────────────

async function handleSubmit(req, res) {
  if (!grantSecret()) return res.status(500).json({ error: 'Paywall not configured (signing secret unset)' });

  // Grant travels in the query string (or header), NOT the body — so the body
  // stays a pristine multipart/form-data payload (with the buyer's file uploads)
  // that we forward to Formspree verbatim. Verify BEFORE reading the body so a
  // forged grant is rejected without consuming the upload.
  const grant = req.query?.grant ?? req.headers?.['x-intake-grant'] ?? '';
  let payload;
  try {
    payload = verifyGrant(grant);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired access grant — payment required', detail: err.message });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to read submission body', detail: err.message });
  }

  // Forward the raw body to Formspree under its original Content-Type (preserves
  // the multipart boundary + file uploads). The verified tier/ref ride along as
  // headers + are logged so the gated submission is traceable to a real payment.
  console.log(`[Intake] Verified submission tier=${payload.tier} ref=${payload.ref}`);
  try {
    const r = await fetch(formspreeUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': req.headers?.['content-type'] ?? 'application/octet-stream',
        Accept: 'application/json',
        'X-Intake-Verified-Tier': String(payload.tier ?? ''),
        'X-Intake-Payment-Ref': String(payload.ref ?? ''),
      },
      body: rawBody,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Submission forwarding failed', detail: txt.slice(0, 300) });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Submission forwarding failed', detail: err.message });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', DOMAIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query?.action;
  if (action === 'grant') return handleGrant(req, res);
  if (action === 'submit') return handleSubmit(req, res);
  return res.status(400).json({ error: 'Invalid action', valid: ['grant', 'submit'] });
}

// Disable Vercel's body parsing so `submit` can stream the raw multipart upload
// (file attachments) straight through to Formspree. `grant` parses JSON itself.
export const config = {
  api: {
    bodyParser: false,
  },
};
