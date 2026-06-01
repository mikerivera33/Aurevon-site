// Site-wide static guards.
//
// These tests exist to make recurring bug classes impossible to merge:
//
//   1. vercel.json rewrites with destinations ending in `.html` — these break
//      under `cleanUrls: true` (PR #9 fixed /success + /cancel; PR #14 fixed
//      /membership-confirmation; we don't want a 4th instance).
//
//   2. JSON-LD prices drifting from the canonical tier amounts in
//      `api/_lib/tiers.js` — pricing currently lives in 5 places (tiers.js,
//      visible UI, inline JS arg, data-amount, JSON-LD). This guard at least
//      anchors JSON-LD to tiers.js so search engines never advertise a price
//      the backend can't charge.
//
//   3. Hero `<img src>` ↔ `<link rel="preload">` href must be byte-identical
//      per page — a mismatch (encoding, leading slash, etc.) silently breaks
//      the preload optimization and can cause a double-fetch.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_NFT_MAP } from '../tiers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('vercel.json rewrites', () => {
  const vercel = JSON.parse(read('vercel.json'));

  it('no rewrite destination ends in `.html` (breaks under cleanUrls)', () => {
    const offenders = (vercel.rewrites || []).filter(
      (r) => /\.html(\?|$)/.test(r.destination) && !r.destination.startsWith('/api/'),
    );
    expect(offenders, `rewrites with .html destinations: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it('no rewrite has empty source/destination', () => {
    const bad = (vercel.rewrites || []).filter((r) => !r.source || !r.destination);
    expect(bad).toEqual([]);
  });
});

describe('JSON-LD pricing ↔ tiers.js', () => {
  // Build the canonical price set from tiers.js (`amount` field).
  // Normalize via Number().toString() to match the string form used in JSON-LD.
  const canonical = new Set();
  for (const cfg of Object.values(TIER_NFT_MAP)) {
    if (cfg && typeof cfg.amount === 'number') canonical.add(Number(cfg.amount).toString());
  }

  function extractJsonLdPrices(htmlPath) {
    const html = read(htmlPath);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const prices = new Set();
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.price === 'string' || typeof node.price === 'number') {
        prices.add(Number(node.price).toString());
      }
      Object.values(node).forEach(visit);
    };
    for (const m of blocks) visit(JSON.parse(m[1]));
    return prices;
  }

  for (const page of ['aurevon-re.html', 'aurevon-nft.html']) {
    it(`every price in ${page} JSON-LD matches a tiers.js amount`, () => {
      const ldPrices = extractJsonLdPrices(page);
      const drift = [...ldPrices].filter((p) => !canonical.has(p));
      expect(drift, `prices in ${page} JSON-LD that don't exist in tiers.js _BASE: ${JSON.stringify(drift)}`).toEqual([]);
    });
  }
});

describe('hero preload ↔ rendered image (img src or picture > source srcset)', () => {
  const pages = ['index.html', 'aurevon-web3.html', 'aurevon-nft.html'];

  // Normalize so '/assets/MAIN%20AUREVON%20HEADER.webp' (correctly %-encoded srcset)
  // matches '/assets/MAIN AUREVON HEADER.webp' (the same URL elsewhere, unencoded).
  // Without this, the guard masks a real bug: srcset literally splits on whitespace
  // per HTML5 spec, so a URL with literal spaces gets parsed as URL+invalid descriptors
  // and the candidate is rejected by every real browser.
  const normalize = (u) => {
    try { return decodeURIComponent(u); } catch { return u; }
  };

  for (const page of pages) {
    it(`${page}: every preload href appears as an actual rendered image URL`, () => {
      const html = read(page);
      const preloads = [...html.matchAll(/<link\s+rel="preload"[^>]*\bas="image"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
      const imgSrcs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
      // srcset is comma-separated; each is URL + optional Nx/Nw descriptor.
      // Strip the trailing descriptor (if any), but don't blindly split on whitespace —
      // a %-encoded URL has no spaces, but if someone slipped in a literal-space URL
      // the test below will catch it.
      const srcsets = [...html.matchAll(/<source\b[^>]*\bsrcset="([^"]+)"/g)]
        .flatMap((m) => m[1].split(',').map((part) =>
          part.trim().replace(/\s+\d+(?:\.\d+)?[wx]$/, '')
        ))
        .filter(Boolean);
      const rendered = new Set([...imgSrcs.map(normalize), ...srcsets.map(normalize)]);
      const missing = preloads.filter((href) => !rendered.has(normalize(href)));
      expect(missing, `${page} preload href(s) not rendered as <img src> or <source srcset>: ${JSON.stringify(missing)}`).toEqual([]);
    });

    it(`${page}: srcset URLs must not contain literal whitespace (use %20)`, () => {
      const html = read(page);
      // Per WHATWG HTML 4.8.4.3.2, srcset URLs are whitespace-delimited tokens.
      // A URL with literal spaces gets split into URL + (invalid) descriptors and the
      // candidate is silently rejected — the WebP path is then never taken even though
      // the WebP file was already preloaded (double-fetch).
      const offenders = [...html.matchAll(/<source\b[^>]*\bsrcset="([^"]+)"/g)]
        .flatMap((m) => m[1].split(',').map((part) => part.trim()))
        .filter((candidate) => {
          // Strip trailing Nx/Nw descriptor; if anything else has whitespace, it's a bad URL.
          const urlOnly = candidate.replace(/\s+\d+(?:\.\d+)?[wx]$/, '');
          return /\s/.test(urlOnly);
        });
      expect(offenders, `${page} srcset URL(s) contain literal whitespace (must use %20): ${JSON.stringify(offenders)}`).toEqual([]);
    });
  }
});
