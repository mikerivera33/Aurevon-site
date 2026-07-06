/**
 * Cron-auth regression tests (C3 + L2).
 *
 * The reconcile / retry-mints crons authenticate with CRON_SECRET (Vercel sends
 * `Authorization: Bearer <CRON_SECRET>`); operator flows use RECONCILE_SECRET via
 * the same Bearer header. The validator must accept EITHER configured secret so
 * neither path silently 401s.
 *
 * L2 hardening: the secret is now HEADER-ONLY. ?secret= is NO LONGER accepted
 * (query strings leak into Vercel/CDN access logs). These cases were updated from
 * the pre-fix ?secret= form to assert the header-only contract and to prove the
 * query param is now rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateReconcileSecret } from '../../member/claim.js';

describe('validateReconcileSecret — header-only, accepts either configured secret', () => {
  const SAVED = { ...process.env };
  beforeEach(() => {
    delete process.env.RECONCILE_SECRET;
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('accepts RECONCILE_SECRET via Bearer header (operator path)', () => {
    process.env.RECONCILE_SECRET = 'rec_secret_0123456789';
    expect(validateReconcileSecret({ headers: { authorization: 'Bearer rec_secret_0123456789' } })).toBe(true);
  });

  it('accepts CRON_SECRET via Bearer header even when it differs from RECONCILE_SECRET (Vercel cron path)', () => {
    process.env.RECONCILE_SECRET = 'rec_secret_0123456789';
    process.env.CRON_SECRET = 'cron_secret_abcdefghij';
    expect(
      validateReconcileSecret({ headers: { authorization: 'Bearer cron_secret_abcdefghij' } })
    ).toBe(true);
  });

  it('REJECTS the correct secret supplied via ?secret= (L2 — no secrets in query/logs)', () => {
    process.env.RECONCILE_SECRET = 'rec_secret_0123456789';
    expect(validateReconcileSecret({ query: { secret: 'rec_secret_0123456789' } })).toBe(false);
  });

  it('rejects a wrong secret', () => {
    process.env.RECONCILE_SECRET = 'rec_secret_0123456789';
    expect(validateReconcileSecret({ headers: { authorization: 'Bearer nope' } })).toBe(false);
  });

  it('rejects when neither secret is configured', () => {
    expect(validateReconcileSecret({ headers: { authorization: 'Bearer anything' } })).toBe(false);
  });
});
