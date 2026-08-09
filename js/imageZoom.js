/**
 * imageZoom.js
 * A single, reusable full-screen overlay for zooming into a question
 * image. Real two-finger pinch-to-zoom + pan (computed from raw touch
 * points, not a browser built-in), plus double-tap to toggle zoom for
 * quick access without pinching. touch-action:none on the overlay (see
 * css/exam.css) is load-bearing — without it, the browser's own
 * page-zoom gesture would compete with this transform-based zoom and
 * make it feel janky/conflicted, exactly the "smooth" requirement this
 * exists to satisfy.
 *
 * Deliberately NOT wired into groupRenderer.js itself — the shared
 * renderer stays exactly as it was (single source of truth for
 * exam/review/admin-preview); this module is opened via a delegated
 * click listener that exam.js attaches to its own group-content
 * container (see exam.js's bindEvents()), which is what lets it work
 * correctly even though images get rebuilt on every group navigation
 * (a delegated listener on a stable parent doesn't care that its
 * children get replaced).
 */

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_ZOOM = 2.2;

export function initImageZoom(overlayEl, imgEl, closeBtnEl) {
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let lastPinchDistance = null;
  let lastPinchMidpoint = null;
  let panOrigin = null; // { x, y } — pointer position minus current translate, captured at pan start
  let lastTapAt = 0;

  function applyTransform() {
    imgEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  function reset() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    lastPinchDistance = null;
    lastPinchMidpoint = null;
    panOrigin = null;
    applyTransform();
  }

  function open(src, alt) {
    imgEl.src = src;
    imgEl.alt = alt || "Question illustration (zoomed)";
    reset();
    overlayEl.hidden = false;
  }

  function close() {
    overlayEl.hidden = true;
    reset();
  }

  function distanceBetween(t1, t2) {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }
  function midpointOf(t1, t2) {
    return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
  }
  function clampScale(value) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  overlayEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        lastPinchDistance = distanceBetween(e.touches[0], e.touches[1]);
        lastPinchMidpoint = midpointOf(e.touches[0], e.touches[1]);
      } else if (e.touches.length === 1 && scale > 1) {
        panOrigin = { x: e.touches[0].clientX - translateX, y: e.touches[0].clientY - translateY };
      }
    },
    { passive: true }
  );

  overlayEl.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && lastPinchDistance) {
        e.preventDefault(); // stop the page/viewport from also trying to zoom — this is what makes it feel smooth rather than fighting the browser
        const newDistance = distanceBetween(e.touches[0], e.touches[1]);
        const newMidpoint = midpointOf(e.touches[0], e.touches[1]);
        scale = clampScale(scale * (newDistance / lastPinchDistance));
        translateX += newMidpoint.x - lastPinchMidpoint.x;
        translateY += newMidpoint.y - lastPinchMidpoint.y;
        lastPinchDistance = newDistance;
        lastPinchMidpoint = newMidpoint;
        applyTransform();
      } else if (e.touches.length === 1 && panOrigin && scale > 1) {
        e.preventDefault();
        translateX = e.touches[0].clientX - panOrigin.x;
        translateY = e.touches[0].clientY - panOrigin.y;
        applyTransform();
      }
    },
    { passive: false }
  );

  overlayEl.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) lastPinchDistance = null;
    if (e.touches.length === 0) {
      panOrigin = null;
      // Double-tap to toggle zoom — only fires on a clean tap (no pan/pinch happened), checked via the timing gap since the previous touchend.
      const now = Date.now();
      if (now - lastTapAt < DOUBLE_TAP_MS) {
        if (scale > 1) {
          reset();
        } else {
          scale = DOUBLE_TAP_ZOOM;
          applyTransform();
        }
      }
      lastTapAt = now;
    }
  });

  closeBtnEl.addEventListener("click", close);
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) close(); // tap the dark backdrop (not the image itself) to close
  });

  return { open, close };
}
