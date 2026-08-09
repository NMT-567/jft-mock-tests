/**
 * sw-assets.js
 * A narrow-scope Service Worker with exactly one job: cache external
 * media assets (Cloudflare R2 images/audio) so repeated attempts at the
 * same mock test don't re-download the same file from R2 every time.
 *
 * This deliberately does NOT touch:
 *   - any request to *.supabase.co (auth, RLS-gated data, get_exam_content,
 *     submit-attempt, admin-revoke-session — all of it)
 *   - any non-GET request (POST/PUT/DELETE — submissions, publishing, etc.)
 *   - this site's own HTML/JS/CSS
 * The fetch handler below simply returns (does nothing) for anything
 * that isn't a GET request to an allowlisted asset host — that's what
 * makes this a no-op for everything else, not a blanket cache.
 *
 * Registered from js/utils.js (the one file already imported by every
 * page, student and admin alike) — see that file for the registration
 * call. Because this script lives at the site root, its default scope
 * covers the entire site (including /admin/) without any extra config.
 */

// Bump this when the caching LOGIC changes (not when an asset changes —
// asset updates are handled by URL, see ASSET ELIGIBILITY below). Old
// versions are cleaned up automatically in the activate handler.
const CACHE_NAME = "nmt-r2-assets-v1";
const CACHE_NAME_PREFIX = "nmt-r2-assets-";

// Extend this array if assets ever move to a custom R2 domain instead of
// the default *.r2.dev subdomain — no other code needs to change.
const ALLOWED_ASSET_HOSTS_SUFFIXES = [".r2.dev"];

const IS_DEV = self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1";
function devLog(...args) {
  if (IS_DEV) console.log("[R2 Cache]", ...args);
}

/**
 * ASSET ELIGIBILITY
 * A hostname allowlist decides whether to intercept a request at all;
 * the extension check only EXCLUDES things clearly not media (a .json
 * or .html file sitting on the same asset host) rather than requiring
 * an exact extension match — an unrecognized or missing extension
 * still passes through. The actual store-time decision (see
 * handleAssetRequest below) additionally checks the real Content-Type
 * header before ever writing to the cache, so nothing gets cached
 * unless the server itself says it's really image/audio.
 *
 * Cache invalidation: this project's R2 filenames are timestamp-prefixed
 * (e.g. "1785512427081-name.webp"), so a NEW upload naturally gets a
 * NEW URL rather than overwriting an old one — updating the imageUrl/
 * audioUrl field in the test JSON (via re-publishing) is what actually
 * invalidates a cached asset, since the old URL's cache entry is simply
 * never requested again. This assumes future uploads keep following
 * that same unique-filename convention, which this codebase can't
 * verify on its own since R2 uploading isn't part of this app's code —
 * if a URL is ever REUSED for different content, that specific asset's
 * cached copy would need a manual cache-version bump (increment
 * CACHE_NAME above) to clear it.
 */
function isCacheableAssetUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false; // never intercept data:/blob: URIs — they aren't network requests anyway

  const hostAllowed = ALLOWED_ASSET_HOSTS_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  if (!hostAllowed) return false;

  // Extension is only used here to EXCLUDE things that are definitely
  // not media (a .json/.html/.js file on the same asset host, say) —
  // no extension, or an unrecognized one, still passes through to the
  // network-fetch stage, where the real Content-Type header makes the
  // final, authoritative call (see cacheAssetResponse below).
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  const definitelyNotMedia = ["json", "html", "htm", "js", "css", "txt", "xml", "pdf"];
  if (ext && definitelyNotMedia.includes(ext)) return false;

  return true;
}

function isMediaContentType(contentType) {
  if (!contentType) return false;
  return contentType.startsWith("image/") || contentType.startsWith("audio/");
}

// Request de-duplication: if several components request the same URL at
// nearly the same time (e.g. a passage image + a thumbnail elsewhere),
// only one network fetch actually happens — the rest await the same
// in-flight promise. Cleared once that fetch settles either way.
const inflightFetches = new Map();

async function handleAssetRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    devLog("HIT", request.url);
    return cached;
  }

  if (inflightFetches.has(request.url)) {
    devLog("DEDUPED (awaiting in-flight fetch)", request.url);
    return inflightFetches.get(request.url);
  }

  devLog("MISS", request.url);
  const fetchPromise = (async () => {
    try {
      const response = await fetch(request);
      // Never cache failed/error responses (404/403/500/etc.) — only a
      // real, successful, actually-media response gets stored.
      if (response.ok && isMediaContentType(response.headers.get("Content-Type"))) {
        cache.put(request, response.clone());
        devLog("STORED", request.url);
      }
      return response;
    } catch (err) {
      devLog("NETWORK ERROR", request.url, err);
      throw err;
    } finally {
      inflightFetches.delete(request.url);
    }
  })();

  inflightFetches.set(request.url, fetchPromise);
  return fetchPromise;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_NAME_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Anything that isn't a GET to an allowlisted asset host is left
  // completely alone — no respondWith() call at all, which means the
  // browser handles it exactly as if this Service Worker didn't exist.
  // This is what keeps Supabase calls, submissions, and this site's own
  // HTML/JS/CSS entirely untouched.
  if (request.method !== "GET") return;
  if (!isCacheableAssetUrl(request.url)) return;
  event.respondWith(handleAssetRequest(request));
});
