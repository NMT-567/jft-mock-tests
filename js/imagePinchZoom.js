/**
 * imagePinchZoom.js
 * Two-finger pinch-to-zoom directly on a question image, in place —
 * no lightbox/overlay, no tap-to-open. Zooming is a pure CSS
 * `transform: scale()` on the <img> itself, which is deliberately why
 * this can never shift surrounding text: `transform` is a paint-time
 * visual effect that does not participate in layout/reflow at all —
 * the image's own box (and everything around it) stays exactly the
 * size and position it already was, scaled or not.
 *
 * Delegated on a STABLE container (exam.js passes els.groupContent),
 * not attached to the image directly — the image gets torn down and
 * rebuilt on every group navigation (see exam.js's
 * renderGroupContent()), so a listener on the image itself would be
 * lost each time; a listener on the never-replaced parent keeps
 * working regardless of how many times its children are replaced.
 *
 * Deliberately does NOT call preventDefault() on a single-finger touch
 * — only ever on an active two-finger pinch — so normal one-finger
 * page scrolling through/over the image continues to work exactly as
 * before. That's also why this never sets `touch-action: none` on
 * anything: that CSS property would block single-finger scroll too,
 * which this explicitly must not do.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 3;

export function initImagePinchZoom(containerEl) {
  const IMAGE_SELECTOR = ".question-image-wrap img, .group-media-wrap img";

  // Only one image is ever on screen at a time in this exam (one shared
  // group image, or one single-question image) — a single mutable
  // gesture-state object is enough; no need to key it per-element.
  let activeImg = null;
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let lastDistance = null;
  let lastMidpoint = null;

  function applyTransform() {
    if (activeImg) activeImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  function resetIfDifferentImage(img) {
    if (img !== activeImg) {
      // Navigated to a different image (or this is the first touch on
      // this one) — start that image's own zoom state fresh rather than
      // carrying over a previous image's scale/position.
      if (activeImg) {
        activeImg.style.transform = "";
      }
      activeImg = img;
      scale = 1;
      translateX = 0;
      translateY = 0;
    }
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

  containerEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 2) return;
      const wrapper = e.target.closest(".question-image-wrap, .group-media-wrap");
      if (!wrapper) return;
      const img = wrapper.querySelector("img");
      if (!img) return;
      resetIfDifferentImage(img);
      lastDistance = distanceBetween(e.touches[0], e.touches[1]);
      lastMidpoint = midpointOf(e.touches[0], e.touches[1]);
    },
    { passive: true }
  );

  containerEl.addEventListener(
    "touchmove",
    (e) => {
      // Exactly two touches AND an active gesture already started on
      // THIS element — anything else (one finger, or two fingers that
      // didn't start on an image) is left completely alone, so normal
      // page scrolling is never intercepted.
      if (e.touches.length !== 2 || !lastDistance || !activeImg) return;
      e.preventDefault(); // only for the active 2-finger pinch — stops the page/viewport from also trying to zoom at the same time, which is what keeps this feeling smooth rather than fighting the browser
      const newDistance = distanceBetween(e.touches[0], e.touches[1]);
      const newMidpoint = midpointOf(e.touches[0], e.touches[1]);
      scale = clampScale(scale * (newDistance / lastDistance));
      translateX += newMidpoint.x - lastMidpoint.x;
      translateY += newMidpoint.y - lastMidpoint.y;
      lastDistance = newDistance;
      lastMidpoint = newMidpoint;
      applyTransform();
    },
    { passive: false }
  );

  containerEl.addEventListener("touchend", (e) => {
    // Below two touches ends the active PINCH tracking, but deliberately
    // keeps the current scale/position — lifting one finger mid-pinch
    // (or finishing) should not snap the image back to normal size.
    if (e.touches.length < 2) {
      lastDistance = null;
      lastMidpoint = null;
    }
  });
}
