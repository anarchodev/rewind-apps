// __auth__ — the OIDC identity provider (auth-domain-plan.md §4.7).
//
// A normal tenant (no `platform.*`), reached at `auth.{system_suffix}`.
// It runs the dogfooded `oidc.provider()` library for the OIDC routes
// and a magic-link login for the authentication step ("magic-link
// stays the authN primitive, OIDC wraps it" — §4.1). On successful
// login it binds the platform's per-request sid to a user at
// `_oidc/session/{sid}` — exactly the seam oidc.js._authorize reads.
//
// §0: every URL is derived from request.host — no compiled-in domain.
//
// oidc/email are first-party @rewind packages (declared in manifest.json).
import oidc from "@rewind/oidc";
import email from "@rewind/email";

const MAGIC_TTL_MS = 15 * 60 * 1000; // 15 min, single-use
const MAGIC_PREFIX = "_oidc/magic/";
const MAGIC_COOLDOWN_MS = 60 * 1000; // min gap between sends to one address
const COOLDOWN_PREFIX = "_oidc/magic_cooldown/";
const SESSION_PREFIX = "_oidc/session/"; // must match oidc cfg.session_path

function iss() {
  return "https://" + request.host;
}

function rand() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64url.encode(b);
}

// return_to must be an absolute URL on THIS issuer, or on a registered
// OIDC client's origin (open-redirect defense — the login is otherwise
// a redirector an attacker could aim anywhere). Every browser-bound
// exit from the IdP answers to the same client-registry allowlist that
// RP-initiated logout's post_logout_redirect_uri does; that is what
// lets a static page POST this login form directly (the one-submission
// entry) and have the verify 302 land on the RP, where PKCE completes
// on the now-live IdP session. The try/catch matters: with no client
// registry configured the check rejects instead of throwing, so the
// config-less GET /login keeps rendering.
function safeReturnTo(rt) {
  const base = iss() + "/";
  if (typeof rt === "string" && (rt === iss() || rt.indexOf(base) === 0)) {
    return rt;
  }
  if (typeof rt === "string") {
    try {
      if (oidc.provider("default").isRegisteredClientOrigin(rt)) return rt;
    } catch (_) {
      // missing/broken client registry → reject like any unknown origin
    }
  }
  return iss() + "/"; // fall back to the issuer root
}

// HTML-attribute escaping for values interpolated into value="…".
function escAttr(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// `hint` is the OIDC login_hint: prefill-only data, never authority.
// The magic-link verify binds the address the POST /login mint
// confirmed, not the hint, and the form never auto-submits — so an
// attacker-crafted GET /login?login_hint=… link can prefill a value
// but can never fire an email on its own.
function loginForm(return_to, msg, hint) {
  response.status = 200;
  response.headers = { "content-type": "text/html; charset=utf-8" };
  const rt = escAttr(return_to || "");
  const h = hint ? escAttr(String(hint).slice(0, 320)) : "";
  return "<!doctype html><meta charset=utf-8><title>Sign in</title>" +
    "<h1>Sign in</h1>" +
    (msg ? "<p>" + msg + "</p>" : "") +
    '<form method=post action="/login">' +
    '<input type=hidden name=return_to value="' + rt + '">' +
    '<input name=email type=email placeholder="you@example.com" required' +
    (h ? ' value="' + h + '"' : "") + ">" +
    "<button>Email me a sign-in link</button></form>";
}

// The page a successful email send returns — and, byte-identical, the
// page a cooldown-suppressed repeat returns, so a caller cannot tell
// the two apart. escAttr covers text content too (& < > escaped).
function checkEmailPage(addr) {
  response.status = 200;
  response.headers = { "content-type": "text/html; charset=utf-8" };
  return "<!doctype html><meta charset=utf-8><title>Check your email</title>" +
    "<p>Check your email — a sign-in link is on its way to " +
    escAttr(addr) + ".</p>";
}

// POST /login {email, return_to} → mint a single-use magic token,
// email it (or, with no Resend key configured, return it in the JSON
// so a dev/test relying party can follow it — same dev seam admin's
// signup uses).
function startLogin() {
  const f = new URLSearchParams(request.text || "");
  // NB: name this `addr`, NOT `email` — a local `email` would shadow the
  // global `email` API object, turning `email.send(...)` below into
  // `String.prototype.send` (undefined) → "TypeError: not a function".
  const addr = (f.get("email") || "").trim().toLowerCase();
  const return_to = safeReturnTo(f.get("return_to"));
  if (!addr || addr.indexOf("@") < 1) {
    // Re-render with the typed address as the hint so it can be corrected.
    return loginForm(return_to, "Enter a valid email.", addr);
  }

  const resendKey = kv.get("resend_key");
  const cdKey = COOLDOWN_PREFIX + crypto.sha256(addr);
  // Per-address send cooldown, on the email path only. POST /login is
  // public and unauthenticated, so without a floor between sends it is
  // an inbox-bombing primitive. Inside the window we return the
  // identical "Check your email" page without minting or sending — the
  // earlier link still works, and the identical response leaks nothing
  // (no address enumeration, no amplification). The dev seam (no Resend
  // key) is exempt: it sends no email, so there is nothing to bomb —
  // and test/smoke logins re-login the same address within seconds.
  if (resendKey) {
    const last = Number(kv.get(cdKey));
    if (last && Date.now() - last < MAGIC_COOLDOWN_MS) {
      return checkEmailPage(addr);
    }
  }

  const opaque = rand();
  // sha256-at-rest: a leaked kv can't replay live magic tokens.
  kv.set(MAGIC_PREFIX + crypto.sha256(opaque), JSON.stringify({
    email: addr,
    return_to,
    exp: Date.now() + MAGIC_TTL_MS,
  }));
  const link = iss() + "/login/verify?mt=" + opaque;

  if (resendKey) {
    email.send({
      apiKey: resendKey,
      from: kv.get("platform_email_from") || "login@" + request.host,
      to: addr,
      subject: "Your sign-in link",
      text: "Sign in: " + link + "\n\nThis link expires in 15 minutes.",
    });
    kv.set(cdKey, String(Date.now()));
    return checkEmailPage(addr);
  }
  // No email configured (dev/test): hand the link back directly.
  response.status = 200;
  response.headers = { "content-type": "application/json" };
  return JSON.stringify({ ok: true, magic_link: link });
}

// GET /login/verify?mt=… → consume the token (single-use), bind the
// per-request sid to the user, bounce back to the original authorize
// URL where oidc.js now finds the session and issues the code.
function verifyLogin() {
  const q = new URLSearchParams(request.query || "");
  const mt = q.get("mt");
  if (!mt) {
    response.status = 400;
    return "missing token";
  }
  const key = MAGIC_PREFIX + crypto.sha256(mt);
  const raw = kv.get(key);
  kv.delete(key); // single-use: consume before any check
  if (raw == null) {
    response.status = 400;
    return "invalid or used sign-in link";
  }
  const m = JSON.parse(raw);
  if (Date.now() > m.exp) {
    response.status = 400;
    return "sign-in link expired";
  }

  const sid = request.session && request.session.id;
  if (!sid) {
    response.status = 400;
    return "no session context";
  }
  // Bind sid → user. `sub` is the stable subject identifier; the
  // email is fine for v1 (one IdP, opaque to RPs via id_token.sub).
  kv.set(SESSION_PREFIX + sid, JSON.stringify({
    sub: m.email,
    auth_time: Math.floor(Date.now() / 1000),
  }));

  response.status = 302;
  response.headers = { location: safeReturnTo(m.return_to) };
  return null;
}

export default function () {
  const path = (request.path || "").split("?")[0];
  const m = request.method;

  if (m === "GET" && path === "/login") {
    const q = new URLSearchParams(request.query || "");
    return loginForm(q.get("return_to"), null, q.get("login_hint"));
  }
  if (m === "POST" && path === "/login") return startLogin();
  if (m === "GET" && path === "/login/verify") return verifyLogin();

  // Everything else (/.well-known/*, /authorize, /token) → the
  // dogfooded provider library.
  return oidc.provider("default").handle();
}
