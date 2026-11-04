/**
 * Browser-safe Discord errors (Task 8).
 *
 * /api/discord?action=auth and ?action=callback are opened from an emailed link.
 * Every failure must 302 to /discord-welcome.html?error=<code> — the page turns
 * the code into copy and an "Email me a new link" button — and never answer with
 * a raw JSON body. Codes: invalid_link, link_used, no_nft, auth_failed,
 * role_failed, denied.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

vi.mock('../db.js', () => ({
  upsertDiscordLink: vi.fn(), updateDiscordSyncStatus: vi.fn(), findActiveMintsByEmail: vi.fn(),
  findMemberByEmail: vi.fn(), isDiscordAuthNonceUsed: vi.fn(), markDiscordAuthNonceUsed: vi.fn(),
  dbConfigured: vi.fn(() => true), listPendingDiscordSync: vi.fn(),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../discord-bot.js', () => ({
  addRoleToMember: vi.fn(), addMemberToGuild: vi.fn(), removeRoleFromMember: vi.fn(), syncMemberRoles: vi.fn(),
}));
vi.mock('../engage.js', () => ({ onEntitlementActivated: vi.fn().mockResolvedValue({}) }));

const SAVED = { ...process.env };
const EMAIL = 'member@example.com';
const WELCOME = 'https://www.aurevonvc.com/discord-welcome.html';

let db;
let bot;
let sendAlert;
let discord;
let oauth;

function mockRes() {
  return {
    statusCode: 0, redirectedTo: null, jsonCalled: false,
    status(c) { this.statusCode = c; return this; },
    json() { this.jsonCalled = true; return this; },
    setHeader() { return this; },
    end() { return this; },
    redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
  };
}

async function call(query) {
  const res = mockRes();
  await discord.default({ method: 'GET', query, headers: {} }, res);
  return res;
}

function expectError(res, code) {
  expect(res.jsonCalled).toBe(false);
  expect(res.statusCode).toBe(302);
  expect(res.redirectedTo).toBe(`${WELCOME}?error=${code}`);
}

const callback = (over = {}) => call({ action: 'callback', code: 'c1', state: discord.signDiscordAccessToken(EMAIL), ...over });

beforeAll(async () => {
  delete process.env.DOMAIN;
  Object.assign(process.env, {
    STATE_SECRET: 'test_state_secret_abcdefghij1234567890',
    DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', DISCORD_GUILD_ID: '123456789012345678',
    DISCORD_ROLE_MONTHLY: 'role_m', DISCORD_ROLE_LIFETIME: 'role_l', DISCORD_ROLE_PRODUCT_A: 'role_a',
    DISCORD_ROLE_PRODUCT_B: 'role_b', DISCORD_ROLE_PRODUCT_C: 'role_c',
  });
  db = await import('../db.js');
  bot = await import('../discord-bot.js');
  ({ sendAlert } = await import('../alert.js'));
  discord = await import('../../discord.js');
});
afterAll(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.clearAllMocks();
  oauth = { token: 200, user: 200 };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith('/oauth2/token')) {
      return oauth.token === 200
        ? { ok: true, status: 200, json: async () => ({ access_token: 'at_1' }) }
        : { ok: false, status: oauth.token, text: async () => '{"error":"invalid_grant"}' };
    }
    if (u.endsWith('/users/@me')) {
      return oauth.user === 200
        ? { ok: true, status: 200, json: async () => ({ id: 'u_1', username: 'member' }) }
        : { ok: false, status: oauth.user, text: async () => '{"message":"401: Unauthorized"}' };
    }
    throw new Error(`unexpected fetch ${u}`);
  }));
  db.isDiscordAuthNonceUsed.mockResolvedValue(false);
  db.findMemberByEmail.mockResolvedValue({ id: 'mem1', fields: { 'Billing State': 'active' } });
  db.findActiveMintsByEmail.mockResolvedValue([{ id: 'c', fields: { 'NFT Type': '004 Chrome' } }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('auth (emailed link entry point)', () => {
  it('no token → invalid_link', async () => {
    expectError(await call({ action: 'auth' }), 'invalid_link');
  });

  it('old ?email=-only link → invalid_link (still fails closed, no OAuth)', async () => {
    const res = await call({ action: 'auth', email: EMAIL });
    expectError(res, 'invalid_link');
    expect(res.redirectedTo).not.toContain('member');
  });

  it('forged / expired token → invalid_link', async () => {
    expectError(await call({ action: 'auth', token: 'garbage.token' }), 'invalid_link');
  });
});

describe('callback', () => {
  it('user cancelled on Discord → denied', async () => {
    expectError(await call({ action: 'callback', error: 'access_denied' }), 'denied');
  });

  it('missing code or state → invalid_link', async () => {
    expectError(await call({ action: 'callback' }), 'invalid_link');
    expectError(await call({ action: 'callback', code: 'c1' }), 'invalid_link');
  });

  it('bad state → invalid_link', async () => {
    expectError(await callback({ state: 'garbage.token' }), 'invalid_link');
  });

  it('already-redeemed link → link_used', async () => {
    db.isDiscordAuthNonceUsed.mockResolvedValue(true);
    expectError(await callback(), 'link_used');
  });

  it('token exchange fails → auth_failed', async () => {
    oauth.token = 400;
    expectError(await callback(), 'auth_failed');
  });

  it('users/@me fails → auth_failed', async () => {
    oauth.user = 401;
    expectError(await callback(), 'auth_failed');
  });

  it('mint lookup throws → auth_failed (our fault, not "no membership")', async () => {
    db.findActiveMintsByEmail.mockRejectedValue(new Error('database unavailable'));
    expectError(await callback(), 'auth_failed');
  });

  it('no mints → no_nft', async () => {
    db.findActiveMintsByEmail.mockResolvedValue([]);
    expectError(await callback(), 'no_nft');
  });

  it('only a lapsed monthly pass → no_nft, no role touched', async () => {
    db.findMemberByEmail.mockResolvedValue({ id: 'mem1', fields: { 'Billing State': 'cancelled', 'Entitlement Expires At': '2020-01-01T00:00:00Z' } });
    db.findActiveMintsByEmail.mockResolvedValue([{ id: 'g', fields: { 'NFT Type': '001 Genesis' } }]);
    expectError(await callback(), 'no_nft');
    expect(bot.addMemberToGuild).not.toHaveBeenCalled();
    expect(bot.addRoleToMember).not.toHaveBeenCalled();
  });

  it('grantable pass with no role env configured → role_failed (not no_nft), awaited alert, link not burned', async () => {
    delete process.env.DISCORD_ROLE_LIFETIME;
    try {
      expectError(await callback(), 'role_failed');
      expect(sendAlert).toHaveBeenCalledWith('discord.role_not_configured',
        { entitlementKey: 'lifetime_membership' }, { severity: 'high', dedupeKey: 'lifetime_membership' });
      expect(bot.addMemberToGuild).not.toHaveBeenCalled();
      expect(db.markDiscordAuthNonceUsed).not.toHaveBeenCalled();
    } finally {
      process.env.DISCORD_ROLE_LIFETIME = 'role_l';
    }
  });

  it('every role add fails → role_failed + critical discord.role_grant_failed alert; link not burned', async () => {
    bot.addRoleToMember.mockRejectedValueOnce(new Error('Discord member u_1 not found in guild — they must join first'));
    expectError(await callback(), 'role_failed');
    expect(sendAlert).toHaveBeenCalledWith('discord.role_grant_failed', { status: 404, count: 1 }, { severity: 'critical' });
    expect(db.markDiscordAuthNonceUsed).not.toHaveBeenCalled();
  });

  it('success is a redirect too (no JSON), without an error code', async () => {
    const res = await callback();
    expect(res.jsonCalled).toBe(false);
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).toMatch(/^https:\/\/www\.aurevonvc\.com\/discord-welcome\.html\?role=/);
    expect(res.redirectedTo).not.toContain('error=');
  });
});

describe('API routes keep JSON', () => {
  it('unknown action → 400 JSON', async () => {
    const res = await call({ action: 'nope' });
    expect(res.jsonCalled).toBe(true);
    expect(res.statusCode).toBe(400);
  });
});
