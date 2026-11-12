/**
 * Crossmint request contract.
 *
 * The idempotent mint is PUT {base}/2022-06-09/collections/{collectionId}/nfts/{key}
 * and its body schema is additionalProperties:false — only recipient (a STRING),
 * metadata, sendNotification, locale, reuploadLinkedFiles, compressed. An object
 * recipient or a templateId makes every mint 400. This pins the request shape for
 * all five canonical NFTs, the art each one carries, and that no buyer PII is sent
 * into on-chain metadata.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ENTITLEMENT_MAP } from '../entitlements.js';

const SAVED = { ...process.env };
let calls;
let crossmint;

const IPFS = {
  INSIDER:  'https://gateway.pinata.cloud/ipfs/bafkreidla5efyue3p23ta6djte7kps4e4aohaxuij7yc2eiundhv3pasty',
  EMBER:    'https://gateway.pinata.cloud/ipfs/bafkreifon655t7ru5vrcpnnhsodjal3jb323cjubfx7na4fnp22n6tdb54',
  OBSIDIAN: 'https://gateway.pinata.cloud/ipfs/bafkreie7rhy5sibiocfu5cq7hhwf52tdzgesk3brmj753v2xgulannwsy4',
  GENESIS:  'https://gateway.pinata.cloud/ipfs/bafkreihwovvborajwrljjuiaxhk2lev2l2nxlf5fy27yfh3p74cugt5tfi',
  CHROME:   'https://gateway.pinata.cloud/ipfs/bafkreic3bi6gpnbhgsncizriwbpcniceipxlzn254zdgvzzilfojajlin4',
};

const NFTS = [
  ['Aurevon Insider', 'INSIDER', 'Full Package'],
  ['Aurevon Ember', 'EMBER', 'Pro Retainer'],
  ['Aurevon Obsidian Executive', 'OBSIDIAN', 'Enterprise'],
  ['001 Genesis', 'GENESIS', 'Community Monthly'],
  ['004 Chrome', 'CHROME', 'Community Lifetime'],
];

beforeEach(async () => {
  calls = [];
  for (const cfg of Object.values(ENTITLEMENT_MAP)) delete process.env[cfg.collectionEnv];
  delete process.env.CROSSMINT_ENV;
  delete process.env.CROSSMINT_CHAIN;
  process.env.CROSSMINT_API_KEY = 'ck_test_key';
  process.env.CROSSMINT_COLLECTION_ID = 'col_shared';
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ actionId: 'act_1', id: 'nft_1', onChain: { tokenId: '7' } }) };
  }));
  vi.resetModules();
  crossmint = await import('../crossmint.js');
});
afterEach(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

describe('mintToEmail request contract', () => {
  it.each(NFTS)('%s: one documented PUT with a string recipient and the pass art', async (nftType, art, label) => {
    const res = await crossmint.mintToEmail({
      email: 'Buyer@Example.com', nftType, serial: 'X_001', idempotencyKey: 'cs_live_abc',
      // legacy fields still passed by webhooks — must be ignored
      customerName: 'Jane Buyer', templateKey: 'CROSSMINT_TEMPLATE_INSIDER', collectionName: 'Wrong', tierKey: 'bogo',
    });

    expect(calls).toHaveLength(1);
    const { url, opts } = calls[0];
    expect(opts.method).toBe('PUT');
    expect(url).toBe('https://www.crossmint.com/api/2022-06-09/collections/col_shared/nfts/cs_live_abc');
    expect(opts.headers['X-API-KEY']).toBe('ck_test_key');
    expect(opts.signal).toBeDefined();

    const body = JSON.parse(opts.body);
    expect(Object.keys(body)).toEqual(['recipient', 'metadata', 'sendNotification', 'reuploadLinkedFiles']);
    expect(body.recipient).toBe('email:buyer@example.com:base');
    expect(body.templateId).toBeUndefined();
    expect(body.metadata.name).toBe(`Aurevon ${art} Pass`);
    expect(body.metadata.image).toBe(IPFS[art]);

    const attrs = Object.fromEntries(body.metadata.attributes.map((a) => [a.trait_type, a.value]));
    expect(attrs.Customer).toBeUndefined();
    expect(attrs.Tier).toBe(nftType);
    expect(attrs['Access Level']).toBe(label);
    expect(attrs.Category).toBe(art);
    expect(attrs.Serial).toBe('X_001');
    const key = Object.keys(ENTITLEMENT_MAP).find((k) => ENTITLEMENT_MAP[k].nftType === nftType);
    expect(attrs.Collection).toBe(ENTITLEMENT_MAP[key].collectionName);

    // No buyer PII anywhere in on-chain metadata.
    const meta = JSON.stringify(body.metadata).toLowerCase();
    expect(meta).not.toContain('buyer@example.com');
    expect(meta).not.toContain('jane');

    expect(res).toEqual({ ok: true, actionId: 'act_1', id: 'nft_1', tokenId: '7', imageUrl: IPFS[art] });
  });

  it('description carries the serial, and omits it (never "Serial: null") when none was reserved', async () => {
    await crossmint.mintToEmail({ email: 'b@example.com', nftType: 'Aurevon Ember', serial: 'EMBER_007', idempotencyKey: 'ks1' });
    await crossmint.mintToEmail({ email: 'b@example.com', nftType: 'Aurevon Ember', serial: null, idempotencyKey: 'ks2' });
    expect(JSON.parse(calls[0].opts.body).metadata.description).toContain('Serial: EMBER_007.');
    const bare = JSON.parse(calls[1].opts.body).metadata.description;
    expect(bare).not.toMatch(/Serial|null|undefined/);
    expect(bare).toMatch(/Base Ethereum L2\.$/);
  });

  it('Obsidian carries the Executive rarity', async () => {
    await crossmint.mintToEmail({ email: 'b@example.com', nftType: 'Aurevon Obsidian Executive', serial: 'O_1', idempotencyKey: 'k1' });
    const attrs = JSON.parse(calls[0].opts.body).metadata.attributes;
    expect(attrs.find((a) => a.trait_type === 'Rarity').value).toBe('Executive');
  });

  it('a per-entitlement collection env wins over the shared collection', async () => {
    process.env.CROSSMINT_COLLECTION_PRODUCT_B = 'col_b';
    await crossmint.mintToEmail({ email: 'b@example.com', nftType: 'Aurevon Ember', serial: 'E_1', idempotencyKey: 'k2' });
    expect(calls[0].url).toBe('https://www.crossmint.com/api/2022-06-09/collections/col_b/nfts/k2');
  });

  it('a wallet recipient is chain:address', async () => {
    await crossmint.mintToEmail({ email: 'b@example.com', walletAddress: '0xABC', nftType: '004 Chrome', serial: 'C_1', idempotencyKey: 'k3' });
    expect(JSON.parse(calls[0].opts.body).recipient).toBe('base:0xABC');
  });

  it('rejects an unknown NFT type and never falls back to Genesis', async () => {
    await expect(crossmint.mintToEmail({ email: 'b@example.com', nftType: 'Nope', idempotencyKey: 'k' })).rejects.toThrow(/Unknown NFT type/);
    expect(calls).toHaveLength(0);
  });

  it('throws when neither the entitlement collection nor CROSSMINT_COLLECTION_ID is set', async () => {
    delete process.env.CROSSMINT_COLLECTION_ID;
    await expect(crossmint.mintToEmail({ email: 'b@example.com', nftType: '001 Genesis', idempotencyKey: 'k' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('an aborted / timed-out fetch returns { ok:false, error:"Crossmint timeout" }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }));
    const res = await crossmint.mintToEmail({ email: 'b@example.com', nftType: 'Aurevon Insider', serial: 'I_1', idempotencyKey: 'k4' });
    expect(res).toEqual({ ok: false, error: 'Crossmint timeout' });
  });

  it('a non-2xx response returns ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ message: 'bad body' }) })));
    const res = await crossmint.mintToEmail({ email: 'b@example.com', nftType: 'Aurevon Insider', serial: 'I_1', idempotencyKey: 'k5' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('bad body');
  });

  it('staging env targets the staging host and base-sepolia', async () => {
    process.env.CROSSMINT_ENV = 'staging';
    vi.resetModules();
    const staging = await import('../crossmint.js');
    await staging.mintToEmail({ email: 'b@example.com', nftType: '001 Genesis', serial: 'G_1', idempotencyKey: 'k6' });
    expect(calls[0].url).toBe('https://staging.crossmint.com/api/2022-06-09/collections/col_shared/nfts/k6');
    expect(JSON.parse(calls[0].opts.body).recipient).toBe('email:b@example.com:base-sepolia');
  });
});

describe('helpers', () => {
  it('passArtKeyForNft maps only the five NFTs', () => {
    for (const [nftType, art] of NFTS) expect(crossmint.passArtKeyForNft(nftType)).toBe(art);
    expect(crossmint.passArtKeyForNft('bogo')).toBeNull();
    expect(crossmint.passArtKeyForNft('Second Opinion')).toBeNull();
  });

  it('accessLabelForEntitlement returns the entitlement label', () => {
    expect(crossmint.accessLabelForEntitlement('product_a_reward')).toBe('Full Package');
    expect(crossmint.accessLabelForEntitlement('product_b_reward')).toBe('Pro Retainer');
    expect(crossmint.accessLabelForEntitlement('product_c_reward')).toBe('Enterprise');
    expect(crossmint.accessLabelForEntitlement('monthly_membership')).toBe('Community Monthly');
    expect(crossmint.accessLabelForEntitlement('lifetime_membership')).toBe('Community Lifetime');
    expect(crossmint.accessLabelForEntitlement('deal')).toBeNull();
  });
});
