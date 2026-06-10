/**
 * Cron-auth regression tests (C3).
 *
 * The reconcile / retry-mints crons authenticate with CRON_SECRET (Vercel sends
 * `Authorization: Bearer <CRON_SECRET>`), while operator.html uses RECONCILE_SECRET
 * via ?secret=. The validator must accept EITHER configured secret, otherwise one
 * path silently 401s and the safety-net jobs never run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateReconcileSecret } from '../../member/claim.js';

describe('validateReconcileSecret — accepts either configured secret', () => {
  const SAVED = { ...process.env };
  beforeEach(() => {
    delete process.env.RECONCILE_SECRET;
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('accepts RECONCILE_SECRET via ?secret (operator path)', () => {
    process.env.RECONCILE_SECRET = 'rec_secret_0123456789';
    expect(validateReconcileSecret({ query: { secret: 'rec_secret_0123456789' } })).toBe(true);
  });

  it('accepts CRON_SECRET via Bearer header even when it differs from RECONCILE_SECRET (Vercel cron path)', () => {
    process.env.RECONCILE_SECRET = 'rec_secret_0123456789';
    process.env.CRON_SECRET = 'cron_secret_abcdefghij';
    expect(
      validateReconcileSecret({ headers: { authorization: 'Bearer cron_secret_abcdefghij' } })
    ).toBe(true);
  });

  it('rejects a wrong secret', () => {
    process.env.RECONCILE_SECRET = 'rec_secret_0123456789';
    expect(validateReconcileSecret({ query: { secret: 'nope' } })).toBe(false);
  });

  it('rejects when neither secret is configured', () => {
    expect(validateReconcileSecret({ query: { secret: 'anything' } })).toBe(false);
  });
});
