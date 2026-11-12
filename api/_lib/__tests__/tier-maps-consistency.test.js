/**
 * The three tier maps must agree:
 *   - api/stripe/checkout.js PRODUCT_CATALOG (prefixed checkout keys)
 *   - api/_lib/tiers.js TIER_NFT_MAP (bare _BASE keys + re_* aliases)
 *   - api/_lib/entitlements.js ENTITLEMENT_MAP (the five NFTs)
 * A key that mints in one map and not the other is how a buyer pays and gets
 * the wrong pass (or none). Only the five canonical NFTs may ever appear.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCT_CATALOG } from '../../stripe/checkout.js';
import { TIER_NFT_MAP, canonicalTier, isIntakeTier, INTAKE_TIERS } from '../tiers.js';
import { ENTITLEMENT_MAP, resolveEntitlementFromSku } from '../entitlements.js';
import { isIntakeTier as isIntakeTierReexport } from '../intake-verify.js';

const FIVE = ['Aurevon Insider', 'Aurevon Ember', 'Aurevon Obsidian Executive', '001 Genesis', '004 Chrome'];
const catalogKeys = Object.keys(PRODUCT_CATALOG);
const tierKeys = Object.keys(TIER_NFT_MAP); // _BASE + aliases (Proxy ownKeys)
const allKeys = [...new Set([...catalogKeys, ...tierKeys])];

describe('tier maps agree', () => {
  it('every checkout key is known to TIER_NFT_MAP', () => {
    for (const k of catalogKeys) expect(TIER_NFT_MAP[k], k).toBeDefined();
  });

  it.each(allKeys)('%s: TIER_NFT_MAP nft === ENTITLEMENT_MAP nftType', (k) => {
    const fromTiers = TIER_NFT_MAP[k]?.nft ?? null;
    const fromEntitlements = ENTITLEMENT_MAP[resolveEntitlementFromSku(k)]?.nftType ?? null;
    expect(fromTiers).toBe(fromEntitlements);
  });

  it.each(allKeys)('%s: serial prefixes agree', (k) => {
    const fromTiers = TIER_NFT_MAP[k]?.serialPrefix ?? null;
    const fromEntitlements = ENTITLEMENT_MAP[resolveEntitlementFromSku(k)]?.serialPrefix ?? null;
    expect(fromTiers).toBe(fromEntitlements);
  });

  it('only the five canonical NFTs appear anywhere', () => {
    const minted = new Set(allKeys.map((k) => TIER_NFT_MAP[k]?.nft).filter(Boolean));
    expect([...minted].sort()).toEqual([...FIVE].sort());
    expect(Object.values(ENTITLEMENT_MAP).map((c) => c.nftType).sort()).toEqual([...FIVE].sort());
  });

  it('no-NFT keys resolve to null in both maps', () => {
    const noNft = ['bogo', 're_bogo', 'single', 're_single', 'deal', ...allKeys.filter((k) => k.startsWith('addon_'))];
    expect(noNft.length).toBeGreaterThan(6);
    for (const k of noNft) {
      expect(TIER_NFT_MAP[k]?.nft ?? null, k).toBeNull();
      expect(resolveEntitlementFromSku(k), k).toBeNull();
    }
  });

  it('every Discord role and Crossmint collection env is checked by /api/health', () => {
    const health = readFileSync(fileURLToPath(new URL('../../health.js', import.meta.url)), 'utf8');
    for (const cfg of Object.values(ENTITLEMENT_MAP)) {
      expect(health, cfg.discordRoleEnv).toContain(`'${cfg.discordRoleEnv}'`);
      expect(health, cfg.collectionEnv).toContain(`'${cfg.collectionEnv}'`);
    }
  });
});

describe('tier helpers', () => {
  it('canonicalTier strips only a leading re_', () => {
    expect(canonicalTier('re_full')).toBe('full');
    expect(canonicalTier('re_retainer')).toBe('retainer');
    expect(canonicalTier('full')).toBe('full');
    expect(canonicalTier('comm_monthly')).toBe('comm_monthly');
    expect(canonicalTier('addon_rush')).toBe('addon_rush');
    expect(canonicalTier(null)).toBeNull();
    // every alias canonicalises to a _BASE key with the same mapping
    for (const k of tierKeys.filter((t) => t.startsWith('re_'))) {
      expect(TIER_NFT_MAP[canonicalTier(k)]).toBe(TIER_NFT_MAP[k]);
    }
  });

  it('isIntakeTier lives in tiers.js and is re-exported by intake-verify.js', () => {
    expect(isIntakeTierReexport).toBe(isIntakeTier);
    expect([...INTAKE_TIERS].sort()).toEqual(['bogo', 'deal', 'enterprise', 'full', 'retainer', 'single']);
    expect(isIntakeTier('re_full')).toBe(true);
    expect(isIntakeTier('comm_lifetime')).toBe(false);
    expect(isIntakeTier('addon_memo')).toBe(false);
  });
});
