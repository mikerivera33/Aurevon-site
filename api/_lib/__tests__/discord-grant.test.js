/**
 * Discord — every grantable role, on every grant path (Task 8).
 *
 * A member can hold several passes (e.g. Chrome + Insider). Each grant path —
 * the OAuth callback, the check-membership cron, the reconcile cron (which picks
 * up the 'pending' re-queue fulfil sets after a new mint) and the Crossmint
 * mint-success webhook — grants the role of EVERY pass billing still allows. A
 * lapsed monthly Genesis never hides a permanent pass, and only a revocable
 * (monthly) role is ever removed.
 *
 * Harness: real discord.js / claim.js / crossmint.js / entitlements.js; in-memory
 * db (nft-harness), faked Discord bot, alerts, Engage, Stripe SDK and fetch
 * (Discord OAuth token exchange + users/@me).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const store = vi.hoisted(() => ({}));

vi.mock('../db.js', async () => ({
  ...(await import('./helpers/nft-harness.js')).makeFakeDb(store),
  listActiveMintsByEmailAndTypeWithoutToken: vi.fn(async () => []),
}));
vi.mock('../airtable-import.js', () => ({
  airtableImportEnabled: vi.fn(() => false), countAirtableMintsByPrefix: vi.fn(),
  importFromAirtable: vi.fn(), importHasProblems: vi.fn(() => false),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../discord-bot.js', () => ({
  addRoleToMember: vi.fn(), addMemberToGuild: vi.fn(), removeRoleFromMember: vi.fn(), syncMemberRoles: vi.fn(),
}));
vi.mock('../engage.js', () => ({
  onEntitlementActivated: vi.fn().mockResolvedValue({}),
  onDiscordLinkReminder: vi.fn().mockResolvedValue({}),
  onSubscriptionCancelled: vi.fn().mockResolvedValue({}),
}));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.checkout = { sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) } };
      this.subscriptions = { update: vi.fn(), retrieve: vi.fn() };
      this.customers = { retrieve: vi.fn() };
    }
  },
}));

import { resetStore, applyEnv } from './helpers/nft-harness.js';

const SAVED = { ...process.env };
const GUILD = '123456789012345678';
const SYNC = 'sync_secret_0123456789';
const EMAIL = 'member@example.com';

let db;
let bot;
let sendAlert;
let discord;
let claim;
let crossmint;

const mint = (id, nftType, extra = {}) => ({ id, fields: { 'NFT Type': nftType, 'Email': EMAIL, 'Reference': `REF-${id}`, ...extra } });
const GENESIS = mint('g', '001 Genesis');
const CHROME = mint('c', '004 Chrome');
const INSIDER = mint('i', 'Aurevon Insider');
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

function installDiscordFetch() {
  const fetchMock = vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'at_1' }) };
    if (u.endsWith('/users/@me')) return { ok: true, status: 200, json: async () => ({ id: 'u_1', username: 'member' }) };
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  applyEnv();
  Object.assign(process.env, {
    DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', DISCORD_GUILD_ID: GUILD, SYNC_SECRET: SYNC,
  });
  db = await import('../db.js');
  bot = await import('../discord-bot.js');
  ({ sendAlert } = await import('../alert.js'));
  discord = await import('../../discord.js');
  claim = await import('../../member/claim.js');
  crossmint = await import('../../webhooks/crossmint.js');
});
afterAll(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

beforeEach(() => {
  resetStore(store);
  applyEnv();
  vi.clearAllMocks();
  installDiscordFetch();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('OAuth callback grants every grantable role', () => {
  async function callback() {
    const res = mockRes();
    const state = discord.signDiscordAccessToken(EMAIL);
    await discord.default({ method: 'GET', query: { action: 'callback', code: 'c1', state }, headers: {} }, res);
    return res;
  }

  beforeEach(() => {
    store.members.set(EMAIL, { id: 'mem1', fields: { Email: EMAIL, ...LAPSED } });
    db.findActiveMintsByEmail.mockResolvedValue([GENESIS, CHROME, INSIDER]);
  });

  it('lapsed Genesis + Chrome + Insider: joins with both roles, adds both, never the Genesis role', async () => {
    const res = await callback();

    expect(bot.addMemberToGuild).toHaveBeenCalledWith('u_1', 'at_1', ['role_l', 'role_a']);
    expect(bot.addRoleToMember.mock.calls).toEqual([['u_1', 'role_l'], ['u_1', 'role_a']]);
    expect(res.statusCode).toBe(302);
    const url = new URL(res.redirectedTo);
    expect(url.pathname).toBe('/discord-welcome.html');
    expect(url.searchParams.get('error')).toBeNull();
    expect(url.searchParams.get('role')).toBe('004 Chrome, Aurevon Insider');
    expect(url.searchParams.get('server')).toBe(GUILD);
    expect(db.upsertDiscordLink).toHaveBeenCalledWith(EMAIL, { discordId: 'u_1', discordUsername: 'member' });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced');
    expect(db.markDiscordAuthNonceUsed).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a member already in the guild (addMemberToGuild fails) still gets every role via addRoleToMember', async () => {
    bot.addMemberToGuild.mockRejectedValueOnce(new Error('Discord bot [addMemberToGuild(u_1)] (403): {}'));
    const res = await callback();
    expect(bot.addRoleToMember).toHaveBeenCalledTimes(2);
    expect(new URL(res.redirectedTo).searchParams.get('error')).toBeNull();
  });

  it('some role adds fail → still success, role_grant_failed alert, sync left pending for the cron', async () => {
    bot.addRoleToMember
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Discord bot [addRoleToMember(u_1, role_a)] (403): Missing Permissions'));
    const res = await callback();

    expect(new URL(res.redirectedTo).searchParams.get('error')).toBeNull();
    expect(sendAlert).toHaveBeenCalledWith('discord.role_grant_failed', { status: 403, count: 1 }, { severity: 'critical' });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending');
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'synced');
  });

  it('one role env missing → others granted, success page, awaited alert, sync left pending', async () => {
    delete process.env.DISCORD_ROLE_PRODUCT_A;
    const res = await callback();
    expect(bot.addRoleToMember.mock.calls).toEqual([['u_1', 'role_l']]);
    const url = new URL(res.redirectedTo);
    expect(url.searchParams.get('error')).toBeNull();
    expect(url.searchParams.get('role')).toBe('004 Chrome');
    expect(sendAlert).toHaveBeenCalledWith('discord.role_not_configured',
      { entitlementKey: 'product_a_reward' }, { severity: 'high', dedupeKey: 'product_a_reward' });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending');
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'synced');
  });

  it('active monthly member: Genesis role granted alongside the permanent passes', async () => {
    store.members.set(EMAIL, { id: 'mem1', fields: { Email: EMAIL, 'Billing State': 'active' } });
    await callback();
    expect(bot.addMemberToGuild).toHaveBeenCalledWith('u_1', 'at_1', ['role_m', 'role_l', 'role_a']);
  });

  it('never logs the member email', async () => {
    bot.addRoleToMember.mockRejectedValueOnce(new Error('Discord member u_1 not found in guild — they must join first'));
    await callback();
    const logged = JSON.stringify([...console.log.mock.calls, ...console.warn.mock.calls, ...console.error.mock.calls]);
    expect(logged).not.toContain(EMAIL);
  });
});

describe('check-membership cron grants every grantable role (JSON API)', () => {
  it('syncs all roles, removes only the lapsed Genesis role, reports roleIds', async () => {
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1', ...LAPSED } }]);
    db.findActiveMintsByEmail.mockResolvedValue([GENESIS, CHROME, INSIDER]);
    const res = mockRes();
    await discord.default({ method: 'GET', query: { action: 'check-membership' }, headers: { authorization: `Bearer ${SYNC}` } }, res);

    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l', 'role_a'], ['role_m']);
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced');
    expect(res.statusCode).toBe(200);
    expect(res.body.details.synced[0]).toEqual(expect.objectContaining({ roleIds: ['role_l', 'role_a'] }));
  });

  it('a missing role env keeps the member pending; a partial failure stays pending, not failed', async () => {
    delete process.env.DISCORD_ROLE_PRODUCT_A;
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1' } }]);
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, INSIDER]);
    const run = async () => {
      const res = mockRes();
      await discord.default({ method: 'GET', query: { action: 'check-membership' }, headers: { authorization: `Bearer ${SYNC}` } }, res);
      return res;
    };
    await run();
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l'], []);
    expect(sendAlert).toHaveBeenCalledWith('discord.role_not_configured',
      { entitlementKey: 'product_a_reward' }, { severity: 'high', dedupeKey: 'product_a_reward' });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending');
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'synced');

    process.env.DISCORD_ROLE_PRODUCT_A = 'role_a';
    vi.clearAllMocks();
    bot.syncMemberRoles.mockRejectedValueOnce(Object.assign(new Error('Discord bot (403): x'), { granted: ['role_l'] }));
    await run();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending', expect.anything());
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'failed', expect.anything());
  });

  it('lapsed monthly only → revoked, no grant', async () => {
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1', ...LAPSED } }]);
    db.findActiveMintsByEmail.mockResolvedValue([GENESIS]);
    const res = mockRes();
    await discord.default({ method: 'GET', query: { action: 'check-membership' }, headers: { authorization: `Bearer ${SYNC}` } }, res);
    expect(bot.syncMemberRoles).not.toHaveBeenCalled();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'revoked');
  });
});

describe('reconcile cron (pending Discord syncs) grants every grantable role', () => {
  async function runReconcile() {
    process.env.CRON_SECRET = 'cron_secret_abcdefghij';
    const res = mockRes();
    await claim.default({ method: 'GET', query: { action: 'reconcile' }, headers: { authorization: 'Bearer cron_secret_abcdefghij' } }, res);
    return res;
  }

  it('a member re-queued after a new Insider mint gets Chrome AND Insider, rows marked synced', async () => {
    db.listPendingDiscordSync.mockResolvedValue([
      { id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1', 'Discord Sync Status': 'pending' } },
    ]);
    store.mints.push(CHROME, INSIDER);
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, INSIDER]);

    const res = await runReconcile();

    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l', 'role_a'], []);
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced');
    expect(db.updateNftMint).toHaveBeenCalledWith('c', expect.objectContaining({ 'Discord Synced': true }));
    expect(db.updateNftMint).toHaveBeenCalledWith('i', expect.objectContaining({ 'Discord Synced': true }));
    expect(res.body.report).toEqual(expect.objectContaining({ roleAssigned: 1, syncFailed: 0 }));
  });

  it('lapsed Genesis + Chrome: grants Chrome, removes only the Genesis role', async () => {
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1', ...LAPSED } }]);
    store.mints.push(GENESIS, CHROME);
    db.findActiveMintsByEmail.mockResolvedValue([GENESIS, CHROME]);
    await runReconcile();
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l'], ['role_m']);
    expect(db.updateNftMint).not.toHaveBeenCalledWith('g', expect.objectContaining({ 'Discord Synced': true }));
  });

  it('a missing role env: grants the rest, awaited alert, member stays pending (cron retries)', async () => {
    delete process.env.DISCORD_ROLE_PRODUCT_A;
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1' } }]);
    store.mints.push(CHROME, INSIDER);
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, INSIDER]);
    await runReconcile();
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l'], []);
    expect(sendAlert).toHaveBeenCalledWith('discord.role_not_configured',
      { entitlementKey: 'product_a_reward' }, { severity: 'high', dedupeKey: 'product_a_reward' });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending');
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'synced');
    expect(db.updateNftMint).toHaveBeenCalledWith('c', expect.objectContaining({ 'Discord Synced': true }));
    expect(db.updateNftMint).not.toHaveBeenCalledWith('i', expect.objectContaining({ 'Discord Synced': true }));
  });

  it('a partial grant failure leaves the member pending, not failed', async () => {
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1' } }]);
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, INSIDER]);
    bot.syncMemberRoles.mockRejectedValueOnce(Object.assign(new Error('Discord bot (403): Missing Permissions'),
      { failedRoleIds: ['role_a'], granted: ['role_l'] }));
    const res = await runReconcile();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending', expect.objectContaining({ error: expect.any(String) }));
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'failed', expect.anything());
    expect(res.body.report).toEqual(expect.objectContaining({ roleAssigned: 0, syncFailed: 1 }));
  });

  it('a failed grant marks the member failed and counts it', async () => {
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1' } }]);
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, INSIDER]);
    bot.syncMemberRoles.mockRejectedValueOnce(new Error('Discord member d_1 not found in guild — they must join first'));
    const res = await runReconcile();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'failed', expect.objectContaining({ error: expect.any(String) }));
    expect(res.body.report).toEqual(expect.objectContaining({ roleAssigned: 0, syncFailed: 1 }));
  });
});

describe('reconcile retries failed Discord syncs (final fix 6)', () => {
  async function runReconcile() {
    process.env.CRON_SECRET = 'cron_secret_abcdefghij';
    const res = mockRes();
    await claim.default({ method: 'GET', query: { action: 'reconcile' }, headers: { authorization: 'Bearer cron_secret_abcdefghij' } }, res);
    return res;
  }
  const failed = (attempts) => ({ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1', 'Discord Sync Status': 'failed', 'Discord Sync Attempts': attempts } });
  beforeEach(() => {
    db.listPendingDiscordSync.mockResolvedValue([]);
    db.listFailedDiscordSync.mockResolvedValue([]);
  });

  it('asks for failed members > 6 h old, < 3 attempts, 20 per run', async () => {
    await runReconcile();
    expect(db.listFailedDiscordSync).toHaveBeenCalledWith({ olderThanHours: 6, maxAttempts: 3, maxRecords: 20 });
  });

  it('a retry that succeeds grants through the normal path and resets the attempt count', async () => {
    db.listFailedDiscordSync.mockResolvedValueOnce([failed(2)]);
    store.mints.push(CHROME, INSIDER);
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, INSIDER]);
    const res = await runReconcile();
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l', 'role_a'], []);
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced', { attempts: 0 });
    expect(res.body.report).toEqual(expect.objectContaining({ failedSyncRetried: 1, roleAssigned: 1 }));
  });

  it('a retry that fails again bumps the count; the 3rd consecutive failure alerts discord.sync_gave_up', async () => {
    db.findActiveMintsByEmail.mockResolvedValue([CHROME]);
    bot.syncMemberRoles.mockRejectedValue(new Error('Discord bot (500): upstream'));

    db.listFailedDiscordSync.mockResolvedValueOnce([failed(1)]);
    await runReconcile();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'failed', expect.objectContaining({ attempts: 2 }));
    expect(sendAlert.mock.calls.filter(([e]) => e === 'discord.sync_gave_up')).toHaveLength(0);

    vi.clearAllMocks();
    db.listFailedDiscordSync.mockResolvedValueOnce([failed(2)]);
    await runReconcile();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'failed', expect.objectContaining({ attempts: 3 }));
    expect(sendAlert).toHaveBeenCalledWith('discord.sync_gave_up',
      { memberId: 'mem1', attempts: 3, error: 'Discord bot (500): upstream' }, { dedupeKey: 'mem1' });
    bot.syncMemberRoles.mockReset();
  });

  it('a first failure in the pending queue counts as attempt 1', async () => {
    db.listPendingDiscordSync.mockResolvedValue([{ id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1' } }]);
    db.findActiveMintsByEmail.mockResolvedValue([CHROME]);
    bot.syncMemberRoles.mockRejectedValueOnce(new Error('Discord bot (500): upstream'));
    await runReconcile();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'failed', expect.objectContaining({ attempts: 1 }));
  });

  it('a failed member with no active pass is re-stamped (waits another window), not counted', async () => {
    db.listFailedDiscordSync.mockResolvedValueOnce([failed(1)]);
    db.findActiveMintsByEmail.mockResolvedValue([]);
    await runReconcile();
    expect(bot.syncMemberRoles).not.toHaveBeenCalled();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'failed', { error: 'no active pass to grant' });
  });

  it('a listFailedDiscordSync error is reported, not thrown', async () => {
    db.listFailedDiscordSync.mockRejectedValueOnce(new Error('column discord_sync_attempts does not exist'));
    const res = await runReconcile();
    expect(res.body.report.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^listFailedDiscordSync:/)]));
  });
});

describe('Crossmint mint-success grants every grantable role', () => {
  const NEW_ROW = { id: 'i', fields: { 'Email': EMAIL, 'NFT Type': 'Aurevon Insider', 'Token ID': '', 'Reference': 'INSIDER-0001' } };
  const success = { type: 'nfts.create.succeeded', actionId: 'act_1', data: { txId: '0xabc', token: { tokenId: '7' } } };

  beforeEach(() => {
    store.mints.push({ ...CHROME }, { ...NEW_ROW, fields: { ...NEW_ROW.fields } });
    db.findMintByActionId.mockResolvedValue(NEW_ROW);
    store.members.set(EMAIL, { id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1' } });
  });

  it('new Insider for a Chrome holder → both roles in one sync', async () => {
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, NEW_ROW]);
    await crossmint.handleMintSuccess(success);
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l', 'role_a'], []);
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced');
  });

  it('the just-minted row is included even when the mint lookup misses it', async () => {
    db.findActiveMintsByEmail.mockResolvedValue([CHROME]);
    await crossmint.handleMintSuccess(success);
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l', 'role_a'], []);
  });

  it('a missing role env: awaited role_not_configured alert, others granted, member left pending', async () => {
    delete process.env.DISCORD_ROLE_PRODUCT_A;
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, NEW_ROW]);
    await crossmint.handleMintSuccess(success);
    expect(sendAlert).toHaveBeenCalledWith('discord.role_not_configured',
      { entitlementKey: 'product_a_reward' }, { severity: 'high', dedupeKey: 'product_a_reward' });
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_l'], []);
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending');
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith(EMAIL, 'synced');
    expect(db.updateNftMint).not.toHaveBeenCalledWith('i', expect.objectContaining({ 'Discord Synced': true }));
  });

  it('every role env missing: alert awaited, member left pending, nothing granted', async () => {
    delete process.env.DISCORD_ROLE_PRODUCT_A;
    delete process.env.DISCORD_ROLE_LIFETIME;
    db.findActiveMintsByEmail.mockResolvedValue([CHROME, NEW_ROW]);
    await crossmint.handleMintSuccess(success);
    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(bot.syncMemberRoles).not.toHaveBeenCalled();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'pending', expect.objectContaining({ error: expect.any(String) }));
  });
});

describe('syncMemberRoles (real implementation)', () => {
  let real;
  let calls;
  beforeEach(async () => {
    real = await vi.importActual('../discord-bot.js');
    process.env.DISCORD_GUILD_ID = GUILD;
    process.env.DISCORD_BOT_TOKEN = 'bot_token';
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push(`${opts.method} ${String(url).split(`/guilds/${GUILD}/members/`)[1]}`);
      if (String(url).endsWith('/roles/bad')) return { ok: false, status: 403, text: async () => 'Missing Permissions' };
      return { ok: true, status: 204, text: async () => '' };
    }));
  });

  it('adds every target role, then removes only obsolete roles that are not targets', async () => {
    await expect(real.syncMemberRoles('d_1', ['r1', 'r2'], ['r_old', 'r2'])).resolves.toEqual({ granted: ['r1', 'r2'] });
    expect(calls).toEqual(['PUT d_1/roles/r1', 'PUT d_1/roles/r2', 'DELETE d_1/roles/r_old']);
  });

  it('still accepts a single role id', async () => {
    await real.syncMemberRoles('d_1', 'r1');
    expect(calls).toEqual(['PUT d_1/roles/r1']);
  });

  it('tries every role even after a failure, then throws with failedRoleIds', async () => {
    const err = await real.syncMemberRoles('d_1', ['bad', 'r2']).catch((e) => e);
    expect(calls).toEqual(['PUT d_1/roles/bad', 'PUT d_1/roles/r2']);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/\(403\)/);
    expect(err.failedRoleIds).toEqual(['bad']);
    expect(err.granted).toEqual(['r2']);
  });
});
