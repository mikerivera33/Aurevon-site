/**
 * Discord secret-compare hardening tests (L3).
 *
 * handleSync (?action=sync) and handleCheckMembership (cron) authenticate with
 * SYNC_SECRET. Those comparisons were plain `!==`, a timing side channel.
 * They now route through timingSafeStrEqual, which must:
 *   - reject a wrong-LENGTH secret (Buffer.from length mismatch would otherwise
 *     make crypto.timingSafeEqual throw),
 *   - reject a same-length but wrong-VALUE secret,
 *   - accept the correct secret.
 */
import { describe, it, expect } from 'vitest';
import { timingSafeStrEqual } from '../../discord.js';

describe('timingSafeStrEqual — constant-time secret comparison', () => {
  const SECRET = 'sync_secret_0123456789';

  it('accepts an exactly-matching secret', () => {
    expect(timingSafeStrEqual(SECRET, SECRET)).toBe(true);
  });

  it('rejects a wrong-length secret without throwing', () => {
    expect(timingSafeStrEqual('short', SECRET)).toBe(false);
    expect(timingSafeStrEqual(`${SECRET}_extra`, SECRET)).toBe(false);
  });

  it('rejects a same-length but wrong-value secret', () => {
    const wrong = 'x'.repeat(SECRET.length);
    expect(wrong.length).toBe(SECRET.length);
    expect(timingSafeStrEqual(wrong, SECRET)).toBe(false);
  });

  it('rejects when the provided value is empty', () => {
    expect(timingSafeStrEqual('', SECRET)).toBe(false);
  });

  it('models the Bearer-header shape used by handleCheckMembership', () => {
    expect(timingSafeStrEqual(`Bearer ${SECRET}`, `Bearer ${SECRET}`)).toBe(true);
    expect(timingSafeStrEqual(`Bearer wrong`, `Bearer ${SECRET}`)).toBe(false);
  });
});
