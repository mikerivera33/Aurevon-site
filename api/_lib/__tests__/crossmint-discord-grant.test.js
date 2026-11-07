/**
 * Crossmint mint-success must not re-grant Discord after a monthly cancel.
 *
 * OAuth (`api/discord.js`) and reconcile already use mayGrantPaidAccessFromMember.
 * handleMintSuccess did not, so a delayed action.succeeded / retry-mints
 * completion after customer.subscription.deleted restored the Genesis role
 * until the next daily reconcile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../airtable.js', () => ({
  updateNftMint: vi.fn().mockResolvedValue({}),
  findMemberByEmail: vi.fn(),
  listNftMints: vi.fn(),
  updateDiscordSyncStatus: vi.fn().mockResolvedValue({}),
  findActiveMintByEmail: vi.fn(),
}));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn().mockResolvedValue({}) }));
vi.mock('../engage.js', () => ({ onEntitlementActivated: vi.fn().mockResolvedValue({}) }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p) => p }));

import { handleMintSuccess } from '../../webhooks/crossmint.js';
import * as airtable from '../airtable.js';
import * as discordBot from '../discord-bot.js';

const EMAIL = 'member@example.com';
const SAVED = { ...process.env };

function genesisMint() {
  return {
    id: 'recGenesis',
    fields: {
      Email: EMAIL,
      'NFT Type': '001 Genesis',
      Reference: 'GENESIS_001',
      'Token ID': 'act_genesis',
    },
  };
}

function insiderMint() {
  return {
    id: 'recInsider',
    fields: {
      Email: EMAIL,
      'NFT Type': 'Aurevon Insider',
      Reference: 'INSIDER_001',
      'Token ID': 'act_insider',
    },
  };
}

function eventFor(mintId) {
  return { type: 'action.succeeded', data: { id: mintId, actionId: mintId } };
}

function member({ billingState, endsAt = null, discordId = 'discord_1' }) {
  return {
    id: 'recMember',
    fields: {
      Email: EMAIL,
      'Discord ID': discordId,
      'Billing State': billingState,
      'Entitlement Expires At': endsAt,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_ROLE_MONTHLY = 'role_monthly';
  process.env.DISCORD_ROLE_PRODUCT_A = 'role_insider';
  process.env.DISCORD_ROLE_LIFETIME = 'role_chrome';
  airtable.listNftMints.mockResolvedValue([genesisMint()]);
  airtable.findActiveMintByEmail.mockResolvedValue(null);
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('Crossmint handleMintSuccess Discord grant', () => {
  it('does not re-grant Genesis after monthly cancel with no paid-through date', async () => {
    airtable.findMemberByEmail.mockResolvedValue(member({ billingState: 'cancelled', endsAt: null }));

    await handleMintSuccess(eventFor('act_genesis'));

    expect(discordBot.addRoleToMember).not.toHaveBeenCalled();
    expect(airtable.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'revoked');
  });

  it('does not re-grant Genesis after cancel + grace has elapsed', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    airtable.findMemberByEmail.mockResolvedValue(member({ billingState: 'cancelled', endsAt: past }));

    await handleMintSuccess(eventFor('act_genesis'));

    expect(discordBot.addRoleToMember).not.toHaveBeenCalled();
    expect(airtable.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'revoked');
  });

  it('grants Genesis while monthly billing is active', async () => {
    airtable.findMemberByEmail.mockResolvedValue(member({ billingState: 'active' }));

    await handleMintSuccess(eventFor('act_genesis'));

    expect(discordBot.addRoleToMember).toHaveBeenCalledWith('discord_1', 'role_monthly');
    expect(airtable.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced');
  });

  it('still grants a permanent Insider pass when monthly billing is cancelled', async () => {
    airtable.listNftMints.mockResolvedValue([insiderMint()]);
    airtable.findMemberByEmail.mockResolvedValue(member({ billingState: 'cancelled', endsAt: null }));

    await handleMintSuccess(eventFor('act_insider'));

    expect(discordBot.addRoleToMember).toHaveBeenCalledWith('discord_1', 'role_insider');
    expect(airtable.updateDiscordSyncStatus).toHaveBeenCalledWith(EMAIL, 'synced');
  });
});
