/**
 * Intake paywall (api/intake.js) — the hard gate that replaces the forgeable
 * client `paid_*` token. These tests carry the verification that can't be done
 * live (no Stripe/Formspree creds in CI): forged/expired grants are rejected,
 * valid grants forward, a missing signing secret fails closed, and grants are
 * only issued for confirmed payments.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted so mockRetrieve exists when the hoisted vi.mock factory runs.
// Stripe must be a real (constructable) class — an arrow-fn impl throws
// "is not a constructor" under `new Stripe(...)`.
const { mockRetrieve } = vi.hoisted(() => ({ mockRetrieve: vi.fn() }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    constructor() { this.checkout = { sessions: { retrieve: mockRetrieve } }; }
  },
}));
vi.mock('../airtable.js', () => ({ findSucceededPaymentsByEmail: vi.fn() }));

import handler, { signGrant, verifyGrant } from '../../intake.js';
import * as airtable from '../airtable.js';

function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (d) => { r.body = d; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
const call = (query, body) => { const res = mockRes(); return handler({ method: 'POST', query, body }, res).then(() => res); };

// submit carries the grant in the query and the upload as a raw streamed body.
function callSubmit({ grant, contentType = 'multipart/form-data; boundary=XB', body = Buffer.from('--XB--\r\n') } = {}) {
  const res = mockRes();
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const req = {
    method: 'POST',
    headers: { 'content-type': contentType },
    query: { action: 'submit', ...(grant !== undefined ? { grant } : {}) },
    on(event, cb) {
      if (event === 'data' && buf.length) setTimeout(() => cb(buf), 0);
      if (event === 'end') setTimeout(cb, 1);
      return this;
    },
  };
  return handler(req, res).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STATE_SECRET = 'unit-test-signing-secret';
  delete process.env.INTAKE_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
});

describe('grant HMAC', () => {
  it('round-trips a valid grant', () => {
    const g = signGrant({ tier: 're_full', ref: 'stripe:cs_1', exp: Date.now() + 60000 });
    expect(verifyGrant(g)).toMatchObject({ tier: 're_full', ref: 'stripe:cs_1' });
  });
  it('rejects a tampered payload', () => {
    const g = signGrant({ tier: 're_full', ref: 'x', exp: Date.now() + 60000 });
    const tampered = Buffer.from(JSON.stringify({ tier: 're_enterprise', ref: 'x', exp: Date.now() + 60000 })).toString('base64url') + '.' + g.split('.')[1];
    expect(() => verifyGrant(tampered)).toThrow();
  });
  it('rejects an expired grant', () => {
    const g = signGrant({ tier: 're_full', ref: 'x', exp: Date.now() - 1 });
    expect(() => verifyGrant(g)).toThrow(/expired/i);
  });
});

describe('action=grant (Stripe)', () => {
  it('issues a grant for a paid intake-tier session', async () => {
    mockRetrieve.mockResolvedValueOnce({ id: 'cs_123', payment_status: 'paid', metadata: { tier: 're_full' } });
    const res = await call({ action: 'grant' }, { session_id: 'cs_123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(verifyGrant(res.body.grant)).toMatchObject({ tier: 're_full', ref: 'stripe:cs_123' });
  });
  it('refuses an unpaid session (402)', async () => {
    mockRetrieve.mockResolvedValueOnce({ id: 'cs_x', payment_status: 'unpaid', metadata: { tier: 're_full' } });
    const res = await call({ action: 'grant' }, { session_id: 'cs_x' });
    expect(res.statusCode).toBe(402);
    expect(res.body.ok).toBe(false);
  });
});

describe('action=grant (PayPal / email+tier)', () => {
  it('issues a grant when a Succeeded payment exists (bare tier matches re_ tier)', async () => {
    airtable.findSucceededPaymentsByEmail.mockResolvedValueOnce([{ id: 'rec1', fields: { 'Pass Type': 'full' } }]);
    const res = await call({ action: 'grant' }, { email: 'buyer@x.com', tier: 're_full' });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(verifyGrant(res.body.grant)).toMatchObject({ tier: 're_full', ref: 'pay:rec1' });
  });
  it('returns pending when no payment is recorded yet (IPN delay)', async () => {
    airtable.findSucceededPaymentsByEmail.mockResolvedValueOnce([]);
    const res = await call({ action: 'grant' }, { email: 'buyer@x.com', tier: 're_full' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: false, pending: true });
  });
});

describe('action=submit (the gate)', () => {
  it('forwards the raw multipart body to Formspree verbatim with a valid grant', async () => {
    const grant = signGrant({ tier: 're_full', ref: 'stripe:cs_1', exp: Date.now() + 60000 });
    const body = Buffer.from('--XB\r\nContent-Disposition: form-data; name="property"\r\n\r\n123 Main St\r\n--XB--\r\n');
    const res = await callSubmit({ grant, body });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toContain('formspree.io');
    expect(opts.headers['Content-Type']).toContain('multipart/form-data'); // boundary preserved
    expect(opts.headers['X-Intake-Verified-Tier']).toBe('re_full');
    expect(Buffer.compare(opts.body, body)).toBe(0); // upload bytes (files) untouched
  });
  it('rejects a forged grant with 401 and does NOT forward (upload not consumed)', async () => {
    const res = await callSubmit({ grant: 'paid_full_deadbeef.notavalidmac' });
    expect(res.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a missing grant with 401', async () => {
    const res = await callSubmit({});
    expect(res.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed (500) when the signing secret is unset', async () => {
    delete process.env.STATE_SECRET;
    delete process.env.INTAKE_SECRET;
    const res = await callSubmit({ grant: 'whatever.x' });
    expect(res.statusCode).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });
});
