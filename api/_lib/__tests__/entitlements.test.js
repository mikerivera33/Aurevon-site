import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_MAP,
  resolveEntitlementFromSku,
  resolveEntitlementFromNftType,
  shouldRevokeAccess,
  mayGrantPaidAccess,
  mayGrantPaidAccessFromMember,
  buildMintRecipient,
  pickGrantableMint,
  UNKNOWN_BILLING_FIELDS,
} from '../entitlements.js';

describe('ENTITLEMENT_MAP', () => {
  it('has all five entitlement types', () => {
    const keys = Object.keys(ENTITLEMENT_MAP);
    expect(keys).toContain('monthly_membership');
    expect(keys).toContain('lifetime_membership');
    expect(keys).toContain('product_a_reward');
    expect(keys).toContain('product_b_reward');
    expect(keys).toContain('product_c_reward');
  });

  it('each entitlement has required fields', () => {
    for (const [key, cfg] of Object.entries(ENTITLEMENT_MAP)) {
      expect(cfg.skus, `${key} missing skus`).toBeDefined();
      expect(cfg.nftType, `${key} missing nftType`).toBeDefined();
      expect(cfg.serialPrefix, `${key} missing serialPrefix`).toBeDefined();
      expect(cfg.discordRoleEnv, `${key} missing discordRoleEnv`).toBeDefined();
    }
  });
});

describe('resolveEntitlementFromSku', () => {
  it('resolves canonical SKUs', () => {
    expect(resolveEntitlementFromSku('comm_monthly')).toBe('monthly_membership');
    expect(resolveEntitlementFromSku('comm_lifetime')).toBe('lifetime_membership');
    expect(resolveEntitlementFromSku('full')).toBe('product_a_reward');
    expect(resolveEntitlementFromSku('retainer')).toBe('product_b_reward');
    expect(resolveEntitlementFromSku('enterprise')).toBe('product_c_reward');
  });

  it('resolves re_* SKU aliases', () => {
    expect(resolveEntitlementFromSku('re_full')).toBe('product_a_reward');
    expect(resolveEntitlementFromSku('re_retainer')).toBe('product_b_reward');
    expect(resolveEntitlementFromSku('re_enterprise')).toBe('product_c_reward');
  });

  it('web3_* SKUs are no longer aliased (archived 2026-06-02)', () => {
    // See api/_lib/_archived/web3-subscription-tiers.js for re-activation steps.
    expect(resolveEntitlementFromSku('web3_starter')).toBeNull();
    expect(resolveEntitlementFromSku('web3_growth')).toBeNull();
    expect(resolveEntitlementFromSku('web3_scale')).toBeNull();
    expect(resolveEntitlementFromSku('web3_enterprise')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(resolveEntitlementFromSku('FULL')).toBe('product_a_reward');
    expect(resolveEntitlementFromSku('Retainer')).toBe('product_b_reward');
  });

  it('returns null for unknown SKUs', () => {
    expect(resolveEntitlementFromSku('unknown')).toBeNull();
    expect(resolveEntitlementFromSku('')).toBeNull();
    expect(resolveEntitlementFromSku(null)).toBeNull();
  });

  it('returns null for no-NFT SKUs (Second Opinion, BOGO)', () => {
    expect(resolveEntitlementFromSku('re_single')).toBeNull();
    expect(resolveEntitlementFromSku('single')).toBeNull();
    expect(resolveEntitlementFromSku('bogo')).toBeNull();
    expect(resolveEntitlementFromSku('re_bogo')).toBeNull();
  });
});

describe('resolveEntitlementFromNftType', () => {
  it('resolves known NFT types', () => {
    expect(resolveEntitlementFromNftType('001 Genesis')).toBe('monthly_membership');
    expect(resolveEntitlementFromNftType('004 Chrome')).toBe('lifetime_membership');
    expect(resolveEntitlementFromNftType('Aurevon Insider')).toBe('product_a_reward');
    expect(resolveEntitlementFromNftType('Aurevon Ember')).toBe('product_b_reward');
    expect(resolveEntitlementFromNftType('Aurevon Obsidian Executive')).toBe('product_c_reward');
  });

  it('is case-insensitive', () => {
    expect(resolveEntitlementFromNftType('001 genesis')).toBe('monthly_membership');
    expect(resolveEntitlementFromNftType('AUREVON INSIDER')).toBe('product_a_reward');
  });

  it('returns null for unknown types', () => {
    expect(resolveEntitlementFromNftType('Unknown NFT')).toBeNull();
    expect(resolveEntitlementFromNftType('')).toBeNull();
    expect(resolveEntitlementFromNftType(null)).toBeNull();
  });
});

describe('shouldRevokeAccess', () => {
  it('never revokes if revokeOnCancel is false', () => {
    expect(shouldRevokeAccess({
      membershipMode: 'permanent',
      revokeOnCancel: false,
      billingState: 'cancelled',
      endsAt: null,
    })).toBe(false);
  });

  it('never revokes non-recurring memberships', () => {
    expect(shouldRevokeAccess({
      membershipMode: 'lifetime',
      revokeOnCancel: true,
      billingState: 'cancelled',
      endsAt: null,
    })).toBe(false);
  });

  it('does not revoke active recurring membership', () => {
    expect(shouldRevokeAccess({
      membershipMode: 'recurring',
      revokeOnCancel: true,
      billingState: 'active',
      endsAt: null,
    })).toBe(false);
  });

  it('revokes when no endsAt date', () => {
    expect(shouldRevokeAccess({
      membershipMode: 'recurring',
      revokeOnCancel: true,
      billingState: 'cancelled',
      endsAt: null,
    })).toBe(true);
  });

  it('does not revoke within grace period', () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString(); // 3 days from now
    expect(shouldRevokeAccess({
      membershipMode: 'recurring',
      revokeOnCancel: true,
      billingState: 'cancelled',
      endsAt: future,
      gracePeriodDays: 7,
    })).toBe(false);
  });

  it('revokes after grace period expires', () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString(); // 10 days ago
    expect(shouldRevokeAccess({
      membershipMode: 'recurring',
      revokeOnCancel: true,
      billingState: 'cancelled',
      endsAt: past,
      gracePeriodDays: 7,
    })).toBe(true);
  });
});

describe('mayGrantPaidAccess', () => {
  it('always grants permanent product NFTs even if billing looks cancelled', () => {
    expect(mayGrantPaidAccess({
      entitlementKey: 'product_a_reward',
      billingState: 'cancelled',
      endsAt: null,
    })).toBe(true);
  });

  it('always grants lifetime membership', () => {
    expect(mayGrantPaidAccess({
      entitlementKey: 'lifetime_membership',
      billingState: 'cancelled',
      endsAt: null,
    })).toBe(true);
  });

  it('grants monthly when billing fields are missing (fresh purchase race)', () => {
    expect(mayGrantPaidAccess({
      entitlementKey: 'monthly_membership',
      billingState: null,
      endsAt: null,
    })).toBe(true);
  });

  it('grants monthly while billing is active', () => {
    expect(mayGrantPaidAccess({
      entitlementKey: 'monthly_membership',
      billingState: 'active',
      endsAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    })).toBe(true);
  });

  it('grants monthly during the post-cancel grace window', () => {
    const recentEnd = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(mayGrantPaidAccess({
      entitlementKey: 'monthly_membership',
      billingState: 'cancelled',
      endsAt: recentEnd,
      gracePeriodDays: 7,
    })).toBe(true);
  });

  it('refuses monthly after cancel + grace — the claim+OAuth re-grant hole', () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(mayGrantPaidAccess({
      entitlementKey: 'monthly_membership',
      billingState: 'cancelled',
      endsAt: past,
      gracePeriodDays: 7,
    })).toBe(false);
  });

  it('refuses monthly cancelled with no endsAt (immediate revoke)', () => {
    expect(mayGrantPaidAccess({
      entitlementKey: 'monthly_membership',
      billingState: 'cancelled',
      endsAt: null,
    })).toBe(false);
  });

  it('mayGrantPaidAccessFromMember reads Airtable field names', () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(mayGrantPaidAccessFromMember('monthly_membership', {
      'Billing State': 'cancelled',
      'Entitlement Expires At': past,
    })).toBe(false);
    expect(mayGrantPaidAccessFromMember('product_a_reward', {
      'Billing State': 'cancelled',
    })).toBe(true);
  });
});

describe('buildMintRecipient', () => {
  it('returns an email recipient string (lower-cased, trimmed) when no wallet', () => {
    expect(buildMintRecipient({ email: ' User@Example.com ' })).toBe('email:user@example.com:base');
  });

  it('returns a chain:wallet recipient string when wallet provided', () => {
    expect(buildMintRecipient({ email: 'user@example.com', walletAddress: '0xABC' })).toBe('base:0xABC');
  });

  it('uses custom chain when provided', () => {
    expect(buildMintRecipient({ email: 'user@example.com', chain: 'ethereum' })).toBe('email:user@example.com:ethereum');
  });

  it('uses CROSSMINT_CHAIN env var when set', () => {
    process.env.CROSSMINT_CHAIN = 'polygon';
    const result = buildMintRecipient({ email: 'user@example.com' });
    delete process.env.CROSSMINT_CHAIN;
    expect(result).toBe('email:user@example.com:polygon');
  });

  it('defaults to base-sepolia on staging', () => {
    const saved = process.env.CROSSMINT_ENV;
    process.env.CROSSMINT_ENV = 'staging';
    const result = buildMintRecipient({ email: 'user@example.com' });
    if (saved === undefined) delete process.env.CROSSMINT_ENV; else process.env.CROSSMINT_ENV = saved;
    expect(result).toBe('email:user@example.com:base-sepolia');
  });
});

describe('pickGrantableMint', () => {
  const genesis = { id: 'g', fields: { 'NFT Type': '001 Genesis' } };
  const insider = { id: 'i', fields: { 'NFT Type': 'Aurevon Insider' } };
  const lapsed = { 'Billing State': 'cancelled', 'Entitlement Expires At': '2020-01-01T00:00:00Z' };

  it('a lapsed Genesis row does not hide a permanent pass', () => {
    expect(pickGrantableMint([genesis, insider], lapsed)).toBe(insider);
  });
  it('returns null when the only pass is a lapsed monthly one', () => {
    expect(pickGrantableMint([genesis], lapsed)).toBeNull();
  });
  it('grants an active monthly membership', () => {
    expect(pickGrantableMint([genesis], { 'Billing State': 'active' })).toBe(genesis);
  });
  it('fails closed for monthly but not permanent when billing is unknown', () => {
    expect(pickGrantableMint([genesis], UNKNOWN_BILLING_FIELDS)).toBeNull();
    expect(pickGrantableMint([genesis, insider], UNKNOWN_BILLING_FIELDS)).toBe(insider);
  });
});
