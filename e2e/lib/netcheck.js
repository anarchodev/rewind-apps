// Watch a page for same-origin asset-load problems — the class of failure
// behind console errors like `net::ERR_SSL_PROTOCOL_ERROR` (a fresh h2/TLS
// connection to the front coming up broken) and 4xx/5xx on static modules.
//
// Scope to a single host (e.g. the app host) so third-party noise (fonts,
// csp beacons) and expected auth-probe 401/403s don't cause false failures.
// `net::ERR_ABORTED` is ignored — the browser cancels in-flight requests on
// navigation/SPA route changes and that is benign.

const STATIC_RE = /\.(?:js|mjs|css|html|map|wasm)(?:\?|$)/i;
const IGNORED_ERRORS = new Set(["net::ERR_ABORTED"]);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// Attach listeners immediately. Returns { problems() } — a deduped list of
// { kind, url, detail } gathered so far. Watch is passive; call problems()
// after the flow to assert on it.
export function watchAssets(page, host) {
  const seen = new Set();
  const problems = [];
  const add = (kind, url, detail) => {
    const key = `${kind} ${url} ${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ kind, url, detail });
  };

  // Transport-level failures (TLS/connection reset, DNS, etc.) — the primary
  // signal for the SSL-protocol-error case.
  page.on("requestfailed", (req) => {
    if (hostOf(req.url()) !== host) return;
    const err = req.failure()?.errorText || "failed";
    if (IGNORED_ERRORS.has(err)) return;
    add("requestfailed", req.url(), err);
  });

  // A static asset that comes back 4xx/5xx (e.g. a 500 on a page module).
  // Restricted to static extensions so API calls that legitimately 401/403
  // during the auth flow don't trip it.
  page.on("response", (res) => {
    const url = res.url();
    if (hostOf(url) !== host) return;
    if (!STATIC_RE.test(url)) return;
    if (res.status() >= 400) add("bad-status", url, String(res.status()));
  });

  // The browser's own "Failed to load resource: net::ERR_…" console line —
  // belt-and-suspenders alongside requestfailed. Restricted to transport
  // errors (net::ERR_*, the SSL-protocol-error class): HTTP status failures
  // are handled, scoped to static assets, by the `response` listener above —
  // so an expected API 401/403 during the auth probe (e.g. GET /v1/session
  // while unauthenticated) is NOT flagged here.
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text() || "";
    const m = text.match(/net::ERR_[A-Z_]+/);
    if (!m || IGNORED_ERRORS.has(m[0])) return;
    const url = msg.location()?.url || "";
    if (url && hostOf(url) !== host) return;
    add("console", url || "(no url)", text.slice(0, 200));
  });

  return {
    problems: () => problems.slice(),
  };
}
