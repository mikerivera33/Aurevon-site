import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENTS,
  resolveEntitlementForNft,
  resolveRoleEnvForNft,
  mayGrant,
  grantableRoleEnvs,
  obsoleteRoleEnvs,
} from '../../../discord/entitlements.js';

const DAY = 86_400_000;
const mint = (nftType) => ({ fields: { 'NFT Type': nftType } });
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

describe('resolveRoleEnvForNft — exact, case-insensitive', () => {
  it('maps the five canonical NFT names', () => {
    expect(resolveRoleEnvForNft('001 Genesis')).toBe('DISCORD_ROLE_MONTHLY');
    expect(resolveRoleEnvForNft('004 chrome')).toBe('DISCORD_ROLE_LIFETIME');
    expect(resolveRoleEnvForNft('AUREVON INSIDER')).toBe('DISCORD_ROLE_PRODUCT_A');
    expect(resolveRoleEnvForNft('Aurevon Ember')).toBe('DISCORD_ROLE_PRODUCT_B');
    expect(resolveRoleEnvForNft('Aurevon Obsidian Executive')).toBe('DISCORD_ROLE_PRODUCT_C');
  });

  it('returns null for anything else — never a substring match', () => {
    expect(resolveRoleEnvForNft('Nope')).toBeNull();
    expect(resolveRoleEnvForNft('')).toBeNull();
    expect(resolveRoleEnvForNft(null)).toBeNull();
    expect(resolveRoleEnvForNft(undefined)).toBeNull();
    expect(resolveRoleEnvForNft('comm_monthly')).toBeNull();
    expect(resolveRoleEnvForNft('Genesis')).toBeNull();
    expect(resolveRoleEnvForNft('001 Genesis Deluxe')).toBeNull();
    expect(resolveRoleEnvForNft('Aurevon Obsidian')).toBeNull();
  });

  it('resolveEntitlementForNft returns the entitlement key', () => {
    expect(resolveEntitlementForNft('001 GENESIS')).toBe('monthly_membership');
    expect(resolveEntitlementForNft('x')).toBeNull();
  });

  it('every row carries a label for the bot UI', () => {
    expect(ENTITLEMENTS.map((e) => e.label)).toEqual(['Genesis', 'Chrome', 'Insider', 'Ember', 'Obsidian Executive']);
  });
});

describe('mayGrant', () => {
  it('refuses a cancelled monthly past the grace window', () => {
    expect(mayGrant({ key: 'monthly_membership', billingState: 'cancelled', endsAt: ago(30), graceDays: 7 })).toBe(false);
  });

  it('allows a cancelled monthly inside the grace window', () => {
    expect(mayGrant({ key: 'monthly_membership', billingState: 'cancelled', endsAt: ago(3), graceDays: 7 })).toBe(true);
  });

  it('refuses a non-active monthly with no end date', () => {
    expect(mayGrant({ key: 'monthly_membership', billingState: 'past_due', endsAt: null })).toBe(false);
  });

  it('allows active / trialing / unknown-yet (null) billing', () => {
    for (const billingState of ['active', 'trialing', null]) {
      expect(mayGrant({ key: 'monthly_membership', billingState, endsAt: ago(100) })).toBe(true);
    }
  });

  it('always allows permanent and lifetime passes', () => {
    for (const key of ['lifetime_membership', 'product_a_reward', 'product_b_reward', 'product_c_reward']) {
      expect(mayGrant({ key, billingState: 'cancelled', endsAt: ago(365) })).toBe(true);
    }
  });
});

describe('grantableRoleEnvs / obsoleteRoleEnvs', () => {
  const lapsed = { 'Billing State': 'cancelled', 'Entitlement Expires At': ago(30) };

  it('grants every pass the member holds, unique, in mint order', () => {
    const mints = [mint('004 Chrome'), mint('Aurevon Insider'), mint('004 chrome'), mint('Aurevon Ember')];
    expect(grantableRoleEnvs(mints, { 'Billing State': 'active' })).toEqual([
      'DISCORD_ROLE_LIFETIME', 'DISCORD_ROLE_PRODUCT_A', 'DISCORD_ROLE_PRODUCT_B',
    ]);
  });

  it('a lapsed monthly never hides a permanent pass, and is the only role removed', () => {
    const mints = [mint('001 Genesis'), mint('Aurevon Insider')];
    expect(grantableRoleEnvs(mints, lapsed)).toEqual(['DISCORD_ROLE_PRODUCT_A']);
    expect(obsoleteRoleEnvs(mints, lapsed)).toEqual(['DISCORD_ROLE_MONTHLY']);
  });

  it('never removes a permanent or lifetime pass role', () => {
    const mints = [mint('004 Chrome'), mint('Aurevon Obsidian Executive')];
    expect(obsoleteRoleEnvs(mints, lapsed)).toEqual([]);
  });

  it('removes nothing while the monthly is still grantable', () => {
    expect(obsoleteRoleEnvs([mint('001 Genesis')], { 'Billing State': 'active' })).toEqual([]);
    expect(grantableRoleEnvs([mint('001 Genesis')], { 'Billing State': 'active' })).toEqual(['DISCORD_ROLE_MONTHLY']);
  });

  it('ignores unknown NFT types and empty input', () => {
    expect(grantableRoleEnvs([mint('comm_monthly'), mint('Something Else')], {})).toEqual([]);
    expect(grantableRoleEnvs(null, null)).toEqual([]);
    expect(obsoleteRoleEnvs(undefined, undefined)).toEqual([]);
  });

  it('honours a custom grace window', () => {
    const fields = { 'Billing State': 'cancelled', 'Entitlement Expires At': ago(10) };
    expect(grantableRoleEnvs([mint('001 Genesis')], fields, 7)).toEqual([]);
    expect(grantableRoleEnvs([mint('001 Genesis')], fields, 14)).toEqual(['DISCORD_ROLE_MONTHLY']);
  });
});
