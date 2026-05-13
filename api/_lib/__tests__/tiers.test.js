import { describe, it, expect } from 'vitest';
import { TIER_NFT_MAP, formatSerial, inferTierFromAmount, resolveTemplateId } from '../tiers.js';

describe('formatSerial', () => {
  it('pads numbers below 1000 to 3 digits', () => {
    expect(formatSerial('EMBER', 1)).toBe('EMBER_001');
    expect(formatSerial('INSIDER', 42)).toBe('INSIDER_042');
    expect(formatSerial('GENESIS', 999)).toBe('GENESIS_999');
  });

  it('does not pad numbers >= 1000', () => {
    expect(formatSerial('CHROME', 1000)).toBe('CHROME_1000');
    expect(formatSerial('OBSIDIAN', 1234)).toBe('OBSIDIAN_1234');
  });
});

describe('TIER_NFT_MAP', () => {
  it('resolves canonical base tiers', () => {
    expect(TIER_NFT_MAP['full'].nft).toBe('Aurevon Insider');
    expect(TIER_NFT_MAP['bogo'].nft).toBe('Aurevon Insider');
    expect(TIER_NFT_MAP['retainer'].nft).toBe('Aurevon Ember');
    expect(TIER_NFT_MAP['enterprise'].nft).toBe('Aurevon Obsidian Executive');
    expect(TIER_NFT_MAP['comm_monthly'].nft).toBe('001 Genesis');
    expect(TIER_NFT_MAP['comm_lifetime'].nft).toBe('004 Chrome');
  });

  it('resolves re_* alias tiers via proxy', () => {
    expect(TIER_NFT_MAP['re_full'].nft).toBe('Aurevon Insider');
    expect(TIER_NFT_MAP['re_bogo'].nft).toBe('Aurevon Insider');
    expect(TIER_NFT_MAP['re_retainer'].nft).toBe('Aurevon Ember');
    expect(TIER_NFT_MAP['re_enterprise'].nft).toBe('Aurevon Obsidian Executive');
  });

  it('resolves web3_* alias tiers via proxy', () => {
    expect(TIER_NFT_MAP['web3_starter'].nft).toBe('001 Genesis');
    expect(TIER_NFT_MAP['web3_growth'].nft).toBe('001 Genesis');
    expect(TIER_NFT_MAP['web3_scale'].nft).toBe('Aurevon Insider');
    expect(TIER_NFT_MAP['web3_enterprise'].nft).toBe('Aurevon Obsidian Executive');
  });

  it('returns undefined for unknown tiers', () => {
    expect(TIER_NFT_MAP['unknown_tier']).toBeUndefined();
  });

  it('single tier has no NFT', () => {
    expect(TIER_NFT_MAP['single'].nft).toBeNull();
    expect(TIER_NFT_MAP['re_single'].nft).toBeNull();
  });
});

describe('inferTierFromAmount', () => {
  it('infers correct tiers from exact amounts', () => {
    expect(inferTierFromAmount(18999)).toBe('single');   // $189.99
    expect(inferTierFromAmount(25000)).toBe('full');     // $250.00
    expect(inferTierFromAmount(29999)).toBe('bogo');     // $299.99
    expect(inferTierFromAmount(149900)).toBe('retainer'); // $1499.00
    expect(inferTierFromAmount(249900)).toBe('enterprise'); // $2499.00
    expect(inferTierFromAmount(2999)).toBe('comm_monthly');  // $29.99
    expect(inferTierFromAmount(34999)).toBe('comm_lifetime'); // $349.99
  });

  it('infers within $1 tolerance', () => {
    expect(inferTierFromAmount(25050)).toBe('full');  // $250.50 within $1 of $250
    expect(inferTierFromAmount(24950)).toBe('full');  // $249.50 within $1 of $250
  });

  it('returns null for unrecognized amounts', () => {
    expect(inferTierFromAmount(0)).toBeNull();
    expect(inferTierFromAmount(99900)).toBeNull();
  });
});

describe('resolveTemplateId', () => {
  it('returns null when templateKey is null or undefined', () => {
    expect(resolveTemplateId(null)).toBeNull();
    expect(resolveTemplateId(undefined)).toBeNull();
  });

  it('returns null when env var is not set', () => {
    expect(resolveTemplateId('CROSSMINT_TEMPLATE_NONEXISTENT')).toBeNull();
  });

  it('returns the env var value when set', () => {
    process.env.CROSSMINT_TEMPLATE_TEST = 'tmpl_abc123';
    expect(resolveTemplateId('CROSSMINT_TEMPLATE_TEST')).toBe('tmpl_abc123');
    delete process.env.CROSSMINT_TEMPLATE_TEST;
  });
});
