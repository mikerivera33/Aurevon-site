// Shared motion background guards.
//
// The storm ported from labs.aurevonvc.com lives in /motion and is wired into
// every public page by two insertions (a stylesheet link before </head> and
// four script tags before </body>). These guards keep that wiring from
// silently rotting:
//
//   1. Every public HTML page carries the stylesheet and all four scripts in
//      the documented order; admin consoles are deliberately excluded.
//   2. The files those tags point at exist, and the ES-module chain
//      (motion-bg-3d.js → scene3d.js → vendor/three.module.min.js →
//      three.core.min.js) is intact — a missing sibling 404s at runtime and
//      the scene silently never initialises.
//   3. /motion caching: bootstraps revalidate on every load (an update can
//      never mix old and new files), vendor/ keeps a long cache.
//   4. Every canvas layer the bootstrap creates is aria-hidden, and the
//      stylesheet carries a prefers-reduced-motion block.
//   5. Every file matches motion/MANIFEST.json (sha256) and the manifest
//      version matches the bootstrap's VERSION, so a half-applied package
//      change (one file edited, manifest not regenerated, or a copy synced
//      from Forge-ai only partly) fails here.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Internal operator consoles: no storm on data-heavy admin screens.
const ADMIN_PAGES = new Set(['operator.html', 'aurevon-crm.html']);

const TAGS = [
  '<link rel="stylesheet" href="/motion/motion-bg.css">',
  '<script src="/motion/ticker.js" defer></script>',
  '<script src="/motion/lightning.js" defer></script>',
  '<script src="/motion/motion-bg.js" defer></script>',
  '<script type="module" src="/motion/motion-bg-3d.js"></script>',
];

function htmlFiles(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (['node_modules', 'docs', '.git', 'motion', 'coverage', '.superpowers', '.claude'].includes(name)) continue;
    const full = join(ROOT, rel);
    if (statSync(full).isDirectory()) htmlFiles(rel, out);
    else if (name.endsWith('.html')) out.push(rel);
  }
  return out;
}

describe('motion background wiring', () => {
  const pages = htmlFiles('');
  const publicPages = pages.filter((p) => !ADMIN_PAGES.has(p.split('/').pop()));
  const adminPages = pages.filter((p) => ADMIN_PAGES.has(p.split('/').pop()));

  it('finds the expected page set', () => {
    expect(publicPages.length).toBeGreaterThanOrEqual(20);
    expect(adminPages.length).toBe(2);
  });

  it.each(publicPages)('%s carries the stylesheet and all four scripts, in order', (page) => {
    const html = read(page);
    let cursor = 0;
    for (const tag of TAGS) {
      const at = html.indexOf(tag, cursor);
      expect(at, `${page} is missing or misorders: ${tag}`).toBeGreaterThan(-1);
      cursor = at + tag.length;
    }
    // Stylesheet sits in <head>, scripts in <body>.
    expect(html.indexOf(TAGS[0])).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf(TAGS[1])).toBeGreaterThan(html.indexOf('<body'));
    expect(html.indexOf(TAGS[4])).toBeLessThan(html.indexOf('</body>'));
    // Exactly once each — a second copy would double every layer.
    for (const tag of TAGS) expect(html.split(tag).length - 1, `${page}: ${tag} appears more than once`).toBe(1);
  });

  it.each(adminPages)('%s (admin console) stays plain', (page) => {
    expect(read(page)).not.toContain('/motion/');
  });
});

describe('motion package integrity', () => {
  const files = [
    'motion/motion-bg.css',
    'motion/ticker.js',
    'motion/lightning.js',
    'motion/motion-bg.js',
    'motion/motion-bg-3d.js',
    'motion/scene3d.js',
    'motion/vendor/three.module.min.js',
    'motion/vendor/three.core.min.js',
  ];

  it.each(files)('%s exists and is non-empty', (f) => {
    expect(existsSync(join(ROOT, f))).toBe(true);
    expect(statSync(join(ROOT, f)).size).toBeGreaterThan(0);
  });

  it('module chain imports resolve to vendored siblings (no CDN, no import map)', () => {
    expect(read('motion/motion-bg-3d.js')).toMatch(/import\(\s*['"]\.\/scene3d\.js['"]\s*\)/);
    expect(read('motion/scene3d.js')).toContain("from './vendor/three.module.min.js'");
    expect(read('motion/vendor/three.module.min.js')).toMatch(/['"]\.\/three\.core\.min\.js['"]/);
    for (const f of ['motion/motion-bg-3d.js', 'motion/scene3d.js']) {
      expect(read(f), `${f} must not load code from a CDN`).not.toMatch(/https?:\/\/(unpkg|cdn\.jsdelivr|cdnjs)/);
    }
  });

  it('bootstraps expose the client-router API and honour reduced motion', () => {
    expect(read('motion/motion-bg.js')).toContain('global.AurevonMotionBG = { refresh, destroy, pause, play, isPaused, version: VERSION }');
    expect(read('motion/motion-bg-3d.js')).toContain('window.AurevonMotionBG3D = { refresh, destroy }');
    expect(read('motion/motion-bg-3d.js')).toContain('prefers-reduced-motion');
    expect(read('motion/motion-bg.css')).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('every canvas layer the bootstraps insert is aria-hidden', () => {
    // Layers are the canvases given a `*-layer` class and inserted into the
    // page; the off-DOM WebGL capability probe is not one of them.
    for (const f of ['motion/motion-bg.js', 'motion/motion-bg-3d.js']) {
      const src = read(f);
      const layers = (src.match(/canvas\.className = '[a-z0-9-]+-layer'/g) || []).length;
      const hidden = (src.match(/canvas\.setAttribute\('aria-hidden', 'true'\)/g) || []).length;
      expect(layers, `${f} inserts canvas layers`).toBeGreaterThan(0);
      expect(hidden, `${f}: every inserted canvas layer must be aria-hidden`).toBe(layers);
    }
  });
});

describe('motion package manifest', () => {
  const manifest = JSON.parse(read('motion/MANIFEST.json'));
  const walk = (d) =>
    readdirSync(join(ROOT, d)).flatMap((n) => {
      const rel = `${d}/${n}`;
      return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
    });
  const onDisk = walk('motion').map((f) => f.slice('motion/'.length)).filter((f) => f !== 'MANIFEST.json').sort();

  it('lists exactly the files on disk', () => {
    expect(Object.keys(manifest.files).sort()).toEqual(onDisk);
  });

  it.each(onDisk)('%s matches its manifest digest', (f) => {
    const digest = createHash('sha256').update(readFileSync(join(ROOT, 'motion', f))).digest('hex');
    expect(digest, `motion/${f} changed without regenerating motion/MANIFEST.json`).toBe(manifest.files[f]);
  });

  it('manifest version matches the bootstrap VERSION', () => {
    const v = /const VERSION = '([^']+)'/.exec(read('motion/motion-bg.js'));
    expect(v && v[1]).toBe(manifest.version);
  });
});

describe('vercel.json caching for /motion', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const cacheFor = (source) => {
    const rule = (vercel.headers || []).find((h) => h.source === source);
    const cc = rule && rule.headers.find((h) => h.key === 'Cache-Control');
    return cc && cc.value;
  };

  it('bootstraps, engine and CSS revalidate on every load', () => {
    expect(cacheFor('/motion/:file((?!vendor/).*)')).toBe('public, max-age=0, must-revalidate');
  });

  it('vendored three.js keeps a long cache', () => {
    expect(cacheFor('/motion/vendor/(.*)')).toMatch(/max-age=\d{6,}/);
  });

  it('no catch-all /motion rule overrides the split', () => {
    expect(cacheFor('/motion/(.*)')).toBeUndefined();
  });
});
