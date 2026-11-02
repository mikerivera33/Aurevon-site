/* =========================================================
   AUREVON LABS — Procedural Lightning Engine
   Midpoint-displacement fractal bolt generator with forking
   sub-branches, white-hot core + electric-blue glow, and
   quick flash+fade timing. Three usage modes:
     1. ambient()   — randomized background strikes
     2. strike()    — one-shot bolt between two points (hover/click)
     3. heroStrike() — signature big strike animation on load
   Respects prefers-reduced-motion.

   Performance model:
     - All bolts animate off the single shared AurevonTicker, not a
       per-field requestAnimationFrame loop.
     - A field only draws while it is on-screen (IntersectionObserver)
       and the tab is visible.
     - Ambient scheduling suspends completely on tab hide, so a
       backgrounded tab does no work at all.
   ========================================================= */

(function (global) {
  'use strict';

  const motionQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  /* Live value — users can flip the OS setting without reloading. */
  let reducedMotion = motionQuery ? motionQuery.matches : false;
  if (motionQuery) {
    const onChange = (e) => {
      reducedMotion = e.matches;
      API.REDUCED_MOTION = reducedMotion;
    };
    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', onChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(onChange);
    }
  }

  const COLORS = {
    core: '#e6f4ff',
    inner: '#4da3ff',
    outer: '#0a6cff',
    glow: '#00c2ff',
  };

  const MAX_ACTIVE_BOLTS_GLOBAL = 6;
  const MAX_BOLTS_PER_FIELD = 3;
  const MAX_SEGMENTS = 512;
  let activeBoltCount = 0;

  /* Ticker fallback: if ticker.js failed to load for any reason, the
     lightning must still work rather than silently doing nothing. */
  const ticker = global.AurevonTicker || {
    add(fn) {
      let id = requestAnimationFrame(function step(now) {
        fn(now, 16.7);
        id = requestAnimationFrame(step);
      });
      return {
        remove() {
          cancelAnimationFrame(id);
        },
      };
    },
  };

  /**
   * Generate a fractal lightning path via recursive midpoint displacement.
   * Returns an array of segments: [{x1,y1,x2,y2,width,isBranch}]
   */
  function generateBolt(x1, y1, x2, y2, opts) {
    opts = opts || {};
    const displace = opts.displace ?? 0.5;
    const detail = opts.detail ?? 6;
    const branchChance = opts.branchChance ?? 0.35;
    const maxBranches = opts.maxBranches ?? 4;
    const baseWidth = opts.baseWidth ?? 2.4;

    let branchCount = 0;
    const segments = [];

    function subdivide(ax, ay, bx, by, depth, spread, width, isBranch) {
      /* Hard ceiling: a pathological detail/branch combination must not
         be able to generate an unbounded segment list. */
      if (segments.length >= MAX_SEGMENTS) return;

      if (depth <= 0) {
        segments.push({ x1: ax, y1: ay, x2: bx, y2: by, width, isBranch });
        return;
      }
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      // perpendicular offset
      const nx = -dy / len;
      const ny = dx / len;
      const offset = (Math.random() - 0.5) * 2 * spread;
      const midX = mx + nx * offset;
      const midY = my + ny * offset;

      // possible branch spawn at this midpoint
      if (!isBranch && branchCount < maxBranches && Math.random() < branchChance * (depth / detail)) {
        branchCount++;
        const branchAngle =
          Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.4 + (Math.random() < 0.5 ? -0.5 : 0.5);
        const branchLen = len * (0.25 + Math.random() * 0.35);
        const bx2 = midX + Math.cos(branchAngle) * branchLen;
        const by2 = midY + Math.sin(branchAngle) * branchLen;
        subdivide(midX, midY, bx2, by2, Math.max(1, depth - 2), spread * 0.55, width * 0.45, true);
      }

      const nextSpread = spread * 0.55;
      subdivide(ax, ay, midX, midY, depth - 1, nextSpread, width * 0.92, isBranch);
      subdivide(midX, midY, bx, by, depth - 1, nextSpread, width * 0.92, isBranch);
    }

    const dist = Math.hypot(x2 - x1, y2 - y1);
    const spread = Math.max(6, dist * displace * 0.18);
    subdivide(x1, y1, x2, y2, detail, spread, baseWidth, false);
    return segments;
  }

  /* Three glow passes. Blur radii are deliberately modest: canvas
     shadowBlur is the single most expensive operation in this engine,
     and large radii cost far more than they add visually. */
  const PASSES = [
    { color: COLORS.outer, widthMul: 4.2, blur: 14, alpha: 0.62 },
    { color: COLORS.glow, widthMul: 2.3, blur: 8, alpha: 0.85 },
    { color: COLORS.core, widthMul: 0.8, blur: 0, alpha: 1 },
  ];

  function drawSegments(ctx, segments, progress, alpha, opts) {
    opts = opts || {};
    const cutoff = Math.ceil(segments.length * progress);
    if (cutoff <= 0) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const boost = 1 + (opts.intensity || 0);

    for (let p = 0; p < PASSES.length; p++) {
      const pass = PASSES[p];
      ctx.shadowColor = pass.color;
      ctx.shadowBlur = pass.blur * boost;
      ctx.strokeStyle = pass.color;
      ctx.globalAlpha = alpha * pass.alpha;

      /* Trunk and branch segments are stroked as two separate paths.
         lineWidth applies to a whole stroke() call, not per-subpath, so
         batching everything into one path silently collapsed every
         segment to a single width. Two passes keeps branches visibly
         finer than the trunk while staying at 2 strokes, not N. */
      for (let branch = 0; branch < 2; branch++) {
        const wantBranch = branch === 1;
        let opened = false;
        let widthSum = 0;
        let widthCount = 0;

        ctx.beginPath();
        for (let i = 0; i < cutoff; i++) {
          const s = segments[i];
          if (!!s.isBranch !== wantBranch) continue;
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          widthSum += s.width;
          widthCount++;
          opened = true;
        }
        if (!opened) continue;

        const avgWidth = widthSum / widthCount;
        ctx.lineWidth = Math.max(0.6, avgWidth * pass.widthMul * (wantBranch ? 0.7 : 1));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Bolt object: manages its own lifecycle (flash in, hold, fade out).
   */
  class Bolt {
    constructor(ctx, x1, y1, x2, y2, opts) {
      this.ctx = ctx;
      this.segments = generateBolt(x1, y1, x2, y2, opts);
      this.duration = opts.duration || 400 + Math.random() * 400; // 400-800ms
      this.intensity = opts.intensity || 0;
      this.start = performance.now();
      this.flickers = opts.flicker !== false;
      this.done = false;
      this.onFlashPeak = opts.onFlashPeak || null;
      this._peakFired = false;
    }

    update(now) {
      const t = now - this.start;
      const growPhase = this.duration * 0.35;
      const holdPhase = this.duration * 0.15;
      const fadePhase = this.duration - growPhase - holdPhase;

      let progress, alpha;
      if (t < growPhase) {
        progress = t / growPhase;
        alpha = progress;
      } else if (t < growPhase + holdPhase) {
        progress = 1;
        alpha = this.flickers ? 0.75 + Math.random() * 0.25 : 1;
        if (!this._peakFired) {
          this._peakFired = true;
          if (this.onFlashPeak) {
            /* A callback supplied by page code must never be able to
               abort the animation loop. */
            try {
              this.onFlashPeak();
            } catch (err) {
              /* no-op: visual flourish only */
            }
          }
        }
      } else if (t < this.duration) {
        progress = 1;
        const fadeT = (t - growPhase - holdPhase) / fadePhase;
        alpha = 1 - fadeT;
      } else {
        this.done = true;
        return;
      }
      drawSegments(this.ctx, this.segments, progress, Math.max(0, alpha), {
        intensity: this.intensity,
      });
    }
  }

  /**
   * A LightningField manages a canvas overlay bound to a container element,
   * drawing all active bolts on the shared ticker.
   */
  class LightningField {
    constructor(canvas, opts) {
      opts = opts || {};
      this.canvas = canvas;
      this.ctx = canvas ? canvas.getContext('2d') : null;
      this.bolts = [];
      this.subscription = null;
      this.destroyed = false;
      this.visible = true;
      this.width = 1;
      this.height = 1;

      /* A field that never got a 2D context stays inert rather than
         throwing on every call. */
      if (!this.ctx) return;

      /* Full-viewport overlays pay for every device pixel each frame, so
         they get a tighter DPR cap than small element-sized fields. */
      const dprCap = opts.dprCap ?? 2;
      this.dpr = Math.min(window.devicePixelRatio || 1, dprCap);

      this._resize();

      if (typeof ResizeObserver === 'function') {
        /* Coalesce resize work into the next frame: a drag-resize fires
           dozens of callbacks, and each one reallocates the backing store. */
        this._ro = new ResizeObserver(() => {
          if (this._resizePending) return;
          this._resizePending = true;
          requestAnimationFrame(() => {
            this._resizePending = false;
            if (!this.destroyed) this._resize();
          });
        });
        this._ro.observe(canvas);
      }

      if (typeof IntersectionObserver === 'function') {
        this._io = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) this.visible = entry.isIntersecting;
          },
          { threshold: 0 }
        );
        this._io.observe(canvas);
      }
    }

    _resize() {
      if (!this.ctx || this.destroyed) return;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      const bw = Math.round(w * this.dpr);
      const bh = Math.round(h * this.dpr);
      this.width = w;
      this.height = h;
      /* Assigning canvas.width/height clears the canvas and reallocates,
         so only do it when the pixel size actually changed. */
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    addBolt(x1, y1, x2, y2, opts) {
      if (reducedMotion || this.destroyed || !this.ctx) return null;
      if (activeBoltCount >= MAX_ACTIVE_BOLTS_GLOBAL) return null;
      if (this.bolts.length >= MAX_BOLTS_PER_FIELD) return null;
      activeBoltCount++;
      const bolt = new Bolt(this.ctx, x1, y1, x2, y2, opts || {});
      this.bolts.push(bolt);
      this._start();
      return bolt;
    }

    _start() {
      if (this.subscription || this.destroyed) return;
      this.subscription = ticker.add((now) => this._tick(now));
    }

    _tick(now) {
      if (this.destroyed) return;
      this.ctx.clearRect(0, 0, this.width, this.height);

      /* Off-screen fields still retire their bolts (so the global budget
         is released) but skip the expensive draw work entirely. */
      const draw = this.visible;
      for (let i = 0; i < this.bolts.length; i++) {
        const b = this.bolts[i];
        if (draw) {
          b.update(now);
        } else if (now - b.start >= b.duration) {
          b.done = true;
        }
      }

      const before = this.bolts.length;
      this.bolts = this.bolts.filter((b) => !b.done);
      /* Clamp: the global counter must never drift below zero, or the
         budget silently shrinks and lightning stops page-wide. */
      activeBoltCount = Math.max(0, activeBoltCount - (before - this.bolts.length));

      if (this.bolts.length === 0) this._stop();
    }

    _stop() {
      if (this.subscription) {
        this.subscription.remove();
        this.subscription = null;
      }
      if (this.ctx) this.ctx.clearRect(0, 0, this.width, this.height);
    }

    destroy() {
      this.destroyed = true;
      /* Release this field's share of the global budget. */
      activeBoltCount = Math.max(0, activeBoltCount - this.bolts.length);
      this.bolts = [];
      this._stop();
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
    }
  }

  /* ---------------------------------------------------------
     Public API
     --------------------------------------------------------- */

  function createField(canvas, opts) {
    return new LightningField(canvas, opts);
  }

  /**
   * Ambient mode — periodically strike random bolts across a field
   * at randomized positions/intervals so no two loads feel identical.
   *
   * Scheduling is fully suspended while the tab is hidden: a background
   * tab does zero work instead of queuing strikes nobody can see.
   */
  function ambient(field, opts) {
    if (reducedMotion || !field || !field.ctx) return { stop() {} };
    opts = opts || {};
    const minInterval = opts.minInterval ?? 1200;
    const maxInterval = opts.maxInterval ?? 3400;
    let stopped = false;
    let timer = null;

    function scheduleNext() {
      if (stopped || document.hidden) return;
      const delay = minInterval + Math.random() * (maxInterval - minInterval);
      timer = setTimeout(() => {
        timer = null;
        if (stopped) return;
        /* Skip the strike if the field is scrolled out of view, but keep
           the schedule alive so it resumes seamlessly. */
        if (field.visible) strikeRandom();
        scheduleNext();
      }, delay);
    }

    function clear() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function strikeRandom() {
      const w = field.width;
      const h = field.height;
      if (w < 10 || h < 10) return;
      // strike from a random point near top to a point below it — vertical-ish bolts
      const x1 = Math.random() * w;
      const y1 = Math.random() * h * 0.25;
      const x2 = x1 + (Math.random() - 0.5) * w * 0.35;
      const y2 = y1 + h * (0.4 + Math.random() * 0.55);
      field.addBolt(x1, y1, Math.max(0, Math.min(w, x2)), Math.min(h, y2), {
        detail: 6,
        branchChance: 0.4,
        maxBranches: 3,
        baseWidth: 2.2 + Math.random() * 1.6,
        duration: 400 + Math.random() * 400,
        intensity: 0.35,
      });
    }

    function onVisibility() {
      if (stopped) return;
      if (document.hidden) clear();
      else if (timer === null) scheduleNext();
    }

    document.addEventListener('visibilitychange', onVisibility);
    scheduleNext();

    return {
      stop() {
        stopped = true;
        clear();
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }

  /**
   * One-shot strike between two points — for hover/click activation.
   */
  function strike(field, x1, y1, x2, y2, opts) {
    if (!field) return null;
    return field.addBolt(x1, y1, x2, y2, opts);
  }

  /**
   * Strike bolts converging on / radiating from a target point —
   * used for button/card crackle effects.
   */
  function crackle(field, cx, cy, opts) {
    if (reducedMotion || !field || !field.ctx) return;
    opts = opts || {};
    const count = opts.count ?? 2;
    const radius = opts.radius ?? Math.max(field.width, field.height) * 0.55;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = radius * (0.5 + Math.random() * 0.5);
      const x1 = cx + Math.cos(angle) * dist;
      const y1 = cy + Math.sin(angle) * dist;
      setTimeout(() => {
        if (field.destroyed) return;
        field.addBolt(x1, y1, cx, cy, {
          detail: 6,
          branchChance: 0.55,
          maxBranches: 5,
          baseWidth: 2.8 + Math.random() * 1.6,
          duration: 340 + Math.random() * 260,
          intensity: 0.85,
          onFlashPeak: opts.onFlashPeak,
        });
      }, i * 60);
    }
  }

  /**
   * Signature hero strike — one big, dramatic bolt (plus forks) that
   * flashes brightly and briefly lights the hero on load.
   */
  function heroStrike(field, opts) {
    if (reducedMotion || !field || !field.ctx) return null;
    opts = opts || {};
    const w = field.width;
    const h = field.height;
    const x1 = w * (0.15 + Math.random() * 0.2);
    const y1 = -10;
    const x2 = w * (0.55 + Math.random() * 0.3);
    const y2 = h * 0.98;

    const bolt = field.addBolt(x1, y1, x2, y2, {
      detail: 8,
      branchChance: 0.55,
      maxBranches: 6,
      baseWidth: 4.5,
      duration: 340,
      onFlashPeak: opts.onFlashPeak,
    });

    // secondary companion bolt slightly offset for extra drama
    setTimeout(() => {
      if (field.destroyed) return;
      field.addBolt(x1 + w * 0.12, 0, x2 - w * 0.08, h * 0.7, {
        detail: 6,
        branchChance: 0.4,
        maxBranches: 3,
        baseWidth: 2,
        duration: 220,
      });
    }, 40);

    return bolt;
  }

  const API = {
    createField,
    ambient,
    strike,
    crackle,
    heroStrike,
    REDUCED_MOTION: reducedMotion,
  };

  global.AurevonLightning = API;
})(window);
