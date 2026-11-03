/**
 * Crossmint webhook event routing + row correlation for the documented
 * nfts.create.succeeded / nfts.create.failed events.
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  updateNftMint: vi.fn(), findMemberByEmail: vi.fn(), findMintByActionId: vi.fn(), findMintByTokenId: vi.fn(),
  findActiveMintByEmailAndTypeWithoutToken: vi.fn(), findActiveMintsByEmail: vi.fn(), updateDiscordSyncStatus: vi.fn(),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../discord-bot.js', () => ({ syncMemberRoles: vi.fn(), addRoleToMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onEntitlementActivated: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

import handler, { handleMintSuccess, handleMintFailure } from '../../webhooks/crossmint.js';
import * as db from '../db.js';
import { sendAlert } from '../alert.js';
import { syncMemberRoles } from '../discord-bot.js';

const SECRET = `whsec_${Buffer.from('events-test-key-abcdef0123456789').toString('base64')}`;
function signSvix({ secret, id, timestamp, body }) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` };
}
function fakeReq(body, headers) {
  const h = {};
  const req = { method: 'POST', headers, on(ev, cb) { h[ev] = cb; return req; } };
  Promise.resolve().then(() => { if (h.data) h.data(Buffer.from(body)); if (h.end) h.end(); });
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function deliver(event) {
  const body = JSON.stringify(event);
  const headers = signSvix({ secret: SECRET, id: 'msg_1', timestamp: Math.floor(Date.now() / 1000), body });
  const res = mockRes();
  await handler(fakeReq(body, headers), res);
  // waitUntil is stubbed to identity; let the detached handler settle.
  await new Promise((r) => setTimeout(r, 0));
  return res;
}

const ROW = { id: 'row_1', fields: { 'Email': 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Token ID': '' } };
const success = (over = {}) => ({
  type: 'nfts.create.succeeded',
  actionId: 'act_1',
  data: {
    chain: 'base', txId: '0xabc',
    collection: { id: 'col_insider', contractAddress: '0xc0' },
    recipient: { walletAddress: '0xwallet', email: 'buyer@example.com' },
    token: { id: 'nft_uuid', tokenId: '7' },
  },
  ...over,
});

const SAVED = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.CROSSMINT_WEBHOOK_SECRET = SECRET;
  process.env.CROSSMINT_COLLECTION_PRODUCT_A = 'col_insider';
  process.env.CROSSMINT_COLLECTION_PRODUCT_B = 'col_ember';
  process.env.DISCORD_ROLE_PRODUCT_A = 'role_insider';
  db.findMintByActionId.mockResolvedValue(null);
  db.findMintByTokenId.mockResolvedValue(null);
  db.findActiveMintByEmailAndTypeWithoutToken.mockResolvedValue(null);
  db.findActiveMintsByEmail.mockResolvedValue([]);
  db.findMemberByEmail.mockResolvedValue(null);
  db.updateNftMint.mockResolvedValue({});
  db.updateDiscordSyncStatus.mockResolvedValue({});
});
afterEach(() => { process.env = { ...SAVED }; });

describe('event routing', () => {
  it('nfts.create.succeeded with actionId act_1 updates the row found by action id with tokenId', async () => {
    db.findMintByActionId.mockResolvedValue(ROW);
    const res = await deliver(success());
    expect(res.statusCode).toBe(200);
    expect(db.findMintByActionId).toHaveBeenCalledWith('act_1');
    expect(db.updateNftMint).toHaveBeenCalledWith('row_1', expect.objectContaining({
      'Mint Status': 'Minted', 'Token ID': '7', 'Transaction Hash': '0xabc', 'Wallet Address': '0xwallet',
    }));
  });

  it('nfts.create.failed marks the row Failed and alerts', async () => {
    db.findMintByActionId.mockResolvedValue(ROW);
    const res = await deliver({
      type: 'nfts.create.failed', actionId: 'act_1',
      data: { collection: { id: 'col_insider' }, recipient: { email: 'buyer@example.com' },
        error: { reason: 'insufficient_funds', message: 'out of gas' } },
    });
    expect(res.statusCode).toBe(200);
    expect(db.updateNftMint).toHaveBeenCalledWith('row_1', {
      'Mint Status': 'Failed', 'Notes': 'Crossmint failed: out of gas', 'Last Error': 'insufficient_funds: out of gas',
    });
    expect(sendAlert).toHaveBeenCalledWith('crossmint.mint_failed_webhook', { actionId: 'act_1' }, { dedupeKey: 'act_1' });
  });

  it('unknown type → 200 and no DB write', async () => {
    const res = await deliver({ type: 'wallets.transfer.succeeded', actionId: 'act_9', data: {} });
    expect(res.statusCode).toBe(200);
    expect(db.updateNftMint).not.toHaveBeenCalled();
    expect(db.findMintByActionId).not.toHaveBeenCalled();
  });

  it('legacy names (action.succeeded) are ignored', async () => {
    await deliver({ type: 'action.succeeded', actionId: 'act_1', data: {} });
    expect(db.updateNftMint).not.toHaveBeenCalled();
  });
});

describe('correlation fallbacks', () => {
  it('falls back to Token ID = actionId (rows written before the action-id column)', async () => {
    db.findMintByTokenId.mockResolvedValue(ROW);
    await handleMintSuccess(success());
    expect(db.findMintByTokenId).toHaveBeenCalledWith('act_1');
    expect(db.updateNftMint).toHaveBeenCalledWith('row_1', expect.objectContaining({ 'Token ID': '7' }));
  });

  it('maps a dedicated collection id to its NFT type for the email lookup', async () => {
    db.findActiveMintByEmailAndTypeWithoutToken.mockResolvedValue(ROW);
    await handleMintSuccess(success());
    expect(db.findActiveMintByEmailAndTypeWithoutToken).toHaveBeenCalledWith('buyer@example.com', 'Aurevon Insider');
    expect(db.updateNftMint).toHaveBeenCalledWith('row_1', expect.objectContaining({ 'Mint Status': 'Minted' }));
  });

  it('shared collection: matches by email when exactly one active row has no token', async () => {
    process.env.CROSSMINT_COLLECTION_PRODUCT_B = 'col_insider'; // two NFTs share one collection
    db.findActiveMintsByEmail.mockResolvedValue([ROW, { id: 'row_2', fields: { 'Token ID': '3' } }]);
    await handleMintSuccess(success());
    expect(db.findActiveMintByEmailAndTypeWithoutToken).not.toHaveBeenCalled();
    expect(db.updateNftMint).toHaveBeenCalledWith('row_1', expect.objectContaining({ 'Mint Status': 'Minted' }));
  });

  it('shared collection with two token-less rows → unmatched alert, no write', async () => {
    process.env.CROSSMINT_COLLECTION_PRODUCT_B = 'col_insider';
    db.findActiveMintsByEmail.mockResolvedValue([ROW, { id: 'row_2', fields: { 'Token ID': null } }]);
    await handleMintSuccess(success());
    expect(db.updateNftMint).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('crossmint.webhook_unmatched', expect.objectContaining({ actionId: 'act_1' }), expect.anything());
  });

  it('falls back to token.id when tokenId is absent', async () => {
    db.findMintByActionId.mockResolvedValue(ROW);
    const ev = success(); delete ev.data.token.tokenId;
    await handleMintSuccess(ev);
    expect(db.updateNftMint).toHaveBeenCalledWith('row_1', expect.objectContaining({ 'Token ID': 'nft_uuid' }));
  });

  it('failure with no matching row alerts unmatched and still raises mint_failed', async () => {
    await handleMintFailure({ type: 'nfts.create.failed', actionId: 'act_404', data: { error: { message: 'x' } } });
    expect(db.updateNftMint).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith('crossmint.webhook_unmatched', expect.anything(), expect.anything());
    expect(sendAlert).toHaveBeenCalledWith('crossmint.mint_failed_webhook', { actionId: 'act_404' }, { dedupeKey: 'act_404' });
  });
});

describe('Discord grant after success', () => {
  beforeEach(() => { db.findMintByActionId.mockResolvedValue(ROW); });

  it('grants the role and marks synced when the member has a Discord ID', async () => {
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'd_1' } });
    db.findActiveMintsByEmail.mockResolvedValue([ROW]);
    await handleMintSuccess(success());
    expect(syncMemberRoles).toHaveBeenCalledWith('d_1', 'role_insider');
    expect(db.updateNftMint).toHaveBeenCalledWith('row_1', expect.objectContaining({ 'Discord Synced': true }));
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith('buyer@example.com', 'synced');
  });

  it('no Discord ID → sync pending, no grant', async () => {
    await handleMintSuccess(success());
    expect(syncMemberRoles).not.toHaveBeenCalled();
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith('buyer@example.com', 'pending');
  });

  it('grant failure → role_grant_failed alert + pending with error', async () => {
    db.findMemberByEmail.mockResolvedValue({ fields: { 'Discord ID': 'd_1' } });
    db.findActiveMintsByEmail.mockResolvedValue([ROW]);
    syncMemberRoles.mockRejectedValueOnce(new Error('Discord member d_1 not found in guild — they must join first'));
    await handleMintSuccess(success());
    expect(sendAlert).toHaveBeenCalledWith('discord.role_grant_failed', { roleKey: 'product_a_reward', status: 404 });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith('buyer@example.com', 'pending', expect.objectContaining({ error: expect.any(String) }));
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith('buyer@example.com', 'synced');
  });
});
