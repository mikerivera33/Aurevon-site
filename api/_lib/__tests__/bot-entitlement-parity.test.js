import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));

import { ENTITLEMENT_MAP, mayGrantPaidAccess } from '../entitlements.js';
import { ENTITLEMENTS, mayGrant } from '../../../discord/entitlements.js';

const PARITY_FIELDS = ['nftType', 'discordRoleEnv', 'revokeOnCancel', 'membershipMode'];

describe('bot entitlement table matches the site ENTITLEMENT_MAP', () => {
  it('has exactly the same five keys', () => {
    expect(ENTITLEMENTS.map((e) => e.key).sort()).toEqual(Object.keys(ENTITLEMENT_MAP).sort());
    expect(ENTITLEMENTS).toHaveLength(5);
  });

  for (const key of Object.keys(ENTITLEMENT_MAP)) {
    it(`${key}: ${PARITY_FIELDS.join(' / ')} are identical`, () => {
      const bot = ENTITLEMENTS.find((e) => e.key === key);
      const site = ENTITLEMENT_MAP[key];
      for (const f of PARITY_FIELDS) expect({ [f]: bot?.[f] }).toEqual({ [f]: site[f] });
    });
  }

  it('mayGrant gives the same answer as mayGrantPaidAccess', () => {
    const now = Date.now();
    const day = 86_400_000;
    const states = [null, '', 'active', 'trialing', 'cancelled', 'past_due', 'unpaid', 'unknown'];
    const ends = [null, new Date(now - 30 * day).toISOString(), new Date(now - 3 * day).toISOString(), new Date(now + 10 * day).toISOString()];
    for (const key of [...Object.keys(ENTITLEMENT_MAP), null, 'nope']) {
      for (const billingState of states) {
        for (const endsAt of ends) {
          const site = mayGrantPaidAccess({ entitlementKey: key, billingState, endsAt, gracePeriodDays: 7 });
          const bot = mayGrant({ key, billingState, endsAt, graceDays: 7 });
          expect({ key, billingState, endsAt, grant: bot }).toEqual({ key, billingState, endsAt, grant: site });
        }
      }
    }
  });

  it('discord/entitlements.js stays dependency-free (the bot is deployed from discord/ alone)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../discord/entitlements.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });
});
