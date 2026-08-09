/**
 * security.js
 * Best-effort exam-integrity lockdown for the exam screen only.
 *
 * HONESTY NOTE (read before changing thresholds):
 * None of this can guarantee a student cannot cheat or capture the screen.
 * Browsers give a web page no privileged access to the OS, so:
 *   - Right-click / copy / paste / select / drag / most shortcuts CAN be
 *     reliably intercepted via preventDefault() — these actually work.
 *   - The PrintScreen key CANNOT be intercepted by a web page at all (the
 *     OS handles it before JS ever sees it) — we do not attempt to.
 *   - F11 fullscreen toggle and OS-level screenshot/recording tools
 *     (Snipping Tool, phone screen recording, a second camera pointed at
 *     the screen) cannot be blocked either — the tab-visibility violation
 *     counter below is a deterrent + record of the behavior, not a block,
 *     and is disclosed as such. It intentionally does NOT hide, blur, or
 *     freeze the exam indefinitely — see initVisibilityGuard.
 *   - DevTools detection is a heuristic (window size deltas) and can have
 *     false positives (e.g. a docked mobile keyboard, split-screen apps)
 *     or false negatives (undocked DevTools windows). Tune thresholds
 *     conservatively and never claim it is 100% reliable.
 */

const DEVTOOLS_SIZE_THRESHOLD = 160; // px gap between outer/inner size that suggests a docked devtools panel
const DEVTOOLS_POLL_INTERVAL_MS = 1000;
const DEVTOOLS_TERMINATE_AFTER_WARNINGS = 2; // auto-submit after this many distinct detections

const BLOCKED_KEY_COMBOS = [
  { ctrlOrMeta: true, key: "c" },
  { ctrlOrMeta: true, key: "v" },
  { ctrlOrMeta: true, key: "x" },
  { ctrlOrMeta: true, key: "a" },
  { ctrlOrMeta: true, key: "p" },
  { ctrlOrMeta: true, key: "s" },
  { ctrlOrMeta: true, key: "u" },
  { ctrlOrMeta: true, shift: true, key: "i" },
  { ctrlOrMeta: true, shift: true, key: "j" },
  { ctrlOrMeta: true, shift: true, key: "c" },
];

/**
 * Disable right-click context menu, text selection, dragging, and the
 * copy/cut/paste clipboard events — individually, per `enabledKinds`, so
 * an admin-configurable subset can be active rather than all-or-nothing.
 * Scoped to whatever root element is passed (typically document.body on
 * the exam page only).
 *
 * `enabledKinds` — e.g. `{ copy_attempt: true, paste_attempt: false }` —
 * an event whose kind isn't truthy here is left completely alone (not
 * prevented, not reported).
 *
 * `onAttempt(kind)` — optional, called only for actually-blocked attempts,
 * so a caller can show a small toast or log a security event without this
 * file needing to know anything about toasts, logging, or messaging.
 */
export function lockdownInputSurface(root = document, enabledKinds = {}, onAttempt) {
  const kindByEvent = {
    contextmenu: "context_menu_attempt",
    selectstart: "select_attempt",
    dragstart: "drag_attempt",
    copy: "copy_attempt",
    cut: "cut_attempt",
    paste: "paste_attempt",
  };
  const handlers = {};
  Object.entries(kindByEvent).forEach(([evt, kind]) => {
    handlers[evt] = (e) => {
      if (!enabledKinds[kind]) return;
      e.preventDefault();
      onAttempt?.(kind);
    };
  });
  Object.entries(handlers).forEach(([evt, fn]) => root.addEventListener(evt, fn));
  return () => Object.entries(handlers).forEach(([evt, fn]) => root.removeEventListener(evt, fn));
}

/**
 * Block the keyboard shortcuts listed in BLOCKED_KEY_COMBOS, plus F12 and
 * (best-effort only — most browsers reserve this) F11, PrintScreen-adjacent
 * combos, and OS screenshot shortcuts where the browser actually exposes
 * the keydown event.
 *
 * SCREENSHOT HONESTY NOTE: PrintScreen itself is consumed by the OS before
 * a web page's JS ever runs — there is no event to intercept, full stop,
 * and this function does not pretend otherwise. Win+Shift+S (Windows) and
 * Cmd+Shift+3/4/5 (macOS) are less consistent: some OS/browser versions do
 * dispatch a normal keydown for these that preventDefault() can suppress,
 * others consume them at the OS level exactly like PrintScreen. This
 * function attempts to intercept them because doing so is free when it
 * works and harmless when it doesn't — it is deterrence, not a guarantee.
 */
export function blockKeyboardShortcuts() {
  const handler = (e) => {
    const key = e.key.toLowerCase();

    if (key === "f12") {
      e.preventDefault();
      return;
    }
    if (key === "f11") {
      // Most browsers reserve F11 for the OS/browser chrome and will not
      // let a page's preventDefault stop it — attempted best-effort only.
      e.preventDefault();
      return;
    }
    // macOS screenshot shortcuts (Cmd+Shift+3/4/5) — best-effort, see note above.
    if (e.metaKey && e.shiftKey && ["3", "4", "5"].includes(key)) {
      e.preventDefault();
      return;
    }
    // Windows Snipping Tool (Win+Shift+S) — the "meta" key here is the
    // Windows key, which browsers expose inconsistently; attempted anyway.
    if (e.metaKey && e.shiftKey && key === "s") {
      e.preventDefault();
      return;
    }

    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    for (const combo of BLOCKED_KEY_COMBOS) {
      const ctrlMatches = !combo.ctrlOrMeta || ctrlOrMeta;
      const shiftMatches = !combo.shift || e.shiftKey;
      if (ctrlMatches && shiftMatches && key === combo.key) {
        e.preventDefault();
        return;
      }
    }
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

/**
 * Reusable content-protection wrapper for pages that need the exam's
 * anti-copy/anti-selection posture WITHOUT the exam-only mechanics
 * (fullscreen enforcement, devtools auto-submit, tab-switch violation
 * counting) — currently used by result.js and review.js. Deliberately a
 * thin composition of lockdownInputSurface() + blockKeyboardShortcuts(),
 * not a second implementation of either — see the SECURITY OVERLAY
 * SAFETY discipline in the module header: nothing here renders an
 * overlay of any kind, so there is nothing that can end up swallowing
 * clicks the way earlier sessions' overlay bugs did.
 *
 * `root` should be the specific content container to protect (e.g. the
 * page's <main>), NOT document.body — this keeps the header/nav/buttons
 * outside the lockdown so they're never affected. blockKeyboardShortcuts
 * is inherently document-wide (keyboard shortcuts aren't scoped to an
 * element) and is shared with the exam page's own call to it, not
 * duplicated.
 *
 * Returns a single teardown function.
 */
export function initContentProtection(root, {
  disableSelection = true,
  disableCopy = true,
  disableCut = true,
  disableContextMenu = true,
  blockShortcuts = true,
} = {}) {
  const teardownInput = lockdownInputSurface(root, {
    select_attempt: disableSelection,
    copy_attempt: disableCopy,
    cut_attempt: disableCut,
    context_menu_attempt: disableContextMenu,
    // Same tie-breaking rule exam.js uses: dragging content out isn't its
    // own toggle, it rides on whichever of selection/copy is enabled.
    drag_attempt: disableSelection || disableCopy,
  });
  const teardownShortcuts = blockShortcuts ? blockKeyboardShortcuts() : () => {};
  return () => {
    teardownInput();
    teardownShortcuts();
  };
}

/**
 * Request fullscreen and warn (via callback) if the student exits it.
 * Returns { requestFullscreen, teardown }.
 */
export function initFullscreenGuard(onExit) {
  const handler = () => {
    if (!document.fullscreenElement) {
      onExit();
    }
  };
  document.addEventListener("fullscreenchange", handler);

  const requestFullscreen = () => document.documentElement.requestFullscreen?.().catch(() => {
    // Fullscreen can be denied (no user gesture, unsupported browser, etc.)
    // — fail silently, the exam still functions without it.
  });

  return {
    requestFullscreen,
    teardown: () => document.removeEventListener("fullscreenchange", handler),
  };
}

/**
 * Best-effort DevTools heuristic: polls the gap between outer and inner
 * window dimensions. A large, sustained gap suggests a docked DevTools
 * panel. This is NOT reliable on its own (see honesty note above) and is
 * only ever used as a soft deterrent + warning, never as the sole basis
 * for a security decision beyond ending the student's own exam attempt.
 *
 * @param {() => void} onWarn - called on each new detection (show a warning)
 * @param {() => void} onTerminate - called once the warning threshold is exceeded
 */
export function startDevToolsHeuristic(onWarn, onTerminate) {
  let warnCount = 0;
  let wasOpen = false;

  const check = () => {
    const widthGap = window.outerWidth - window.innerWidth;
    const heightGap = window.outerHeight - window.innerHeight;
    const isOpen = widthGap > DEVTOOLS_SIZE_THRESHOLD || heightGap > DEVTOOLS_SIZE_THRESHOLD;

    if (isOpen && !wasOpen) {
      warnCount += 1;
      if (warnCount > DEVTOOLS_TERMINATE_AFTER_WARNINGS) {
        onTerminate();
      } else {
        onWarn();
      }
    }
    wasOpen = isOpen;
  };

  const intervalId = setInterval(check, DEVTOOLS_POLL_INTERVAL_MS);
  return () => clearInterval(intervalId);
}

/**
 * Administrator-configurable exam-integrity policy. Edit these values to
 * change behavior — there is no admin UI in this static app, so this object
 * IS the configuration surface.
 *   thresholdAction:
 *     "continue"    — do nothing extra once maxViolations is reached
 *     "warn"        — show a stronger, non-dismissible-feeling final warning
 *     "auto_submit" — automatically submit the exam
 */
export const EXAM_INTEGRITY_CONFIG = {
  maxViolations: 3,
  maxPauseMs: 2000, // longest the timer may be paused while the tab is hidden
  thresholdAction: "warn",
};

/**
 * Tracks tab/window visibility changes as bounded "violations" rather than
 * hiding or blurring content indefinitely:
 *   - going hidden increments a counter and timestamps it
 *   - the timer may be paused for at most `maxPauseMs`, then resumes ticking
 *     even if the student is still away (so the clock can't be cheated by
 *     leaving the tab backgrounded)
 *   - nothing is rendered/blurred while hidden — there is nothing to show
 *   - returning to the tab immediately restores the exam as-is and reports
 *     the violation so the caller can show a small warning dialog
 *   - once `maxViolations` is reached, `onThresholdReached` fires once so
 *     the caller can apply `thresholdAction`
 *
 * @param {{
 *   maxViolations?: number,
 *   maxPauseMs?: number,
 *   onHidden?: (info:{count:number, timestamp:number}) => void,
 *   onResumeAfterPauseCap?: () => void,
 *   onRestored?: (info:{count:number, maxViolations:number}) => void,
 *   onThresholdReached?: (count:number) => void,
 * }} options
 */
export function initVisibilityGuard({
  maxViolations = EXAM_INTEGRITY_CONFIG.maxViolations,
  maxPauseMs = EXAM_INTEGRITY_CONFIG.maxPauseMs,
  onHidden,
  onResumeAfterPauseCap,
  onRestored,
  onThresholdReached,
} = {}) {
  let violationCount = 0;
  let capTimeoutId = null;
  let thresholdFired = false;

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      violationCount += 1;
      const timestamp = Date.now();
      onHidden?.({ count: violationCount, timestamp });

      // Cap any timer pause at maxPauseMs — if the student is still away
      // once the cap elapses, resume the countdown regardless.
      capTimeoutId = setTimeout(() => {
        capTimeoutId = null;
        onResumeAfterPauseCap?.();
      }, maxPauseMs);
    } else {
      if (capTimeoutId) {
        clearTimeout(capTimeoutId);
        capTimeoutId = null;
      }
      onRestored?.({ count: violationCount, maxViolations });

      if (violationCount >= maxViolations && !thresholdFired) {
        thresholdFired = true;
        onThresholdReached?.(violationCount);
      }
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (capTimeoutId) clearTimeout(capTimeoutId);
  };
}
