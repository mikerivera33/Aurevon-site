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
//   3. /motion gets the long-lived Cache-Control header in vercel.json.
//   4. Every canvas layer the bootstrap creates is aria-hidden, and the
//      stylesheet carries a prefers-reduced-motion block.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Internal operator consoles: no storm on data-heavy admin screens.
const ADMIN_PAGES = new Set(['operator.html', 'aurevon-crm.html', 'setup-wizard.html']);

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
    if (['node_modules', 'docs', '.git', 'motion'].includes(name)) continue;
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
    expect(adminPages.length).toBe(3);
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
    expect(read('motion/motion-bg.js')).toContain('global.AurevonMotionBG = { refresh, destroy }');
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

describe('vercel.json caching for /motion', () => {
  it('serves /motion with a long-lived Cache-Control', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const rule = (vercel.headers || []).find((h) => h.source === '/motion/(.*)');
    expect(rule, 'missing /motion/(.*) headers rule').toBeTruthy();
    const cc = rule.headers.find((h) => h.key === 'Cache-Control');
    expect(cc && cc.value).toMatch(/max-age=\d+/);
  });
});
