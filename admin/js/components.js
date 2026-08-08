/**
 * components.js
 * Small, dependency-free DOM builders reused across app.js / editor.js /
 * preview.js so markup isn't hand-assembled with duplicated innerHTML
 * strings in multiple places.
 */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Generate a short, sufficiently-unique id for drafts/items/questions. */
export function generateId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Slugify free text into an id-safe string (used for category ids). */
export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "general";
}

/** A lightweight toast notification, auto-dismissing. */
let toastContainer = null;
export function showToast(message, type = "info") {
  if (!toastContainer) {
    toastContainer = el("div", { class: "toast-container" });
    document.body.appendChild(toastContainer);
  }
  const toast = el("div", { class: `toast toast-${type}`, text: message });
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 220);
  }, 2600);
}

/**
 * Read a local file (image/audio upload) as a data URL. Everything in this
 * admin runs with "no backend" per spec, so uploaded media is embedded
 * directly as a data: URL in the exported JSON rather than uploaded
 * anywhere — this keeps "nothing uploaded anywhere" literally true.
 */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Format an ISO date string as a short, readable relative-ish label. */
export function formatUpdatedAt(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Simple confirm-style dialog built on <dialog>, returns a Promise<boolean>. */
export function confirmDialog(message, { confirmLabel = "Delete", cancelLabel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    const dialog = el("dialog", { class: "modal modal-sm" });
    const body = el("div", { class: "modal-body" }, [
      el("h2", { text: "Are you sure?" }),
      el("p", { text: message }),
      el("div", { class: "modal-actions" }, [
        el("button", {
          type: "button",
          class: "btn btn-secondary",
          text: cancelLabel,
          onclick: () => {
            dialog.close();
            resolve(false);
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-primary",
          text: confirmLabel,
          onclick: () => {
            dialog.close();
            resolve(true);
          },
        }),
      ]),
    ]);
    dialog.appendChild(body);
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
  });
}
