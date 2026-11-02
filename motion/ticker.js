/* =========================================================
   AUREVON LABS — Shared animation ticker

   Every animated subsystem on this page (lightning fields, the
   mission diagram, the WebGL scenes) used to run its own
   requestAnimationFrame loop. With ~27 lightning fields that meant
   dozens of independent loops competing for the same 16ms budget.

   This module owns ONE rAF loop for the whole page and fans it out
   to subscribers. It also:
     - stops entirely when nothing is subscribed (zero idle cost)
     - pauses while the tab is hidden, so background tabs burn no CPU
     - clamps delta time so a long pause can't produce a huge jump
     - survives a throwing subscriber without killing the others

   Exposed as a classic script (window.AurevonTicker) so both classic
   scripts and ES modules can use it without a build step.
   ========================================================= */
(function (global) {
  'use strict';

  const subscribers = new Set();
  let rafId = null;
  let running = false;
  let lastNow = 0;

  /* Cap the delta so returning to a backgrounded tab doesn't hand
     animations a multi-second jump (which reads as a glitch). */
  const MAX_DELTA = 50;

  function frame(now) {
    rafId = null;
    if (!running) return;

    const delta = lastNow ? Math.min(now - lastNow, MAX_DELTA) : 16.7;
    lastNow = now;

    /* Snapshot: a subscriber may unsubscribe itself (or others) mid-tick. */
    const current = Array.from(subscribers);
    for (let i = 0; i < current.length; i++) {
      const fn = current[i];
      if (!subscribers.has(fn)) continue;
      try {
        fn(now, delta);
      } catch (err) {
        /* One broken animation must never take down the others.
           Drop the offender and keep the page moving. */
        subscribers.delete(fn);
        if (global.console && console.warn) {
          console.warn('Aurevon ticker: subscriber removed after error', err);
        }
      }
    }

    if (subscribers.size > 0 && running) {
      rafId = requestAnimationFrame(frame);
    } else {
      running = false;
    }
  }

  function start() {
    if (running || subscribers.size === 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    running = true;
    lastNow = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function add(fn) {
    if (typeof fn !== 'function') return { remove() {} };
    subscribers.add(fn);
    start();
    return {
      remove() {
        subscribers.delete(fn);
        if (subscribers.size === 0) stop();
      },
    };
  }

  function remove(fn) {
    subscribers.delete(fn);
    if (subscribers.size === 0) stop();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
  }

  /* Restoring from the back/forward cache does not reliably produce a
     visibilitychange: the document was already visible when it was
     frozen, so there is no change to report. Without this, a Back
     navigation could restore a page whose subscribers are all intact
     but whose loop is parked, and the site would come back frozen.
     start() is idempotent, so firing it on a normal load is harmless. */
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) start();
    });
  }

  global.AurevonTicker = {
    add,
    remove,
    start,
    stop,
    get size() {
      return subscribers.size;
    },
    get hidden() {
      return typeof document !== 'undefined' && document.hidden;
    },
  };
})(window);
