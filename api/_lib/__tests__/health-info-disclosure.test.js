/**
 * Info-disclosure regression for GET /api/health (finding L1).
 *
 * The public/unauthenticated health body previously leaked a precise
 * misconfiguration map: env="partial", the exact names of any missing required
 * env vars, and the app version. That is how a missing CROSSMINT_WEBHOOK_SECRET
 * was discovered from the outside.
 *
 * Fix: unauthenticated callers get a minimal liveness body only. The full
 * diagnostic is gated behind `Authorization: Bearer <INTERNAL_API_SECRET>`
 * (timing-safe, length-guarded) and FAILS CLOSED when the secret is unset.
 */
import { describe, it, expect, afterEach } from 'vitest';
import handler from '../../health.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

describe('GET /api/health — info disclosure (L1)', () => {
  it('unauthenticated GET returns ONLY a minimal body (no version / env / missing_required)', () => {
    process.env.INTERNAL_API_SECRET = 'health_diag_secret_0123456789';
    const res = mockRes();
    handler({ method: 'GET', headers: {}, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'healthy' });
    expect(res.body.version).toBeUndefined();
    expect(res.body.env).toBeUndefined();
    expect(res.body.missing_required).toBeUndefined();
    expect(res.body.function_count).toBeUndefined();
  });

  it('a wrong bearer secret still gets only the minimal body', () => {
    process.env.INTERNAL_API_SECRET = 'health_diag_secret_0123456789';
    const res = mockRes();
    handler({ method: 'GET', headers: { authorization: 'Bearer wrong-secret' }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.version).toBeUndefined();
    expect(res.body.missing_required).toBeUndefined();
  });

  it('a correct bearer secret returns the full diagnostic body', () => {
    process.env.INTERNAL_API_SECRET = 'health_diag_secret_0123456789';
    const res = mockRes();
    handler(
      { method: 'GET', headers: { authorization: 'Bearer health_diag_secret_0123456789' }, query: {} },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.version).toBeDefined();
    expect(res.body).toHaveProperty('env');
    expect(res.body).toHaveProperty('missing_required');
    expect(res.body.function_limit).toBe(100);
  });

  it('fails closed: when INTERNAL_API_SECRET is unset, even a bearer request gets the minimal body', () => {
    delete process.env.INTERNAL_API_SECRET;
    const res = mockRes();
    handler({ method: 'GET', headers: { authorization: 'Bearer anything' }, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'healthy' });
    expect(res.body.version).toBeUndefined();
  });

  it('a bearer with equal STRING length but different BYTE length does not throw (byte-length guard) and gets the minimal body', () => {
    // secret is 29 chars / 29 bytes. This provided value is also 29 JS chars but
    // 30 bytes (the 'é' is 2 UTF-8 bytes) — a string-length-only guard would pass
    // it into timingSafeEqual, which throws RangeError on byte-length mismatch.
    process.env.INTERNAL_API_SECRET = 'health_diag_secret_0123456789';
    const res = mockRes();
    expect(() =>
      handler({ method: 'GET', headers: { authorization: 'Bearer health_diag_secret_012345678é' }, query: {} }, res),
    ).not.toThrow();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'healthy' });
    expect(res.body.version).toBeUndefined();
  });

  it('still rejects non-GET methods with 405', () => {
    const res = mockRes();
    handler({ method: 'POST', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(405);
  });
});
