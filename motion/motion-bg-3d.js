/* =========================================================
   AUREVON — Shared motion background: 3D bootstrap

   Generic port of app3d.js from labs.aurevonvc.com. Initialises the
   hero WebGL particle scene (drifting particle field + faint wireframe
   grid in Aurevon Electric Blue) and, on capable devices only, a faint
   full-page continuation layer fixed behind all content.

   Separate ES module so it can fail gracefully (no WebGL, old browser)
   without touching the rest of the page. three.js is vendored under
   ./vendor and imported by relative path so the host CSP can stay at
   script-src 'self'.

   Exposes window.AurevonMotionBG3D = { refresh, destroy } for
   client-routed apps: refresh() re-targets the hero scene after a
   navigation; the page-wide layer is created once and kept.

   One hero WebGL context per page, for the life of the page: on a
   client navigation the existing hero canvas (and its context) is moved
   into the new hero rather than rebuilt; a page without a hero parks it
   off-DOM, paused. Browsers cap live WebGL contexts (~16 in Chrome) and
   a disposed three.js renderer does not release its context, so
   rebuilding per navigation would eventually evict the page layer.
   destroy() releases contexts explicitly (WEBGL_lose_context).

   Hero detection mirrors motion-bg.js (same selector list, same first
   match) so both canvases land in the same element.

   Loading: three.js is ~740 KB and nothing above the fold depends on it,
   so scene3d.js (which imports it) is pulled in with a dynamic import()
   only after the window load event and an idle slot, keeping it out of
   the DOMContentLoaded / load critical path. Data-saver and very
   low-memory devices skip the download entirely.
   ========================================================= */

/* Load once (see motion-bg.js): a second copy of this module under
   another URL would otherwise build a second set of scenes. */
const ALREADY_LOADED = Boolean(window.AurevonMotionBG3D);

let scenePromise = null;
let engine = null; // initScene3D once the import has resolved
let importFailures = 0;

/* One shared, lazily started import. Resolves to initScene3D or null.
   A failed import (flaky network) is retried on a later refresh, at
   most twice, rather than cached as a permanent failure. */
function loadEngine() {
  if (scenePromise) return scenePromise;
  scenePromise = import('./scene3d.js')
    .then((m) => (engine = m.initScene3D))
    .catch((err) => {
      console.warn('Aurevon 3D background unavailable:', err);
      importFailures++;
      if (importFailures < 3) scenePromise = null;
      return null;
    });
  return scenePromise;
}

/* A disposed three.js renderer keeps its WebGL context until garbage
   collection; release it now so it does not count against the
   browser's live-context cap. */
function releaseContext(canvas) {
  try {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  } catch (err) {
    /* nothing to release */
  }
}

function paused() {
  return document.documentElement.classList.contains('motion-paused');
}

/* Skip the 3D layers (and the three.js download) where it is not worth
   the bytes: an explicit data-saving preference, a 2G-class connection,
   or a device reporting under 2 GB of memory. */
function cheapGate() {
  const nav = navigator;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (conn) {
    if (conn.saveData) return false;
    if (typeof conn.effectiveType === 'string' && /(^|\b)(slow-)?2g\b/.test(conn.effectiveType)) {
      return false;
    }
  }
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return false;
  return true;
}

/* The WebGL probe (hasAcceleratedWebGL) creates a context, so refresh()
   runs it in the idle slot after load, never during parsing. */
/* A software-rendered WebGL context (no GPU acceleration: VMs, remote
   desktops, blocklisted drivers) can run the scene, but every frame then
   costs main-thread time, and the three.js download buys a worse page.
   Probe once with failIfMajorPerformanceCaveat and skip when it refuses.
   Hosts can override with AurevonMotionBGConfig.allowSoftwareGL (tests). */
let acceleratedProbe = null;
function hasAcceleratedWebGL() {
  if (acceleratedProbe !== null) return acceleratedProbe;
  const cfg = window.AurevonMotionBGConfig || {};
  if (cfg.allowSoftwareGL) return (acceleratedProbe = true);
  try {
    const c = document.createElement('canvas');
    const opts = { failIfMajorPerformanceCaveat: true };
    const gl = c.getContext('webgl2', opts) || c.getContext('webgl', opts);
    if (!gl) return (acceleratedProbe = false);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    acceleratedProbe = true;
  } catch (err) {
    acceleratedProbe = false;
  }
  return acceleratedProbe;
}

/* Run fn once the page has loaded and the main thread has an idle slot. */
function whenIdleAfterLoad(fn) {
  const idle = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: 2000 });
    } else {
      setTimeout(fn, 300);
    }
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}

/* Read live, not snapshotted: scene3d.js freezes itself only when the
   preference is already set at load, so a user who turns reduced motion
   on mid-session is handled here by tearing the scenes down (and rebuilt
   if they turn it off again). */
const motionQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

function reducedMotion() {
  return motionQuery ? motionQuery.matches : false;
}

/* Mirrors motion-bg.js: hosts may narrow detection through
   window.AurevonMotionBGConfig = { heroSelectors: [...] }. */
const DEFAULT_HERO_SELECTORS = [
  '[data-motion-hero]',
  'section#top',
  'section.hero',
  'header.hero',
  'main.hero',
  'main > section',
  'main section',
  'section',
];
const HERO_SELECTORS =
  (window.AurevonMotionBGConfig && window.AurevonMotionBGConfig.heroSelectors) ||
  DEFAULT_HERO_SELECTORS;

/* First *rendered* match — see motion-bg.js: a hidden (display:none)
   segment kept around by a client router is a stale hero. */
function isRendered(el) {
  return el.getClientRects().length > 0;
}

function findHero() {
  for (let i = 0; i < HERO_SELECTORS.length; i++) {
    const matches = document.querySelectorAll(HERO_SELECTORS[i]);
    for (let j = 0; j < matches.length; j++) {
      if (isRendered(matches[j])) return matches[j];
    }
  }
  return null;
}

/**
 * The page-wide layer is a second live WebGL context covering the whole
 * viewport. On a laptop it is a pleasant depth cue; on a mid-range phone
 * it roughly doubles GPU cost for an effect that is barely visible
 * behind the content. Gate it on what the device actually reports.
 */
function shouldRenderPageLayer() {
  if (reducedMotion()) return false;

  const nav = navigator;

  // Respect an explicit data-saving preference.
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (conn) {
    if (conn.saveData) return false;
    if (typeof conn.effectiveType === 'string' && /(^|\b)(slow-)?2g\b/.test(conn.effectiveType)) {
      return false;
    }
  }

  // Coarse hardware signals, where the browser exposes them.
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 4) return false;
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency < 4) return false;

  // Small / touch-primary viewports: the hero scene alone is plenty.
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(max-width: 900px)').matches) return false;
    if (window.matchMedia('(pointer: coarse)').matches) return false;
  }

  return true;
}

let heroState = null; // { el, canvas, scene } — el is null while parked
let pageState = null; // { canvas, scene }
let webglUnavailable = false;
let generation = 0; // bumped by destroy() so a late-arriving engine does not resurrect scenes

/* Fade the canvas in on the next frame so the field appears rather than
   pops: the stylesheet transitions .is-ready to the layer's opacity. */
function reveal(canvas) {
  requestAnimationFrame(() => canvas.classList.add('is-ready'));
}

/* See motion-bg.js: the shared .motion-hero class is dropped only once
   neither bootstrap has a layer left in the element. */
function releaseHeroClass(el) {
  if (!el) return;
  if (!el.querySelector(':scope > .hero-canvas-layer, :scope > .hero-scene3d-layer')) {
    el.classList.remove('motion-hero');
  }
}

/* Same late-hero handling as motion-bg.js: watch briefly for a hero that
   page script reveals after load, then wire it. */
let heroWatcher = null;
function stopHeroWatcher() {
  if (!heroWatcher) return;
  heroWatcher.observer.disconnect();
  clearTimeout(heroWatcher.timer);
  heroWatcher = null;
}
function watchForLateHero(initScene3D) {
  if (heroWatcher || typeof MutationObserver !== 'function') return;
  const stop = stopHeroWatcher;
  const gen = generation;
  const observer = new MutationObserver(() => {
    if (findHero()) {
      stop();
      /* destroy() bumps generation: a watch started before a teardown must
         not resurrect the scene it tore down. */
      if (gen === generation && !reducedMotion() && !paused()) wireHero(initScene3D);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  });
  heroWatcher = { observer, timer: setTimeout(stop, 8000) };
}

/* Take the hero canvas out of the page but keep its scene and context
   for the next hero. The scene observes its own canvas, so it pauses
   when detached and resumes / resizes when re-inserted. */
function parkHero() {
  if (!heroState || !heroState.el) return;
  const el = heroState.el;
  try {
    heroState.scene.stop();
  } catch (err) {
    /* already stopped */
  }
  if (heroState.canvas.parentNode) heroState.canvas.parentNode.removeChild(heroState.canvas);
  heroState.el = null;
  releaseHeroClass(el);
}

function wireHero(initScene3D) {
  if (webglUnavailable) return;
  const hero = findHero();
  if (heroState && heroState.el === hero && heroState.canvas.parentNode === hero) return;
  if (!hero) {
    parkHero();
    watchForLateHero(initScene3D);
    return;
  }

  /* Reuse the live canvas and context: move it into the new hero. */
  if (heroState) {
    const prev = heroState.el;
    hero.classList.add('motion-hero');
    hero.insertBefore(heroState.canvas, hero.firstChild);
    heroState.el = hero;
    if (prev && prev !== hero) releaseHeroClass(prev);
    try {
      heroState.scene.resize();
      heroState.scene.start();
    } catch (err) {
      /* the scene's own observers will catch up */
    }
    return;
  }

  let canvas = null;
  try {
    hero.classList.add('motion-hero');
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'hero-scene3d-layer';
    hero.insertBefore(canvas, hero.firstChild);

    const scene = initScene3D(canvas);
    /* initScene3D returns null when WebGL is unavailable rather than
       throwing — remove the dead canvas and stop trying. */
    if (!scene) {
      canvas.remove();
      releaseHeroClass(hero);
      webglUnavailable = true;
      return;
    }
    heroState = { el: hero, canvas, scene };
    reveal(canvas);
  } catch (err) {
    console.warn('Aurevon 3D background unavailable:', err);
    if (canvas && canvas.parentNode) canvas.remove();
    releaseHeroClass(hero);
    webglUnavailable = true;
  }
}

function unwireHero() {
  if (!heroState) return;
  const { el, canvas, scene } = heroState;
  try {
    scene.dispose();
    releaseContext(canvas);
    canvas.remove();
  } catch (err) {
    /* already gone */
  }
  heroState = null;
  releaseHeroClass(el);
}

function wirePage(initScene3D) {
  if (pageState || webglUnavailable) return;
  try {
    if (!shouldRenderPageLayer()) return;

    /* Faint full-page continuation: a second, cheaper instance fixed
       behind all content so the motion carries subtly past the hero.
       Fewer particles and no antialiasing — it sits behind everything
       and is heavily dimmed by CSS, so the detail is not perceivable. */
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'page-scene3d-layer';
    document.body.insertBefore(canvas, document.body.firstChild);

    const scene = initScene3D(canvas, {
      particleCount: 180,
      nodeCount: 8,
      antialias: false,
      dprCap: 1.5,
    });

    if (!scene) {
      canvas.remove();
      return;
    }
    pageState = { canvas, scene };
    reveal(canvas);
  } catch (err) {
    console.warn('Aurevon page-wide 3D layer unavailable:', err);
  }
}

function refresh() {
  /* Under reduced motion (or the visitor's pause) there are no scenes to
     keep: a scene built now would animate, because scene3d.js reads the
     preference only when its module first loads. This covers both the
     load-time case and a client navigation after the preference was
     switched on mid-session. */
  if (reducedMotion() || paused()) {
    destroy();
    return;
  }
  if (webglUnavailable || !cheapGate()) return;

  /* Engine already in memory (a client navigation after first load):
     re-attach now, so the new hero does not wait for an idle slot. */
  if (engine) {
    wireHero(engine);
    wirePage(engine);
    return;
  }

  const gen = generation;
  whenIdleAfterLoad(() => {
    if (gen !== generation || !hasAcceleratedWebGL()) return;
    loadEngine().then((initScene3D) => {
      /* The preference may have flipped, or destroy() may have run,
         while three.js was downloading. */
      if (!initScene3D || gen !== generation || reducedMotion() || paused()) return;
      wireHero(initScene3D);
      wirePage(initScene3D);
    });
  });
}

function destroy() {
  generation++;
  stopHeroWatcher();
  unwireHero();
  if (pageState) {
    try {
      pageState.scene.dispose();
      releaseContext(pageState.canvas);
      pageState.canvas.remove();
    } catch (err) {
      /* already gone */
    }
    pageState = null;
  }
}

if (!ALREADY_LOADED) init();

function init() {
  window.AurevonMotionBG3D = { refresh, destroy };

  if (motionQuery) {
    const onMotionChange = () => {
      if (reducedMotion()) destroy();
      else refresh();
    };
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true });
  } else {
    refresh();
  }

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    destroy();
  });
}
