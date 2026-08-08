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
