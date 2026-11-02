/* =========================================================
   AUREVON — Shared motion background: lightning bootstrap

   Generic port of the lightning wiring from labs.aurevonvc.com
   (app.js) so any Aurevon property gets the identical storm:
     - hero: signature strike on load + ambient bolts behind the hero
     - page: occasional ambient bolts anywhere in the viewport
     - crackle: hover / click / focus bolts on buttons and nav links
     - screen flash accompanying the hero strike

   Everything is decorative and runs inside guarded blocks: if the
   engine is missing, blocked, or throws, the host page is untouched.

   Requires ticker.js and lightning.js to be loaded first (defer, in
   order). Exposes window.AurevonMotionBG = { refresh, destroy, pause,
   play, isPaused, version } so client-routed apps can re-wire the hero
   and crackle targets after a navigation without reloading the
   page-wide layers, and so a host can drive the pause control.

   Initial wiring waits for the window load event (plus an idle slot):
   nothing it draws is visible before the hero strike, which itself
   fires after load, so none of its layout reads sit on the critical
   path.

   A small pause / play control (WCAG 2.2.2) is added bottom-left and
   remembered per browser. Hosts can hide it with
   AurevonMotionBGConfig.pauseControl = false (e.g. when they render
   their own control that calls AurevonMotionBG.pause()/play()).

   Hero detection (first match wins):
     [data-motion-hero]  → explicit opt-in (preferred)
     section#top, section.hero, header.hero
     the first <section> inside <main>, else the first <section>
   ========================================================= */
(function (global) {
  'use strict';

  /* Load once: a second copy of this script (two tags, a host that
     re-injects it) would otherwise duplicate every layer. */
  if (global.AurevonMotionBG) return;

  const VERSION = '1.1.0';

  function safely(label, fn) {
    try {
      return fn();
    } catch (err) {
      if (global.console && console.warn) {
        console.warn('Aurevon motion: ' + label + ' unavailable —', err);
      }
      return undefined;
    }
  }

  const L = global.AurevonLightning || null;
  const motionQuery =
    typeof global.matchMedia === 'function'
      ? global.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  function isReducedMotion() {
    if (L) return L.REDUCED_MOTION;
    return motionQuery ? motionQuery.matches : false;
  }

  /* Hosts may narrow hero detection (e.g. a client-routed app that only
     wants its explicit [data-motion-hero] sections) by defining
     window.AurevonMotionBGConfig = { heroSelectors: [...] } before load. */
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
  const CONFIG = global.AurevonMotionBGConfig || {};
  const HERO_SELECTORS = CONFIG.heroSelectors || DEFAULT_HERO_SELECTORS;

  const CRACKLE_SELECTOR = CONFIG.crackleSelector || '[data-crackle], .btn, .btn-g, .nav-link';

  /* First *rendered* match: client routers (Next.js Activity) keep the
     previous page's segment in the DOM under display:none, so a selector
     hit that has no layout boxes is a stale hero, not this page's. */
  function isRendered(el) {
    return el.getClientRects().length > 0;
  }

  function findHero() {
    for (let i = 0; i < HERO_SELECTORS.length; i++) {
      let matches;
      try {
        matches = document.querySelectorAll(HERO_SELECTORS[i]);
      } catch (err) {
        continue; // an invalid host-supplied selector must not break the rest
      }
      for (let j = 0; j < matches.length; j++) {
        if (isRendered(matches[j])) return matches[j];
      }
    }
    return null;
  }

  /* Both bootstraps put their hero canvas in the same element and share
     the .motion-hero positioning class; only drop it once neither layer
     is left inside. */
  function releaseHeroClass(el) {
    if (!el) return;
    if (!el.querySelector(':scope > .hero-canvas-layer, :scope > .hero-scene3d-layer')) {
      el.classList.remove('motion-hero');
    }
  }

  /* ---------------- Pause control (WCAG 2.2.2) ---------------- */
  const PAUSE_KEY = 'aurevon-motion-paused';
  function readPaused() {
    try {
      return global.localStorage.getItem(PAUSE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }
  function writePaused(value) {
    try {
      if (value) global.localStorage.setItem(PAUSE_KEY, '1');
      else global.localStorage.removeItem(PAUSE_KEY);
    } catch (err) {
      /* storage blocked: the choice lasts for this page only */
    }
  }
  function isPaused() {
    return document.documentElement.classList.contains('motion-paused');
  }
  /* Set before anything is wired (and before the 3D module runs, which
     reads the same class) so a paused visitor never sees a frame. */
  if (readPaused()) document.documentElement.classList.add('motion-paused');

  /* ---------------- Full-screen flash ---------------- */
  let flashScreen = function () {};
  let flashEl = null;
  function ensureFlash() {
    if (flashEl && flashEl.isConnected) return;
    safely('screen flash', function () {
      flashEl = document.createElement('div');
      flashEl.setAttribute('aria-hidden', 'true');
      flashEl.className = 'screen-flash';
      document.body.appendChild(flashEl);
      flashScreen = function (intensity) {
        flashEl.style.transition = 'opacity 120ms ease-out';
        flashEl.style.opacity = String(intensity);
        setTimeout(() => {
          flashEl.style.transition = 'opacity 260ms ease-in';
          flashEl.style.opacity = '0';
        }, 40);
      };
    });
  }

  /* ---------------- State ---------------- */
  const pageFields = [];
  let heroState = null; // { el, canvas, field, ambient }
  const crackled = new WeakSet();
  const crackleFields = [];
  let pageWired = false;

  /* ---------------- Hero lightning ---------------- */
  /* Some pages reveal their hero after a gate or an async check (a
     display:none wrapper flipped by page script). If no rendered hero
     exists at refresh time, watch the document briefly and wire the hero
     the moment one appears. */
  let heroWatcher = null;
  function stopHeroWatcher() {
    if (!heroWatcher) return;
    heroWatcher.observer.disconnect();
    clearTimeout(heroWatcher.timer);
    heroWatcher = null;
  }
  function watchForLateHero() {
    if (heroWatcher || typeof MutationObserver !== 'function') return;
    const stop = stopHeroWatcher;
    const observer = new MutationObserver(() => {
      if (findHero()) {
        stop();
        /* The preference may have been switched on while we waited; the
           engine would refuse the bolts, but no layer should be built. */
        if (!isReducedMotion()) wireHero();
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

  function wireHero() {
    const hero = findHero();
    if (heroState && heroState.el === hero && heroState.canvas.isConnected) return;
    unwireHero();
    if (!hero) {
      watchForLateHero();
      return;
    }

    safely('hero lightning', function () {
      hero.classList.add('motion-hero');
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.className = 'hero-canvas-layer';
      hero.insertBefore(canvas, hero.firstChild);

      const field = L.createField(canvas);
      const fire = () => {
        setTimeout(() => {
          if (field.destroyed) return;
          L.heroStrike(field, { onFlashPeak: () => flashScreen(0.12) });
        }, 260);
      };
      if (document.readyState === 'complete') fire();
      else global.addEventListener('load', fire, { once: true });

      const ambient = L.ambient(field, { minInterval: 3200, maxInterval: 8000 });
      heroState = { el: hero, canvas, field, ambient };
    });
  }

  function unwireHero() {
    if (!heroState) return;
    safely('hero teardown', function () {
      heroState.ambient.stop();
      heroState.field.destroy();
      if (heroState.canvas.parentNode) heroState.canvas.parentNode.removeChild(heroState.canvas);
      releaseHeroClass(heroState.el);
    });
    heroState = null;
  }

  /* ---------------- Page-wide ambient bolts ----------------
     The viewport-sized canvas is the costliest surface in the package
     (every bolt is drawn with shadowBlur across the whole screen). Skip
     it where the visitor or the device asks for less: data saver, a
     2G-class connection, under 2 GB of memory, or two cores or fewer.
     The hero storm still runs there. Touch-first screens draw it at 1x. */
  function shouldRenderPageLightning() {
    const nav = global.navigator || {};
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (conn) {
      if (conn.saveData) return false;
      if (typeof conn.effectiveType === 'string' && /(^|\b)(slow-)?2g\b/.test(conn.effectiveType)) return false;
    }
    if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return false;
    if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 2) return false;
    return true;
  }
  function coarsePointer() {
    return typeof global.matchMedia === 'function' && global.matchMedia('(pointer: coarse)').matches;
  }

  let pageState = null; // { canvas, field, ambient }
  function wirePage() {
    if (pageWired) return;
    pageWired = true;
    if (!shouldRenderPageLightning()) return;
    safely('page lightning', function () {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.className = 'page-lightning-layer';
      document.body.appendChild(canvas);
      /* Full viewport: the most expensive surface per frame — cap DPR harder. */
      const field = L.createField(canvas, { dprCap: coarsePointer() ? 1 : 1.5 });
      pageFields.push(field);
      const ambient = L.ambient(field, { minInterval: 5000, maxInterval: 12000 });
      pageState = { canvas, field, ambient };
    });
  }

  function unwirePage() {
    if (pageState) {
      safely('page teardown', function () {
        pageState.ambient.stop();
        if (pageState.canvas.parentNode) pageState.canvas.parentNode.removeChild(pageState.canvas);
      });
      pageState = null;
    }
    pageWired = false;
  }

  /* ---------------- Crackle: hover + click + focus-visible ----------------
     Fields are created lazily on first interaction; a page may have
     dozens of targets and most are never touched. */
  function attachCrackle(el) {
    if (crackled.has(el)) return;
    crackled.add(el);

    let field = null;
    let pulseTimer = null;

    function ensureField() {
      if (field && !field.destroyed) return field;
      /* Only adopt a canvas that is a direct child — a descendant canvas
         may belong to another effect and clearing it would erase that. */
      let canvas = el.querySelector(':scope > canvas.crackle-layer');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.className = 'crackle-layer';
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.style.overflow = 'visible';
        el.appendChild(canvas);
      }
      field = L.createField(canvas);
      crackleFields.push(field);
      return field;
    }

    function pulseEdge() {
      el.classList.remove('crackle-pulse');
      void el.offsetWidth; // restart the animation on rapid re-trigger
      el.classList.add('crackle-pulse');
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => el.classList.remove('crackle-pulse'), 700);
    }

    function burst(count) {
      /* Listeners outlive destroy()/pause(); they must not build new
         canvases while the motion layers are torn down. */
      if (!active || isReducedMotion()) return;
      const f = ensureField();
      if (!f || !f.ctx) return;
      L.crackle(f, f.width / 2, f.height / 2, { count, onFlashPeak: pulseEdge });
    }

    let hoverFired = false;
    el.addEventListener('mouseenter', () => {
      if (hoverFired) return;
      hoverFired = true;
      burst(3);
      setTimeout(() => (hoverFired = false), 1400);
    });
    el.addEventListener('click', () => burst(4));
    el.addEventListener('focus', () => {
      let visible = true;
      try {
        visible = el.matches(':focus-visible');
      } catch (err) {
        /* older browsers: always fire */
      }
      if (visible) burst(2);
    });
  }

  function wireCrackle() {
    safely('crackle effects', function () {
      document.querySelectorAll(CRACKLE_SELECTOR).forEach(attachCrackle);
    });
  }

  /* Crackle fields belong to buttons that a client router may unmount.
     Their canvases leave the document with the element, but the field,
     its observers and its share of the bolt budget would otherwise be
     retained for the whole session. Release the detached ones. */
  function pruneDetached() {
    for (let i = crackleFields.length - 1; i >= 0; i--) {
      const f = crackleFields[i];
      /* Connected but unrendered means a segment parked under
         display:none by the router; release it too — the next hover
         rebuilds the field if the segment comes back. */
      if (f.canvas && f.canvas.isConnected && f.canvas.getClientRects().length > 0) continue;
      try {
        f.destroy();
      } catch (err) {
        /* already gone */
      }
      crackleFields.splice(i, 1);
    }
  }

  /* ---------------- Public API ---------------- */
  let active = false;

  function refresh() {
    syncToggle();
    if (!L || isReducedMotion() || isPaused()) return;
    active = true;
    ensureFlash();
    pruneDetached();
    wirePage();
    wireHero();
    wireCrackle();
  }

  /* Full teardown; refresh() rebuilds everything from scratch. */
  function destroy() {
    active = false;
    stopHeroWatcher();
    unwireHero();
    unwirePage();
    [].concat(pageFields, crackleFields).forEach((f) => {
      try {
        f.destroy();
      } catch (err) {
        /* already gone */
      }
    });
    pageFields.length = 0;
    crackleFields.length = 0;
    if (flashEl && flashEl.parentNode) flashEl.parentNode.removeChild(flashEl);
    flashEl = null;
    flashScreen = function () {};
  }

  function pause() {
    document.documentElement.classList.add('motion-paused');
    writePaused(true);
    destroy();
    if (global.AurevonMotionBG3D) safely('3D pause', () => global.AurevonMotionBG3D.destroy());
    syncToggle();
  }

  function play() {
    document.documentElement.classList.remove('motion-paused');
    writePaused(false);
    refresh();
    if (global.AurevonMotionBG3D) safely('3D resume', () => global.AurevonMotionBG3D.refresh());
  }

  /* The control: one small round button, bottom-left, out of the way of
     the chat launchers and back-to-top buttons hosts put bottom-right.
     Hidden under reduced motion (nothing moves) and when a host opts
     out. */
  let toggleEl = null;
  function syncToggle() {
    if (CONFIG.pauseControl === false || !L) return;
    safely('pause control', function () {
      if (!document.body) return;
      if (!toggleEl || !toggleEl.isConnected) {
        toggleEl = document.createElement('button');
        toggleEl.type = 'button';
        toggleEl.className = 'motion-toggle';
        toggleEl.addEventListener('click', () => (isPaused() ? play() : pause()));
        document.body.appendChild(toggleEl);
        watchTogglePlacement();
      }
      const paused = isPaused();
      toggleEl.hidden = isReducedMotion();
      toggleEl.setAttribute('aria-pressed', paused ? 'true' : 'false');
      toggleEl.setAttribute('aria-label', paused ? 'Play background animation' : 'Pause background animation');
      toggleEl.title = toggleEl.getAttribute('aria-label');
      queuePlace(true);
      toggleEl.innerHTML = paused
        ? '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>';
    });
  }

  /* Never cover a host's control:
     - a fixed / sticky bar pinned to the bottom (mobile buy bar, cookie
       banner, bottom nav): lift above it, checked on every scroll frame;
     - a small in-flow link or button (a footer link, an inline CTA):
       lift above it, checked once scrolling settles so the control does
       not jump while content streams past. Large targets (cards) stay
       easy to tap with a 32 px corner covered and are left alone.
     The package's own layers are pointer-events:none, so hit-testing
     never sees them. */
  const CONTROL_SELECTOR =
    'a[href],button,input,select,textarea,summary,label,[role="button"],[tabindex]:not([tabindex="-1"])';
  const SMALL_CONTROL = 72; // px: taller than this is a card, not a link
  function blockerTop(x, y, vh, inflow) {
    const hits = document.elementsFromPoint(x, y);
    for (let j = 0; j < hits.length; j++) {
      const h = hits[j];
      if (h === toggleEl || toggleEl.contains(h)) continue;
      let n = h;
      while (n && n !== document.body && n !== document.documentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') {
          const r = n.getBoundingClientRect();
          /* Bars only: anything taller than half the screen is an overlay
             or a layout column, not something to sit above. */
          if (r.bottom >= vh - 2 && r.height < vh * 0.5) return r.top;
          break;
        }
        n = n.parentElement;
      }
      if (inflow) {
        const ctl = h.closest(CONTROL_SELECTOR);
        if (ctl) {
          const r = ctl.getBoundingClientRect();
          if (r.height <= SMALL_CONTROL) return r.top;
        }
      }
      return null; // only the topmost element under the control matters
    }
    return null;
  }
  let lastLift = 0;
  function placeToggle(inflow) {
    if (!toggleEl || toggleEl.hidden) return;
    const vh = global.innerHeight;
    let lift = 0;
    toggleEl.style.setProperty('--motion-toggle-lift', '0px');
    for (let k = 0; k < 4; k++) {
      const r = toggleEl.getBoundingClientRect();
      let top = null;
      const pts = [[2, 2], [16, 16], [30, 30], [30, 2], [2, 30]];
      for (let i = 0; i < pts.length; i++) {
        const t = blockerTop(r.left + pts[i][0], r.top + pts[i][1], vh, inflow);
        if (t !== null) top = top === null ? t : Math.min(top, t);
      }
      if (top === null) break;
      lift += Math.ceil(r.bottom - top) + 8;
      if (lift > vh * 0.6) break;
      toggleEl.style.setProperty('--motion-toggle-lift', lift + 'px');
    }
    /* Mid-scroll passes only know about bars; keep a settled in-flow lift
       until the next settle rather than dropping it on every frame. */
    if (!inflow && lift < lastLift) {
      lift = lastLift;
      toggleEl.style.setProperty('--motion-toggle-lift', lift + 'px');
    }
    if (inflow) lastLift = lift;
  }
  let placeQueued = false;
  let settleTimer = null;
  function queuePlace(settled) {
    if (settled) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => safely('pause control placement', () => placeToggle(true)), 160);
    }
    if (placeQueued) return;
    placeQueued = true;
    global.requestAnimationFrame(() => {
      placeQueued = false;
      safely('pause control placement', () => placeToggle(false));
    });
  }
  function watchTogglePlacement() {
    queuePlace(true);
    global.addEventListener('resize', () => queuePlace(true), { passive: true });
    global.addEventListener('scroll', () => queuePlace(true), { passive: true });
    /* Bars and content that arrive late (banners, client-rendered lists). */
    setTimeout(() => queuePlace(true), 1500);
  }

  global.AurevonMotionBG = { refresh, destroy, pause, play, isPaused, version: VERSION };

  if (!L) return;

  /* The engine refuses to draw bolts while reduced motion is on, and the
     stylesheet hides the layers; the only thing left to do on a change
     is rebuild whatever a client navigation skipped while it was on. */
  if (motionQuery) {
    const onMotionChange = () => {
      if (!isReducedMotion()) refresh();
      else syncToggle();
    };
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onMotionChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onMotionChange);
    }
  }

  /* Init-time gate: with reduced motion on at load there is nothing to
     wire up yet (the control stays hidden too). */
  if (isReducedMotion()) return;

  /* First wiring after load + an idle slot: keeps every layout read and
     canvas allocation off the DOMContentLoaded / load critical path. A
     host that calls refresh() earlier (a client router) still wins. */
  function initialRefresh() {
    const run = () => {
      if (!active) refresh();
    };
    if (typeof global.requestIdleCallback === 'function') global.requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 50);
  }
  if (document.readyState === 'complete') initialRefresh();
  else global.addEventListener('load', initialRefresh, { once: true });

  /* Release resources when the page is really going away. 'pagehide'
     also fires on entry to the back/forward cache, where JS state is
     preserved verbatim — tearing down there would restore a page whose
     fields are all dead. event.persisted tells the two cases apart. */
  global.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    destroy();
  });
})(window);
