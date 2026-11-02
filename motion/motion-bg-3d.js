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

   Hero detection mirrors motion-bg.js (same selector list, same first
   match) so both canvases land in the same element.

   Loading: three.js is ~740 KB and nothing above the fold depends on it,
   so scene3d.js (which imports it) is pulled in with a dynamic import()
   only after the window load event and an idle slot, keeping it out of
   the DOMContentLoaded / load critical path. Data-saver and very
   low-memory devices skip the download entirely.
   ========================================================= */

let scenePromise = null;

/* One shared, lazily started import. Resolves to initScene3D or null. */
function loadEngine() {
  if (scenePromise) return scenePromise;
  scenePromise = import('./scene3d.js')
    .then((m) => m.initScene3D)
    .catch((err) => {
      console.warn('Aurevon 3D background unavailable:', err);
      return null;
    });
  return scenePromise;
}

/* Skip the 3D layers (and the three.js download) where it is not worth
   the bytes: an explicit data-saving preference, a 2G-class connection,
   or a device reporting under 2 GB of memory. */
function shouldLoadEngine() {
  const nav = navigator;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (conn) {
    if (conn.saveData) return false;
    if (typeof conn.effectiveType === 'string' && /(^|\b)(slow-)?2g\b/.test(conn.effectiveType)) {
      return false;
    }
  }
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return false;
  return hasAcceleratedWebGL();
}

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

let heroState = null; // { el, canvas, scene }
let pageState = null; // { canvas, scene }
let webglUnavailable = false;
let generation = 0; // bumped by destroy() so a late-arriving engine does not resurrect scenes

/* Fade the canvas in on the next frame so the field appears rather than
   pops: the stylesheet transitions .is-ready to the layer's opacity. */
function reveal(canvas) {
  requestAnimationFrame(() => canvas.classList.add('is-ready'));
}

function wireHero(initScene3D) {
  const hero = findHero();
  if (heroState && heroState.el === hero && heroState.canvas.isConnected) return;
  unwireHero();
  if (!hero || webglUnavailable) return;

  try {
    hero.classList.add('motion-hero');
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'hero-scene3d-layer';
    hero.insertBefore(canvas, hero.firstChild);

    const scene = initScene3D(canvas);
    /* initScene3D returns null when WebGL is unavailable rather than
       throwing — remove the dead canvas and stop trying. */
    if (!scene) {
      canvas.remove();
      webglUnavailable = true;
      return;
    }
    heroState = { el: hero, canvas, scene };
    reveal(canvas);
  } catch (err) {
    console.warn('Aurevon 3D background unavailable:', err);
    webglUnavailable = true;
  }
}

function unwireHero() {
  if (!heroState) return;
  try {
    heroState.scene.dispose();
    heroState.canvas.remove();
  } catch (err) {
    /* already gone */
  }
  heroState = null;
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
  /* Under reduced motion there are no scenes to keep: a scene built now
     would animate, because scene3d.js reads the preference only when its
     module first loads. This covers both the load-time case and a client
     navigation after the preference was switched on mid-session. */
  if (reducedMotion()) {
    destroy();
    return;
  }
  if (!shouldLoadEngine() || webglUnavailable) return;

  const gen = generation;
  whenIdleAfterLoad(() => {
    loadEngine().then((initScene3D) => {
      /* The preference may have flipped, or destroy() may have run,
         while three.js was downloading. */
      if (!initScene3D || gen !== generation || reducedMotion()) return;
      wireHero(initScene3D);
      wirePage(initScene3D);
    });
  });
}

function destroy() {
  generation++;
  unwireHero();
  if (pageState) {
    try {
      pageState.scene.dispose();
      pageState.canvas.remove();
    } catch (err) {
      /* already gone */
    }
    pageState = null;
  }
}

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
