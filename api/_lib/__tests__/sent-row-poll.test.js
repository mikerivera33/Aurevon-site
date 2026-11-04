/**
 * Reconcile settles mints stuck in Sent by polling Crossmint (final fix 7).
 *
 * A row Crossmint accepted (Sent, action id stored) whose webhook never came
 * back is looked up with GET {base}/2022-06-09/actions/{actionId}:
 *   succeeded → the webhook's settleMintSucceeded (Minted + on-chain facts +
 *               Discord; a Revoked row keeps its status)
 *   failed    → settleMintFailed (Failed + retry-key suffix bump) + alert
 *   pending   → left alone
 *
 * Harness: real claim.js / webhooks/crossmint.js / crossmint.js; in-memory db,
 * faked Discord bot, alerts, Engage, Stripe SDK and fetch.
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

import { resetStore, applyEnv, installFetch } from './helpers/nft-harness.js';

const SAVED = { ...process.env };
const EMAIL = 'stuck.buyer@example.com';
let db;
let bot;
let sendAlert;
let claim;
let getMintAction;

beforeAll(async () => {
  applyEnv();
  db = await import('../db.js');
  bot = await import('../discord-bot.js');
  ({ sendAlert } = await import('../alert.js'));
  claim = await import('../../member/claim.js');
  ({ getMintAction } = await import('../crossmint.js'));
});
afterAll(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

beforeEach(() => {
  resetStore(store);
  applyEnv();
  vi.clearAllMocks();
  installFetch(store);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

async function runReconcile() {
  process.env.CRON_SECRET = 'cron_secret_abcdefghij';
  const res = mockRes();
  await claim.default({ method: 'GET', query: { action: 'reconcile' }, headers: { authorization: 'Bearer cron_secret_abcdefghij' } }, res);
  return res;
}

const sentRow = (id, actionId, extra = {}) => {
  const row = { id, fields: {
    'Reference': 'EMBER_003', 'Email': EMAIL, 'NFT Type': 'Aurevon Ember', 'Mint Status': 'Sent',
    'Crossmint Action ID': actionId, 'Token ID': actionId, 'Payment Transaction ID': `cs_${id}`, ...extra,
  } };
  store.mints.push(row);
  return row;
};
const actionCalls = () => store.calls.filter((c) => c.url.includes('/actions/'));
const alerted = (event) => sendAlert.mock.calls.filter(([e]) => e === event);

describe('reconcile polls Crossmint for rows stuck in Sent', () => {
  it('asks for Sent rows with an action id older than 60 min, 20 per run', async () => {
    await runReconcile();
    expect(db.listStuckSentMints).toHaveBeenCalledWith({ olderThanMinutes: 60, maxRecords: 20 });
  });

  it('succeeded → Minted with the on-chain facts, Discord granted (shared webhook path)', async () => {
    const row = sentRow('m1', 'act_ok');
    db.listStuckSentMints.mockResolvedValueOnce([row]);
    store.crossmintActions.act_ok = {
      status: 'succeeded',
      data: { txId: '0xfeed', recipient: { walletAddress: '0xw' }, token: { tokenId: '42' } },
    };
    store.members.set(EMAIL, { id: 'mem1', fields: { Email: EMAIL, 'Discord ID': 'd_1' } });
    db.findActiveMintsByEmail.mockResolvedValue([row]);

    const res = await runReconcile();

    const call = actionCalls()[0];
    expect(call.url).toMatch(/^https:\/\/(www|staging)\.crossmint\.com\/api\/2022-06-09\/actions\/act_ok$/);
    expect(call.method).toBe('GET');
    expect(row.fields).toEqual(expect.objectContaining({
      'Mint Status': 'Minted', 'Token ID': '42', 'Transaction Hash': '0xfeed', 'Wallet Address': '0xw',
    }));
    expect(bot.syncMemberRoles).toHaveBeenCalledWith('d_1', ['role_b'], []);
    expect(res.body.report.sentPoll).toEqual({ checked: 1, minted: 1, failed: 0, pending: 0, errors: 0 });
  });

  it('succeeded on a row Revoked meanwhile → status stays Revoked, nothing granted (finding 1)', async () => {
    const row = sentRow('m2', 'act_rev', { 'Mint Status': 'Revoked' });
    db.listStuckSentMints.mockResolvedValueOnce([row]);
    store.crossmintActions.act_rev = { status: 'succeeded', data: { txId: '0x1', token: { tokenId: '9' } } };

    await runReconcile();

    expect(row.fields['Mint Status']).toBe('Revoked');
    expect(row.fields['Token ID']).toBe('9');
    expect(bot.syncMemberRoles).not.toHaveBeenCalled();
    expect(alerted('crossmint.revoked_row_minted')).toHaveLength(1);
  });

  it('failed → Failed with the suffix bumped (next retry uses <txn>-r1) and an alert', async () => {
    const row = sentRow('m3', 'act_bad');
    db.listStuckSentMints.mockResolvedValueOnce([row]);
    store.crossmintActions.act_bad = { status: 'failed', data: { error: { reason: 'gas', message: 'out of gas' } } };

    const res = await runReconcile();

    expect(row.fields).toEqual(expect.objectContaining({
      'Mint Status': 'Failed', 'Mint Key Suffix': 1, 'Last Error': 'gas: out of gas',
    }));
    expect(alerted('reconcile.mint_failed')).toEqual([
      ['reconcile.mint_failed', { rowId: 'm3', actionId: 'act_bad' }, { dedupeKey: 'act_bad' }],
    ]);
    expect(res.body.report.sentPoll).toEqual(expect.objectContaining({ failed: 1 }));
  });

  it('pending → left alone', async () => {
    const row = sentRow('m4', 'act_wait');
    db.listStuckSentMints.mockResolvedValueOnce([row]);
    store.crossmintActions.act_wait = { status: 'pending' };

    const res = await runReconcile();

    expect(row.fields['Mint Status']).toBe('Sent');
    expect(db.updateNftMint).not.toHaveBeenCalledWith('m4', expect.anything());
    expect(res.body.report.sentPoll).toEqual({ checked: 1, minted: 0, failed: 0, pending: 1, errors: 0 });
  });

  it('a lookup error is reported per row; the row stays Sent and the run carries on', async () => {
    const lost = sentRow('m5', 'act_404');
    const ok = sentRow('m6', 'act_ok2');
    db.listStuckSentMints.mockResolvedValueOnce([lost, ok]);
    store.crossmintActions.act_ok2 = { status: 'succeeded', data: {} };

    const res = await runReconcile();

    expect(lost.fields['Mint Status']).toBe('Sent');
    expect(ok.fields['Mint Status']).toBe('Minted');
    expect(res.body.report.sentPoll).toEqual(expect.objectContaining({ checked: 2, minted: 1, errors: 1 }));
    expect(res.body.report.errors).toEqual(expect.arrayContaining(['poll mint=m5: Crossmint action lookup 404']));
  });

  it('a listStuckSentMints error is reported, not thrown', async () => {
    db.listStuckSentMints.mockRejectedValueOnce(new Error('db down'));
    const res = await runReconcile();
    expect(res.body.report.errors).toEqual(expect.arrayContaining(['listStuckSentMints: db down']));
  });
});

describe('getMintAction', () => {
  it('maps Crossmint statuses and sends the API key with an 8 s timeout', async () => {
    store.crossmintActions.a1 = { status: 'success', data: { txId: '0x' } };
    store.crossmintActions.a2 = { status: 'failed', error: { message: 'nope' } };
    store.crossmintActions.a3 = { status: 'in_progress' };
    const fetchSpy = globalThis.fetch;

    await expect(getMintAction('a1')).resolves.toEqual({
      status: 'succeeded', event: { type: 'nfts.create.succeeded', actionId: 'a1', data: { txId: '0x' } },
    });
    await expect(getMintAction('a2')).resolves.toEqual({
      status: 'failed', event: { type: 'nfts.create.failed', actionId: 'a2', data: { error: { message: 'nope' } } },
    });
    await expect(getMintAction('a3')).resolves.toEqual(expect.objectContaining({ status: 'pending' }));
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers['X-API-KEY']).toBe(process.env.CROSSMINT_API_KEY);
    expect(opts.signal).toBeInstanceOf(globalThis.AbortSignal);
  });

  it('throws without an API key, without an id, and on a non-2xx answer', async () => {
    await expect(getMintAction('missing')).rejects.toThrow('Crossmint action lookup 404');
    await expect(getMintAction('')).rejects.toThrow('actionId is required');
    delete process.env.CROSSMINT_API_KEY;
    await expect(getMintAction('a1')).rejects.toThrow('CROSSMINT_API_KEY not configured');
  });
});
