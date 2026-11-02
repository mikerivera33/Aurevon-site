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
| `motion-bg.js` | labs `app.js` lightning wiring, generalised | Finds the hero, injects canvases, wires strike/ambient/crackle; pause control. |
| `motion-bg-3d.js` | labs `app3d.js`, generalised | Hero 3D scene (one context per page, moved between heroes) + gated faint page-wide 3D layer. |
| `MANIFEST.json` | generated | Package version and the sha256 of every file. Both hosts' tests check their copy against it. |

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
`section.hero`, `header.hero`, `main.hero`, first `<section>` in `<main>`, first
`<section>`. Add `data-motion-hero` to be explicit. Crackle targets:
`[data-crackle], .btn, .btn-g, .nav-link`.

Client-routed apps call `window.AurevonMotionBG.refresh()` and
`window.AurevonMotionBG3D.refresh()` after each navigation.

### Configuration

Define before the scripts load (merge, don't overwrite, if the host sets
other keys):

```js
window.AurevonMotionBGConfig = {
  heroSelectors: ['[data-motion-hero]'],   // narrow hero detection (default: list above)
  crackleSelector: '[data-crackle], .btn', // crackle targets (default above)
  pauseControl: false,                     // hide the built-in pause button (default: shown)
  allowSoftwareGL: true,                   // tests only: run 3D on software WebGL
};
```

### API

| Call | Effect |
|---|---|
| `AurevonMotionBG.refresh()` | (Re)wire hero, page layer and crackle targets; no-op while paused or under reduced motion. |
| `AurevonMotionBG.destroy()` | Remove every 2D layer, timer and the flash element; `refresh()` rebuilds. |
| `AurevonMotionBG.pause()` / `.play()` / `.isPaused()` | Pause control used by the built-in button; remembered in `localStorage` (`aurevon-motion-paused`). Pausing also tears down the 3D scenes. |
| `AurevonMotionBG.version` | Package version (matches `MANIFEST.json`). |
| `AurevonMotionBG3D.refresh()` / `.destroy()` | Re-target the hero scene / dispose both scenes and release their WebGL contexts. |

Loading either bootstrap twice is a no-op (load-once guard).

### Pause control

WCAG 2.2.2 asks for a way to pause motion that starts automatically and
runs alongside content. `motion-bg.js` adds a 32 px round button,
bottom-left, low-opacity until hovered or focused. It lifts itself above
any fixed or sticky bottom bar (a mobile buy bar, a cookie banner) and,
once scrolling settles, above any small link or button under it, so it
never covers a host control. Hidden under reduced motion. Hosts can move
it with the CSS variables `--motion-toggle-left` / `--motion-toggle-bottom`
or hide it with `pauseControl: false` and call `pause()` / `play()` from
their own control.

The grid/glow layers are negative-z pseudo-elements of `<body>`, so the host
must let the body background propagate to the canvas: `<html>` must not
paint an opaque background of its own (this file resets it).

## Loading and cost

- The lightning path (`ticker.js` + `lightning.js` + `motion-bg.js`, ~40 KB
  uncompressed) loads deferred and wires up after the window `load` event
  and an idle slot — nothing it draws is visible before the hero strike,
  which fires after load anyway — so it adds no work to DOMContentLoaded
  or load.
- three.js (~740 KB) is **not** on the critical path: `motion-bg-3d.js` is a
  tiny module that `import()`s `scene3d.js` only after the window `load`
  event and an idle slot, then fades the scenes in (`.is-ready`). LCP and
  DOMContentLoaded are unaffected by the download.
- Data-saver, 2G-class connections, devices reporting < 2 GB, and browsers
  whose WebGL would be software-rendered (probed once with
  `failIfMajorPerformanceCaveat`, in the idle slot after load) skip the 3D
  layers and the three.js download entirely; the lightning still runs.
- The viewport-sized page lightning layer is skipped on data saver, 2G,
  < 2 GB or ≤ 2 cores, and drawn at 1x on touch-first screens; the hero
  storm runs everywhere.
- One hero WebGL context per page for its whole life: a client navigation
  moves the existing hero canvas into the new hero instead of building a
  new renderer (browsers cap live contexts at ~16). `destroy()` releases
  contexts explicitly with `WEBGL_lose_context`.
  The page-wide 3D layer additionally needs ≥ 4 GB / ≥ 4 cores, a pointer
  that is not coarse and a viewport wider than 900px, as on Labs.
- Caching (both hosts' `vercel.json`): the bootstraps, engine and CSS are
  served `max-age=0, must-revalidate` — an ETag revalidation per load,
  so a package update can never leave a browser running new CSS with old
  JS; `vendor/` is cached for a week (+30 days stale-while-revalidate).
  **When upgrading three.js, rename the folder** (e.g. `vendor-0.184/`) and
  update the import in `scene3d.js`, so a cached old file can never pair
  with a new one.
- Reduced motion: the engine refuses to draw bolts, the stylesheet hides the
  lightning/flash layers, and the 3D scenes are torn down (or never built),
  all live — flipping the OS setting mid-session is honoured both ways.
- Per-frame: one shared rAF loop (ticker.js) for everything; bolt budget
  capped at 6 page-wide / 3 per field; every layer pauses when its canvas is
  off-screen or the tab is hidden; WebGL context loss is survived.

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
provenance record. The engine files (`ticker.js`, `lightning.js`,
`scene3d.js`, `vendor/`) are unmodified from Labs, so a diff against Labs
is a one-liner.

**Source of truth and drift.** The canonical copy is `motion/` in the
Aurevon-site repo. To change the package: edit there, bump `VERSION` in
`motion-bg.js`, regenerate `MANIFEST.json` (sha256 of every other file),
then copy the folder byte-for-byte to `storefront/public/motion/` in
Forge-ai. Each host's tests fail if any file no longer matches its
manifest, and the Forge smoke test compares its deployed `MANIFEST.json`
with aurevonvc.com's, so a half-applied change is caught in CI or on the
first smoke run.

**Consequences.** +~820 KB per site uncompressed (about 740 KB of it
three.js, loaded as a deferred module that never blocks render; the
page-wide 3D layer is gated to capable desktops). Upgrades are a copy,
not a release.
