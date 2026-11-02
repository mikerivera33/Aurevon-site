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
   order). Exposes window.AurevonMotionBG = { refresh, destroy } so
   client-routed apps can re-wire the hero and crackle targets after a
   navigation without reloading the page-wide layers.

   Hero detection (first match wins):
     [data-motion-hero]  → explicit opt-in (preferred)
     section#top, section.hero, header.hero
     the first <section> inside <main>, else the first <section>
   ========================================================= */
(function (global) {
  'use strict';

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
      const matches = document.querySelectorAll(HERO_SELECTORS[i]);
      for (let j = 0; j < matches.length; j++) {
        if (isRendered(matches[j])) return matches[j];
      }
    }
    return null;
  }

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
  function wireHero() {
    const hero = findHero();
    if (heroState && heroState.el === hero && heroState.canvas.isConnected) return;
    unwireHero();
    if (!hero) return;

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
      heroState.el.classList.remove('motion-hero');
    });
    heroState = null;
  }

  /* ---------------- Page-wide ambient bolts ---------------- */
  function wirePage() {
    if (pageWired) return;
    pageWired = true;
    safely('page lightning', function () {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.className = 'page-lightning-layer';
      document.body.appendChild(canvas);
      /* Full viewport: the most expensive surface per frame — cap DPR harder. */
      const field = L.createField(canvas, { dprCap: 1.5 });
      pageFields.push(field);
      L.ambient(field, { minInterval: 5000, maxInterval: 12000 });
    });
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
  function refresh() {
    if (!L || isReducedMotion()) return;
    ensureFlash();
    pruneDetached();
    wirePage();
    wireHero();
    wireCrackle();
  }

  function destroy() {
    unwireHero();
    [].concat(pageFields, crackleFields).forEach((f) => {
      try {
        f.destroy();
      } catch (err) {
        /* already gone */
      }
    });
  }

  global.AurevonMotionBG = { refresh, destroy };

  /* Init-time gate: with reduced motion on at load there is nothing to
     wire up. Flipping the setting later does not retroactively build
     the layers — the user asked not to see them. */
  if (!L || isReducedMotion()) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true });
  } else {
    refresh();
  }

  /* Release resources when the page is really going away. 'pagehide'
     also fires on entry to the back/forward cache, where JS state is
     preserved verbatim — tearing down there would restore a page whose
     fields are all dead. event.persisted tells the two cases apart. */
  global.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    destroy();
  });
})(window);
