# Aurevon shared motion background

The storm from `labs.aurevonvc.com`, packaged so every Aurevon property runs
the identical background: faint procedural grid, two electric-blue radial
glows, a drifting WebGL particle field, and the procedural lightning engine
(hero signature strike, ambient page-wide bolts, button crackle, screen
flash). Content, copy and layout of the host page are untouched — the
package only adds layers behind (and, for ambient bolts, across) it.

## Files

| File | Origin | Role |
|---|---|---|
| `ticker.js` | labs `ticker.js` (verbatim) | One shared rAF loop for every animation; pauses on hidden tab. |
| `lightning.js` | labs `lightning.js` (verbatim) | Fractal bolt engine: `createField`, `ambient`, `heroStrike`, `crackle`. |
| `scene3d.js` | labs `scene3d.js` (verbatim) | three.js particle field + wireframe grid; survives GL context loss. |
| `vendor/three.*.min.js` | three 0.183.0 (MIT, vendored) | Imported by relative path so CSP stays `script-src 'self'`. |
| `motion-bg.css` | labs `style.css` (layer rules + crackle pulse) | Body grid/glow layers, hero/page/crackle/flash layer geometry, reduced-motion. |
| `motion-bg.js` | labs `app.js` lightning wiring, generalised | Finds the hero, injects canvases, wires strike/ambient/crackle. |
| `motion-bg-3d.js` | labs `app3d.js`, generalised | Hero 3D scene + gated faint page-wide 3D layer. |

## Drop-in

```html
<link rel="stylesheet" href="/motion/motion-bg.css">
...
<script src="/motion/ticker.js" defer></script>
<script src="/motion/lightning.js" defer></script>
<script src="/motion/motion-bg.js" defer></script>
<script type="module" src="/motion/motion-bg-3d.js"></script>
```

Hero detection, first match wins: `[data-motion-hero]`, `section#top`,
`section.hero`, `header.hero`, first `<section>` in `<main>`, first
`<section>`. Add `data-motion-hero` to be explicit. Crackle targets:
`[data-crackle], .btn, .btn-g, .nav-link`.

Client-routed apps call `window.AurevonMotionBG.refresh()` and
`window.AurevonMotionBG3D.refresh()` after each navigation, and can narrow
hero detection to explicit opt-ins by defining, before the scripts load:

```js
window.AurevonMotionBGConfig = { heroSelectors: ['[data-motion-hero]'] };
```

The grid/glow layers are negative-z pseudo-elements of `<body>`, so the host
must let the body background propagate to the canvas: `<html>` must not
paint an opaque background of its own (this file resets it).

## ADR-001: vendor a copy per site rather than share a package or CDN

**Status:** Accepted · **Date:** 2026-11-01

**Context.** Three sites, three deploy pipelines: Labs and aurevonvc.com are
no-build static HTML on Vercel; the Forge storefront is Next.js. All three
enforce or are moving toward `script-src 'self'`. One visual language is
wanted across them.

**Options.** (A) Vendor the package into each repo under `/motion/`.
(B) Publish an npm package and import it. (C) Serve the files from
`labs.aurevonvc.com` and hot-link.

| | A — vendor | B — npm | C — hot-link |
|---|---|---|---|
| Works with no build step | yes | no (Labs, aurevonvc.com) | yes |
| Keeps `script-src 'self'` | yes | yes | no (adds a cross-origin script source) |
| Blast radius of a Labs change | none until copied | version bump | immediate, all sites |
| Drift risk | copies can diverge | low | none |

**Decision.** A. Identical bytes in each repo, with this README as the
provenance record. Drift is managed by re-copying from Labs; the engine
files are unmodified so a diff against Labs is a one-liner.

**Consequences.** +~1.1 MB per site (740 KB of it three.js, loaded as a
deferred module that never blocks render; the page-wide 3D layer is gated
to capable desktops). Upgrades are a copy, not a release.
