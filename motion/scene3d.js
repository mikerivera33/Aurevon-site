/* =========================================================
   AUREVON LABS — 3D Ambient Motion Background
   Lightweight Three.js scene: a slowly drifting particle
   field plus a faint wireframe grid, in near-black tones with
   Aurevon Electric Blue highlights. Continuous rotation/drift
   (no reset, no start/end state) means it loops infinitely
   with zero visible seam. Freezes on prefers-reduced-motion.

   Resilience:
     - Survives WebGL context loss (GPU reset, driver recovery,
       laptop GPU switch) instead of leaving a permanently black
       canvas.
     - Renders on the shared ticker, so it pauses with every other
       animation when the tab is hidden.
     - Pauses when scrolled off screen.
   ========================================================= */

/* Imported by relative path rather than via a bare "three" specifier so
   the page needs no inline <script type="importmap">, which in turn lets
   the CSP stay at script-src 'self'. */
import * as THREE from './vendor/three.module.min.js';

const REDUCED_MOTION =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

export function initScene3D(canvas, options) {
  if (!canvas) return null;
  const opts = options || {};
  const particleCount = opts.particleCount ?? 420;
  const nodeCount = opts.nodeCount ?? 18;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: opts.antialias ?? true,
      alpha: true,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    });
  } catch (err) {
    /* No WebGL (blocked, unsupported, or too many live contexts). */
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.dprCap ?? 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 0, 9);

  /* ---------- Particle field (drifting + rotating) ---------- */
  const positions = new Float32Array(particleCount * 3);

  for (let i = 0; i < particleCount; i++) {
    // distribute within a wide flattened sphere for depth parallax
    const r = 4 + Math.random() * 9;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.55; // flatten vertically
    positions[i * 3 + 2] = r * Math.cos(phi) * 0.6 - 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const canvasSize = 64;
  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = canvasSize;
  spriteCanvas.height = canvasSize;
  const sctx = spriteCanvas.getContext('2d');
  const grad = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(230,244,255,1)');
  grad.addColorStop(0.35, 'rgba(0,194,255,0.85)');
  grad.addColorStop(1, 'rgba(10,108,255,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, canvasSize, canvasSize);
  const spriteTexture = new THREE.CanvasTexture(spriteCanvas);

  const material = new THREE.PointsMaterial({
    size: 0.16,
    map: spriteTexture,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  scene.add(points);

  /* ---------- Faint wireframe grid plane for depth cue ---------- */
  const gridGeo = new THREE.PlaneGeometry(30, 30, 24, 24);
  const gridMat = new THREE.MeshBasicMaterial({
    color: 0x0a6cff,
    wireframe: true,
    transparent: true,
    opacity: 0.08,
  });
  const grid = new THREE.Mesh(gridGeo, gridMat);
  grid.rotation.x = -Math.PI / 2.35;
  grid.position.y = -3.2;
  grid.position.z = -4;
  scene.add(grid);

  /* ---------- Sparse larger nodes with subtle glow, extra depth accents ---------- */
  const nodeGeo = new THREE.IcosahedronGeometry(0.05, 0);
  const nodeMat = new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.7 });
  const nodeGroup = new THREE.Group();
  for (let i = 0; i < nodeCount; i++) {
    const m = new THREE.Mesh(nodeGeo, nodeMat);
    const r = 3 + Math.random() * 7;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    m.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta) * 0.5,
      r * Math.cos(phi) * 0.6 - 2
    );
    nodeGroup.add(m);
  }
  scene.add(nodeGroup);

  const ticker = window.AurevonTicker || null;

  let width = 1;
  let height = 1;
  let subscription = null;
  let disposed = false;
  let contextLost = false;
  let onScreen = false;

  function resize() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  let resizePending = false;
  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          /* Coalesce: a drag-resize fires continuously and each resize
             reallocates GPU buffers. */
          if (resizePending) return;
          resizePending = true;
          requestAnimationFrame(() => {
            resizePending = false;
            resize();
          });
        })
      : null;
  if (ro) ro.observe(canvas);
  resize();

  // continuous, un-bounded rotation — never resets, so there's no seam to see
  const ROTATE_SPEED = 0.00028; // rad/ms — slow, cinematic
  const clockStart = performance.now();

  function renderFrame(now) {
    if (contextLost || disposed) return;
    const t = now - clockStart;
    points.rotation.y = t * ROTATE_SPEED;
    points.rotation.x = Math.sin(t * 0.00006) * 0.08;
    nodeGroup.rotation.y = t * ROTATE_SPEED * 0.7;
    grid.rotation.z = Math.sin(t * 0.00004) * 0.03;

    // subtle breathing drift (still seamless/periodic)
    const breathe = Math.sin(t * 0.00018) * 0.25;
    points.position.y = breathe * 0.15;
    camera.position.x = Math.sin(t * 0.00009) * 0.4;
    camera.position.y = Math.cos(t * 0.00011) * 0.25;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }

  function start() {
    if (subscription || disposed || contextLost) return;
    if (REDUCED_MOTION) {
      // freeze-frame fallback: render exactly one static frame, no loop
      renderFrame(performance.now());
      return;
    }
    if (ticker) {
      subscription = ticker.add((now) => renderFrame(now));
    } else {
      let id;
      const loop = (now) => {
        renderFrame(now);
        id = requestAnimationFrame(loop);
      };
      id = requestAnimationFrame(loop);
      subscription = { remove: () => cancelAnimationFrame(id) };
    }
  }

  function stop() {
    if (!subscription) return;
    subscription.remove();
    subscription = null;
  }

  /* ---------- WebGL context loss / restore ----------
     Without preventDefault() the browser will not attempt to restore the
     context, and the canvas stays black for the rest of the session. */
  function handleContextLost(event) {
    event.preventDefault();
    contextLost = true;
    stop();
  }

  function handleContextRestored() {
    contextLost = false;
    /* three.js reinitialises its internal GL state on restore; we just
       need to re-apply size and resume drawing. */
    try {
      resize();
    } catch (err) {
      /* if this fails the scene stays paused rather than throwing */
      return;
    }
    if (onScreen) start();
  }

  canvas.addEventListener('webglcontextlost', handleContextLost, false);
  canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

  function dispose() {
    disposed = true;
    stop();
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    canvas.removeEventListener('webglcontextlost', handleContextLost);
    canvas.removeEventListener('webglcontextrestored', handleContextRestored);
    geometry.dispose();
    material.dispose();
    spriteTexture.dispose();
    gridGeo.dispose();
    gridMat.dispose();
    nodeGeo.dispose();
    nodeMat.dispose();
    renderer.dispose();
  }

  // Pause rendering when off-screen (perf) — resume respects reduced-motion state
  let io = null;
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          onScreen = entry.isIntersecting;
          if (onScreen) start();
          else stop();
        });
      },
      { threshold: 0.01 }
    );
    io.observe(canvas);
  } else {
    onScreen = true;
    start();
  }

  return { start, stop, dispose, resize };
}
