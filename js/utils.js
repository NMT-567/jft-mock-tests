/**
 * utils.js
 * Small, dependency-free helper functions shared across the app.
 */

/** Format seconds as HH:MM:SS */
export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

/** Escape a string for safe insertion into HTML text nodes (options, plain text). */
export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Render question/passage/explanation text that intentionally contains a
 * limited set of safe inline formatting tags coming from the JSON source
 * (<br>, <b>, <strong>, <u>, <i>, <em>, <s>, <mark>, <p>, <div>, <span>),
 * while stripping everything else (script/style/iframe/object/embed/link,
 * any other tag, and every attribute on every tag — so no onclick/style/
 * href/src ever survives, even on an otherwise-allowed tag).
 *
 * Parses via a <template> element specifically because its .content is
 * inert: setting innerHTML on a <template> never executes scripts, never
 * loads images/iframes/audio, and never runs event handlers — it's just
 * a parse tree, safe to walk before anything is shown. Only after that
 * walk rebuilds a tree using nothing but freshly-created, attribute-free
 * allowed elements does the result ever become real, live-DOM-bound HTML.
 */
const RICH_TEXT_ALLOWED_TAGS = new Set(["br", "b", "strong", "u", "i", "em", "s", "mark", "p", "div", "span"]);
const RICH_TEXT_DROPPED_TAGS = new Set(["script", "style", "iframe", "object", "embed", "link", "noscript"]);

export function renderRichText(str) {
  if (!str) return "";
  const template = document.createElement("template");
  template.innerHTML = String(str);
  const clean = document.createElement("div");
  sanitizeRichTextInto(template.content, clean);
  return clean.innerHTML;
}

function sanitizeRichTextInto(sourceNode, targetParent) {
  sourceNode.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      targetParent.appendChild(document.createTextNode(node.textContent));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return; // comments, etc. — drop
    const tag = node.tagName.toLowerCase();
    if (RICH_TEXT_DROPPED_TAGS.has(tag)) return; // drop entirely, including its text content
    if (RICH_TEXT_ALLOWED_TAGS.has(tag)) {
      const el = document.createElement(tag); // no attributes ever copied over
      sanitizeRichTextInto(node, el);
      targetParent.appendChild(el);
    } else {
      sanitizeRichTextInto(node, targetParent); // unknown tag — unwrap it, keep its safe children
    }
  });
}

/** Shuffle a copy of an array (Fisher-Yates). Never mutates the input. */
export function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Read a query-string parameter from the current URL. */
export function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/** Debounce a function call. */
export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Clamp a number between min and max. */
export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/** Hide the full-page loader overlay, if present on the page. */
export function hidePageLoader() {
  const loader = document.getElementById("pageLoader");
  if (loader) loader.classList.add("hidden");
}

/** Apply the persisted theme preference to the document root. */
export function applyStoredTheme() {
  const theme = localStorage.getItem("nmt_theme") || "light";
  document.documentElement.setAttribute("data-theme", theme);
  return theme;
}

/** Toggle + persist the dark mode theme, wiring up a toggle button if given. */
export function initThemeToggle(buttonEl) {
  applyStoredTheme();
  if (!buttonEl) return;
  const current = document.documentElement.getAttribute("data-theme") || "light";
  buttonEl.setAttribute("aria-pressed", String(current === "dark"));
  buttonEl.addEventListener("click", () => {
    const now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", now);
    localStorage.setItem("nmt_theme", now);
    buttonEl.setAttribute("aria-pressed", String(now === "dark"));
  });
}

/** Populate every element with id="year" with the current year. */
export function stampYear() {
  const el = document.getElementById("year");
  if (el) el.textContent = String(new Date().getFullYear());
}

/**
 * Two-finger pinch-to-zoom, wired into the SAME zoom system the
 * existing +/- buttons already drive (a `zoomLevel` variable snapped
 * to a fixed `levels` array, applied via a `--exam-zoom` CSS custom
 * property — see css/exam.css's `#groupContent { zoom: var(--exam-zoom) }`
 * and css/review.css's equivalent rule). Added specifically because
 * the browser's OWN native pinch-zoom (the viewport meta tag already
 * allows it) does not work while an element is in Fullscreen API
 * fullscreen on most mobile browsers — a real platform limitation,
 * not something fixable via viewport/meta/CSS alone — so exam/review
 * content would otherwise be un-zoomable for the entire time
 * fullscreen is enforced. This reimplements the gesture at the JS
 * level and drives the app's own existing zoom mechanism instead,
 * which works identically whether or not fullscreen is active.
 *
 * @param {{getLevel: () => number, setLevel: (n: number) => void, levels: number[]}} config
 *   getLevel/setLevel read and apply the caller's own zoomLevel
 *   variable (via its own applyZoom()-style function) so this stays a
 *   thin gesture-recognizer with no zoom logic of its own to
 *   duplicate or drift out of sync with the +/- buttons.
 * @returns {{teardown: () => void}}
 */
export function initPinchZoom({ getLevel, setLevel, levels }) {
  let startDistance = null;
  let startLevel = null;

  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function nearestLevel(target) {
    return levels.reduce((prev, curr) => (Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev));
  }

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      startDistance = touchDistance(e.touches);
      startLevel = getLevel();
    }
  }

  function onTouchMove(e) {
    if (e.touches.length !== 2 || startDistance === null) return;
    // Must actually prevent default here (this listener is registered
    // non-passive) — otherwise the browser's own page-scroll/pinch
    // gesture recognizer fights this one for the same two touch
    // points, and neither ends up feeling responsive.
    e.preventDefault();
    const scaleFactor = touchDistance(e.touches) / startDistance;
    const target = nearestLevel(startLevel * scaleFactor);
    if (target !== getLevel()) setLevel(target);
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) {
      startDistance = null;
      startLevel = null;
    }
  }

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return {
    teardown: () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    },
  };
}

/**
 * Registers sw-assets.js — a narrow-scope Service Worker that only
 * caches external R2 image/audio assets (see that file's own header
 * comment for exactly what it does and doesn't touch). Called here,
 * at module load, because this file is already imported by every page
 * on the site, student and admin alike — one registration point covers
 * everything without touching each page's own controller. Resolved via
 * import.meta.url (this file's own location) rather than a hardcoded
 * path, so it works correctly regardless of whether the importing page
 * is a root page or under /admin/, and regardless of the site's actual
 * deployed subpath (e.g. GitHub Pages' /jft-mock-tests/). Registering
 * an already-registered Service Worker is a harmless no-op, so this is
 * safe to run on every page load.
 */
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(new URL("../sw-assets.js", import.meta.url)).catch(() => {
    // Non-fatal — the app works identically without it, just without
    // the R2 asset caching benefit. Never let this break page load.
  });
}
