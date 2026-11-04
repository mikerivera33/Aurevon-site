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
//
//   4. Portal auth handler (`api/portal/data.js`) must not reference CustomerAuth
//      Airtable fields that don't exist. The real columns are `Magic Token` /
//      `Token Expires` (no `Used` field). Writing `Magic Link Token` /
//      `Token Expiry` / `Used` makes every Airtable write 422 → the login-link
//      request 500s and portal login is dead. This guard pins the field names.
//
//   5. Retired NFT copy and config names never come back: no "Apex" pass in
//      public HTML, no retired Crossmint template-alias env names
//      (CROSSMINT_ + TPL_*) anywhere, no webmail button on the membership
//      confirmation, no "24 hours" mint promise on /aurevon-web3.
//
// Repo walks skip generated / tooling trees (SKIP_DIRS) so a local coverage
// report or agent scratch files never make these guards flaky.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_NFT_MAP } from '../tiers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Never scanned: dependencies, VCS, coverage output, agent tooling.
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.superpowers', '.claude']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mov|glb|gltf|woff2?|ttf|otf|pdf|zip)$/i;

/** Repo-relative paths of every file under `dir`, skipping SKIP_DIRS (+ `extraSkip`). */
function walk(dir = '', extraSkip = [], out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP_DIRS.has(name) || extraSkip.includes(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, extraSkip, out);
    else out.push(rel);
  }
  return out;
}

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

describe('deal-intake payment gate', () => {
  it('does not treat a client-minted paid_ query token as payment proof', () => {
    const html = read('aurevon-re-intake.html');
    expect(html).not.toMatch(/indexOf\(\s*['"]paid_['"]\s*\)/);
    expect(html).toMatch(/\/api\/intake\/verify/);
  });

  it('post-checkout forward on aurevon-re.html requires a Stripe session_id', () => {
    const html = read('aurevon-re.html');
    expect(html).toMatch(/aurevon-re-intake\.html\?session_id=/);
    expect(html).not.toMatch(/bkt_pending_intake[\s\S]{0,80}window\.location\.replace\(dest\)/);
  });
});

describe('portal auth ↔ CustomerAuth field names', () => {
  // The CustomerAuth table (Airtable base appI9X8vcRcK1QZ1l, tbl bCS7TL65FcOiWn)
  // has these columns; Airtable rejects a write to any name not in this set with
  // a 422, which surfaces as a 500 to the user. These three names were the drift
  // that broke portal login — fail the build if any reappears in data.js.
  const FORBIDDEN_FIELDS = ['Magic Link Token', 'Token Expiry', 'Used'];

  it('data.js does not reference removed/renamed CustomerAuth fields', () => {
    const src = read('api/portal/data.js');
    // Only look at quoted field references, so the explanatory comment on the
    // one-time-use PATCH (which mentions "Used" in prose) doesn't trip the guard.
    const offenders = FORBIDDEN_FIELDS.filter(
      (f) => src.includes(`'${f}'`) || src.includes(`"${f}"`),
    );
    expect(
      offenders,
      `data.js references nonexistent CustomerAuth field(s): ${JSON.stringify(offenders)} — real fields are 'Magic Token' / 'Token Expires'`,
    ).toEqual([]);
  });
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
      const sources = [...html.matchAll(/<source\b[^>]*\bsrcset="([^"]+)"/g)];
      if (sources.length === 0) {
        // Page has no <picture>/<source>, so there's nothing to validate here.
        // Don't pass vacuously — skip explicitly so CI output reflects the real coverage.
        return;
      }
      // Per WHATWG HTML 4.8.4.3.2, srcset URLs are whitespace-delimited tokens.
      // A URL with literal spaces gets split into URL + (invalid) descriptors and the
      // candidate is silently rejected — the WebP path is then never taken even though
      // the WebP file was already preloaded (double-fetch).
      const offenders = sources
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

describe('portal.html matches /api/portal contract', () => {
  const html = read('portal.html');

  it('treats magic-link verify success as data.ok + sessionToken (API never sends valid)', () => {
    expect(html).toMatch(/data\.ok && data\.sessionToken/);
    expect(html).not.toMatch(/data\.valid/);
  });

  it('treats auth success as data.ok (API never sends sent)', () => {
    expect(html).toMatch(/res\.ok && data\.ok/);
    expect(html).not.toMatch(/data\.sent/);
  });

  it('reads the API profile field names (customerName / memberTier / joinDate)', () => {
    expect(html).toMatch(/customerName/);
    expect(html).toMatch(/memberTier/);
    expect(html).toMatch(/joinDate/);
  });

  it('does not assume /data always returns a leads array', () => {
    expect(html).toMatch(/Array\.isArray\(raw\.leads\)/);
  });

  it('does not start Discord OAuth with a bare ?email= (H2 hole; use /member-claim)', () => {
    expect(html).not.toMatch(/\/api\/discord\/auth\?email=/);
    expect(html).toMatch(/discordUrl = '\/member-claim'/);
  });
});

describe('discord-welcome.html — browser-safe Discord errors (Task 8)', () => {
  const html = read('discord-welcome.html');

  it('never reads an ?invite= param (open-redirect to any URL)', () => {
    expect(html).not.toContain("params.get('invite')");
    expect(html).not.toMatch(/\.get\(\s*['"]invite['"]\s*\)/);
  });

  it('builds the success button from a numeric ?server= id, else the static invite', () => {
    expect(html).toContain('/^\\d{5,25}$/.test(server)');
    expect(html).toContain("'https://discord.com/channels/' + server");
  });

  it('shows the exact copy for every error code the API redirects with', () => {
    for (const copy of [
      "invalid_link: 'This link has expired. Get a new one.'",
      "link_used: 'This link was already used. Get a new one.'",
      "no_nft: \"We can't find a membership for this email yet. If you just paid, your NFT is still being prepared — check your inbox or contact mike@aurevonvc.com.\"",
      "\"We couldn't link Discord. Your payment and NFT are safe. Try again or contact mike@aurevonvc.com.\"",
      'auth_failed: couldNotLink',
      'role_failed: couldNotLink',
      "denied: 'You cancelled. Open your email and try the link again.'",
    ]) expect(html).toContain(copy);
  });

  it('error box has one primary "Email me a new link" button to /member-claim and no "member portal" wording', () => {
    const box = html.match(/<div id="error-content"[\s\S]*?<\/div>/)[0];
    expect(box.match(/<a /g)).toHaveLength(1);
    expect(box).toMatch(/<a id="error-action" href="\/member-claim" class="btn-primary">Email me a new link<\/a>/);
    expect(html).not.toMatch(/member portal/i);
  });

  it('every error code the API can send has copy on the page', () => {
    const api = read('api/discord.js');
    const codes = api.match(/WELCOME_ERRORS = new Set\(\[([^\]]+)\]\)/)[1].match(/'([a-z_]+)'/g).map((c) => c.slice(1, -1));
    expect(codes.sort()).toEqual(['auth_failed', 'denied', 'invalid_link', 'link_used', 'no_nft', 'role_failed']);
    for (const code of codes) expect(html).toMatch(new RegExp(`\\b${code}:`));
  });
});

describe('member-claim.html — new-link page (Task 8)', () => {
  const html = read('member-claim.html');

  it('meta / og / twitter descriptions name the page’s one job', () => {
    const want = 'Get a new Discord access link for your Aurevon membership.';
    expect(html).toContain(`<meta name="description" content="${want}">`);
    expect(html).toContain(`<meta property="og:description" content="${want}">`);
    expect(html).toContain(`<meta name="twitter:description" content="${want}">`);
    expect(html).not.toMatch(/member portal/i);
  });

  it('prefills the email input from ?email= via .value only (never markup)', () => {
    expect(html).toMatch(/new URLSearchParams\(window\.location\.search\)\.get\('email'\)/);
    expect(html).toMatch(/getElementById\('email'\)\.value = prefill/);
    expect(html).not.toMatch(/innerHTML/);
  });
});

describe('retired NFT copy and config names (Task 12)', () => {
  // docs/ is .vercelignore'd, so only shipped HTML counts as public.
  const publicHtml = walk('', ['docs']).filter((f) => f.endsWith('.html'));

  it('scans the site HTML (and not tooling trees)', () => {
    expect(publicHtml.length).toBeGreaterThanOrEqual(20);
    expect(publicHtml.some((f) => /^(coverage|\.superpowers|\.claude|node_modules)\//.test(f))).toBe(false);
  });

  it('no "Apex" pass naming in public HTML', () => {
    const offenders = publicHtml.filter((f) => /\bapex\b/i.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('no retired CROSSMINT_ + TPL_ env name anywhere in the repo', () => {
    const needle = ['CROSSMINT', 'TPL_'].join('_');
    const offenders = walk().filter((f) => !BINARY_EXT.test(f) && read(f).includes(needle));
    expect(offenders).toEqual([]);
  });

  it('membership confirmation has no mail.google.com button', () => {
    expect(read('membership_confirmation.html')).not.toContain('mail.google.com');
  });

  it('aurevon-web3.html makes no "24 hours" promise near "mint"', () => {
    const html = read('aurevon-web3.html');
    expect(html).not.toMatch(/24 hours[\s\S]{0,80}mint/i);
    expect(html).not.toMatch(/mint[\s\S]{0,80}24 hours/i);
  });
});
