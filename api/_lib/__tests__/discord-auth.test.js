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
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// discord.js reads SYNC_SECRET at import time.
const ENV_SAVED = vi.hoisted(() => {
  const saved = { ...process.env };
  process.env.SYNC_SECRET = 'sync_secret_0123456789';
  return saved;
});

vi.mock('../db.js', () => ({
  upsertDiscordLink: vi.fn(), updateDiscordSyncStatus: vi.fn().mockResolvedValue({}), findActiveMintsByEmail: vi.fn(),
  findMemberByEmail: vi.fn(), isDiscordAuthNonceUsed: vi.fn(), markDiscordAuthNonceUsed: vi.fn(),
  dbConfigured: vi.fn(() => true), listPendingDiscordSync: vi.fn(), listFailedDiscordSync: vi.fn().mockResolvedValue([]), listStuckSentMints: vi.fn().mockResolvedValue([]),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../discord-bot.js', () => ({
  addRoleToMember: vi.fn(), addMemberToGuild: vi.fn(), removeRoleFromMember: vi.fn(), syncMemberRoles: vi.fn(),
}));
vi.mock('../engage.js', () => ({ onEntitlementActivated: vi.fn().mockResolvedValue({}) }));

import handler, { timingSafeStrEqual } from '../../discord.js';
import * as db from '../db.js';
import { syncMemberRoles } from '../discord-bot.js';

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

// ── /api/discord?action=sync — bearer-auth JSON API, every grantable role ─────

describe('handleSync (JSON API) grants and reports every grantable role', () => {
  const SECRET = 'sync_secret_0123456789';
  const EMAIL = 'member@example.com';
  const mint = (nftType) => ({ id: nftType, fields: { 'NFT Type': nftType } });
  const LAPSED = { 'Billing State': 'cancelled', 'Entitlement Expires At': '2020-01-01T00:00:00Z' };

  function mockRes() {
    return {
      statusCode: 0, body: null, redirectedTo: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      setHeader() { return this; },
      end() { return this; },
      redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
    };
  }
  async function sync(headers = { authorization: `Bearer ${SECRET}` }) {
    const res = mockRes();
    await handler({ method: 'POST', query: { action: 'sync' }, headers, body: { email: EMAIL } }, res);
    return res;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, {
      DISCORD_ROLE_MONTHLY: 'role_m', DISCORD_ROLE_LIFETIME: 'role_l', DISCORD_ROLE_PRODUCT_A: 'role_a',
    });
    db.findMemberByEmail.mockResolvedValue({ id: 'mem1', fields: { 'Discord ID': 'd_1', ...LAPSED } });
    db.findActiveMintsByEmail.mockResolvedValue([mint('001 Genesis'), mint('004 Chrome'), mint('Aurevon Insider')]);
    syncMemberRoles.mockResolvedValue({ granted: [] });
  });
  afterAll(() => { process.env = { ...ENV_SAVED }; });

  it('wrong secret → 401 JSON (API route, not a redirect)', async () => {
    const res = await sync({ authorization: 'Bearer wrong' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(res.redirectedTo).toBeNull();
  });

  it('lapsed Genesis + Chrome + Insider → grants [role_l, role_a], removes role_m, JSON roleIds', async () => {
    const res = await sync();
    expect(syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l', 'role_a'], ['role_m']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true, discordId: 'd_1', roleIds: ['role_l', 'role_a'], entitlementKeys: ['lifetime_membership', 'product_a_reward'],
    });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced');
  });

  it('a missing role env → grants the rest, JSON lists missing, member stays pending', async () => {
    delete process.env.DISCORD_ROLE_PRODUCT_A;
    const res = await sync();
    expect(syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l'], ['role_m']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ roleIds: ['role_l'], missing: ['product_a_reward'] }));
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending');
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'synced');
  });

  it('only a lapsed monthly pass → 403 JSON, nothing granted', async () => {
    db.findActiveMintsByEmail.mockResolvedValue([mint('001 Genesis')]);
    const res = await sync();
    expect(res.statusCode).toBe(403);
    expect(syncMemberRoles).not.toHaveBeenCalled();
  });

  it('grant failure → 502 JSON with failedRoleIds, sync marked failed', async () => {
    syncMemberRoles.mockRejectedValueOnce(Object.assign(new Error('Discord bot (403): Missing Permissions'), { failedRoleIds: ['role_a'] }));
    const res = await sync();
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({ roleIds: ['role_l', 'role_a'], failedRoleIds: ['role_a'] }));
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'failed', expect.anything());
  });
});
