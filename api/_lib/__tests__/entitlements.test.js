import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_MAP,
  resolveEntitlementFromSku,
  resolveEntitlementFromNftType,
  shouldRevokeAccess,
  buildMintRecipient,
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
    expect(resolveEntitlementFromSku('bogo')).toBe('product_a_reward');
    expect(resolveEntitlementFromSku('retainer')).toBe('product_b_reward');
    expect(resolveEntitlementFromSku('enterprise')).toBe('product_c_reward');
  });

  it('resolves re_* SKU aliases', () => {
    expect(resolveEntitlementFromSku('re_full')).toBe('product_a_reward');
    expect(resolveEntitlementFromSku('re_bogo')).toBe('product_a_reward');
    expect(resolveEntitlementFromSku('re_retainer')).toBe('product_b_reward');
    expect(resolveEntitlementFromSku('re_enterprise')).toBe('product_c_reward');
  });

  it('resolves web3_* SKU aliases', () => {
    expect(resolveEntitlementFromSku('web3_starter')).toBe('monthly_membership');
    expect(resolveEntitlementFromSku('web3_growth')).toBe('monthly_membership');
    expect(resolveEntitlementFromSku('web3_scale')).toBe('product_a_reward');
    expect(resolveEntitlementFromSku('web3_enterprise')).toBe('product_c_reward');
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

  it('returns null for no-NFT SKU (re_single)', () => {
    expect(resolveEntitlementFromSku('re_single')).toBeNull();
    expect(resolveEntitlementFromSku('single')).toBeNull();
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

describe('buildMintRecipient', () => {
  it('returns email-based recipient when no wallet', () => {
    const result = buildMintRecipient({ email: 'user@example.com' });
    expect(result.email).toBe('user@example.com');
    expect(result.chain).toBe('base');
  });

  it('returns wallet-based recipient when wallet provided', () => {
    const result = buildMintRecipient({ email: 'user@example.com', walletAddress: '0xABC' });
    expect(result.walletAddress).toBe('0xABC');
    expect(result.chain).toBe('base');
    expect(result.email).toBeUndefined();
  });

  it('uses custom chain when provided', () => {
    const result = buildMintRecipient({ email: 'user@example.com', chain: 'ethereum' });
    expect(result.chain).toBe('ethereum');
  });

  it('uses CROSSMINT_CHAIN env var when set', () => {
    process.env.CROSSMINT_CHAIN = 'polygon';
    const result = buildMintRecipient({ email: 'user@example.com' });
    expect(result.chain).toBe('polygon');
    delete process.env.CROSSMINT_CHAIN;
  });
});
