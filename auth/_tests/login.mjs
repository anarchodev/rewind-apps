// __auth__ magic-link login — the authN security properties: input validation,
// the Resend-key dev seam, single-use token consumption, expiry, and the
// open-redirect defense (safeReturnTo) on both the mint and the 302.
//
// The OIDC routes (/authorize, /token, /.well-known) go through the opaque
// oidc.provider() library and aren't exercised here — this is the magic-link
// primitive the provider wraps. Tokens are hashed at rest (`_oidc/magic/
// {sha256(opaque)}`), so the test computes the key with the same `crypto.sha256`
// the handler uses.
import { scenario, expect } from "rewind:test";

const HOST = "auth.rewindjs.com";
const ISS = "https://" + HOST;
const FAR = 4102444800000; // 2100 in ms — unexpired against the scenario clock
const MK = (mt) => "_oidc/magic/" + crypto.sha256(mt); // hashed-at-rest key
const record = (email, return_to, exp) => JSON.stringify({ email, return_to, exp });

const s = (kv) => scenario({ now: "2026-07-01T00:00:00Z", seed: 1, kv: kv || {} });
const wroteMagic = (n) => n.effects.some((e) => e.kind === "write" && String(e.key).indexOf("_oidc/magic/") === 0);

// ── loginForm (GET /login) — login_hint prefill ───────────────────────────
// The hint is prefill-only: it renders as the input's value and nothing else
// (no mint, no email — those need the POST).
const getLogin = (scn, query) => scn.inbound({ method: "GET", path: "/login" + (query || ""), host: HOST });

// login_hint prefills the email input
const hinted = getLogin(s(), "?login_hint=" + encodeURIComponent("jess@example.com"));
expect(hinted.status).toBe(200);
expect(hinted.body).toContain('value="jess@example.com"');

// a hostile hint is attribute-escaped — it cannot break out into markup
const xss = getLogin(s(), "?login_hint=" + encodeURIComponent('"><script>alert(1)</script>'));
expect(xss.status).toBe(200);
expect(xss.body).not.toContain("<script>alert");

// no hint → the form still renders, with no stray "undefined"
const plain = getLogin(s());
expect(plain.status).toBe(200);
expect(plain.body).toMatch(/name=email/);
expect(plain.body).not.toContain("undefined");

// ── startLogin (POST /login) ──────────────────────────────────────────────
const postLogin = (scn, form) => scn.inbound({ method: "POST", path: "/login", host: HOST, body: form });

// invalid email → re-render the form, mint nothing
const bad = postLogin(s(), "email=notanemail&return_to=" + encodeURIComponent(ISS + "/authorize"));
expect(bad.status).toBe(200);
expect(bad.body).toMatch(/Enter a valid email/);
expect(wroteMagic(bad)).toBe(false);

// no Resend key (dev seam) → JSON carrying the link; token stored hashed, email
// lowercased; no email side effect
const dev = postLogin(s(), "email=Jess@Example.com&return_to=" + encodeURIComponent(ISS + "/authorize?x=1"));
expect(dev.status).toBe(200);
const devBody = JSON.parse(dev.body);
expect(devBody.ok).toBe(true);
expect(devBody.magic_link).toContain(ISS + "/login/verify?mt=");
const mt = devBody.magic_link.split("mt=")[1];
expect(dev).toHaveWritten(MK(mt), { email: "jess@example.com", return_to: ISS + "/authorize?x=1" });
expect(dev.effects.some((e) => e.kind === "write" && String(e.key).indexOf("_send/owed/") === 0)).toBe(false);

// with a Resend key → sends the email + HTML confirmation, never leaks the link
const prod = postLogin(
  s({ resend_key: "re_test", platform_email_from: "login@rewindjs.com" }),
  "email=jess@example.com&return_to=" + encodeURIComponent(ISS + "/"),
);
expect(prod.status).toBe(200);
expect(prod.body).toMatch(/Check your email/);
expect(prod.body).not.toMatch(/login\/verify/);
expect(prod).toHaveSent("email", { to: ["jess@example.com"] });

// open-redirect: an off-issuer return_to is NOT stored — it falls back to root
const evil = postLogin(s(), "email=jess@example.com&return_to=" + encodeURIComponent("https://evil.example.com/steal"));
const evilMt = JSON.parse(evil.body).magic_link.split("mt=")[1];
expect(evil).toHaveWritten(MK(evilMt), { return_to: ISS + "/" });

// ── one-submission entry: cross-origin return_to via the client registry ──
// The static marketing page POSTs /login directly with a dashboard
// return_to. safeReturnTo accepts a cross-origin return_to iff its origin
// is a registered OIDC client's — the same allowlist RP-initiated logout
// uses for post_logout_redirect_uri.
const CFG = {
  "_oidc/config/default": JSON.stringify({
    clients: [{ client_id: "admin-dashboard", redirect_uris: ["https://app.${ISSUER_PARENT}/_rp/callback"] }],
    login_path: "/login",
  }),
};
const APP_RT = "https://app.rewindjs.com/_rp/login"; // registered origin, RP-chosen path

// registered client origin → stored verbatim in the magic record
const xo = postLogin(s(CFG), "email=jess@example.com&return_to=" + encodeURIComponent(APP_RT));
const xoMt = JSON.parse(xo.body).magic_link.split("mt=")[1];
expect(xo).toHaveWritten(MK(xoMt), { return_to: APP_RT });

// same return_to with NO client registry configured → the provider throws,
// safeReturnTo catches and rejects: issuer root
const noreg = postLogin(s(), "email=jess@example.com&return_to=" + encodeURIComponent(APP_RT));
const noregMt = JSON.parse(noreg.body).magic_link.split("mt=")[1];
expect(noreg).toHaveWritten(MK(noregMt), { return_to: ISS + "/" });

// registry present but an unregistered origin → still the issuer root
const unreg = postLogin(s(CFG), "email=jess@example.com&return_to=" + encodeURIComponent("https://evil.example.com/steal"));
const unregMt = JSON.parse(unreg.body).magic_link.split("mt=")[1];
expect(unreg).toHaveWritten(MK(unregMt), { return_to: ISS + "/" });

// ── per-address send cooldown (email path only) ───────────────────────────
const NOW = Date.parse("2026-07-01T00:00:00Z"); // the scenario clock
const CD = (a) => "_oidc/magic_cooldown/" + crypto.sha256(a);
const wroteCooldown = (n) => n.effects.some((e) => e.kind === "write" && String(e.key).indexOf("_oidc/magic_cooldown/") === 0);

// a send 10s ago → the identical "Check your email" page, but nothing is
// minted and nothing is sent (the earlier link still works; the identical
// response means no enumeration and no bombing amplification)
const cooled = postLogin(
  s({ resend_key: "re_test", [CD("jess@example.com")]: String(NOW - 10 * 1000) }),
  "email=jess@example.com&return_to=" + encodeURIComponent(ISS + "/"),
);
expect(cooled.status).toBe(200);
expect(cooled.body).toMatch(/Check your email/);
expect(wroteMagic(cooled)).toBe(false);
expect(cooled.effects.some((e) => e.kind === "write" && String(e.key).indexOf("_send/owed/") === 0)).toBe(false);

// a send 120s ago → outside the window: the email goes out and the
// cooldown timestamp is refreshed
const warmed = postLogin(
  s({ resend_key: "re_test", [CD("jess@example.com")]: String(NOW - 120 * 1000) }),
  "email=jess@example.com&return_to=" + encodeURIComponent(ISS + "/"),
);
expect(warmed).toHaveSent("email", { to: ["jess@example.com"] });
expect(wroteMagic(warmed)).toBe(true);
expect(wroteCooldown(warmed)).toBe(true);

// dev seam unaffected: with no Resend key the cooldown never applies
// (there is no email to bomb) — the magic_link JSON still comes back
const devCooled = postLogin(
  s({ [CD("jess@example.com")]: String(NOW - 10 * 1000) }),
  "email=jess@example.com&return_to=" + encodeURIComponent(ISS + "/"),
);
expect(JSON.parse(devCooled.body).magic_link).toContain(ISS + "/login/verify?mt=");

// ── verifyLogin (GET /login/verify) ───────────────────────────────────────
const verify = (scn, mt, sid) => scn.inbound({
  method: "GET",
  path: "/login/verify" + (mt != null ? "?mt=" + mt : ""),
  host: HOST,
  session: sid ? { id: sid } : undefined,
});

// no token → 400
expect(verify(s(), null, "sid1").status).toBe(400);

// unknown/already-used token → 400
expect(verify(s(), "ghost", "sid1").body).toMatch(/invalid or used/);

// happy path: valid token + session → binds sid, 302 to the safe return_to,
// and the token is consumed (single-use)
const good = verify(s({ [MK("tok-good")]: record("jess@example.com", ISS + "/authorize?x=1", FAR) }), "tok-good", "sid1");
expect(good.status).toBe(302);
expect(good.response.headers.location).toBe(ISS + "/authorize?x=1");
expect(good).toHaveWritten("_oidc/session/sid1", { sub: "jess@example.com" });
expect(good.kv(MK("tok-good"))).toBe(null);

// expired token → 400, still consumed (deleted before the expiry check)
const stale = verify(s({ [MK("tok-old")]: record("jess@example.com", ISS + "/", 1) }), "tok-old", "sid1");
expect(stale.status).toBe(400);
expect(stale.body).toMatch(/expired/);
expect(stale.kv(MK("tok-old"))).toBe(null);

// valid token but no session context → 400
expect(verify(s({ [MK("tok-ns")]: record("jess@example.com", ISS + "/", FAR) }), "tok-ns").status).toBe(400);

// open-redirect: a tampered stored return_to is sanitized on the 302
const red = verify(s({ [MK("tok-evil")]: record("jess@example.com", "https://evil.example.com/x", FAR) }), "tok-evil", "sid1");
expect(red.status).toBe(302);
expect(red.response.headers.location).toBe(ISS + "/");

// ── the issuer root is a landing, never a bare 404 ────────────────────────
// safeReturnTo's fallback 302s to "/", and stray visitors type it. A dotted
// host bounces one DNS label up (the marketing site on the platform
// deployment); a bare hostname renders a minimal sign-in link instead of
// redirecting to itself.
const root = s().inbound({ method: "GET", path: "/", host: HOST });
expect(root.status).toBe(302);
expect(root.response.headers.location).toBe("https://rewindjs.com/");
const bare = s().inbound({ method: "GET", path: "/", host: "localhost" });
expect(bare.status).toBe(200);
expect(bare.body).toMatch(/href="\/login"/);

// ── a rejected off-registry return_to is observable, origin only ──────────
// The rejection must be visible in tape/logs (a silent fallback once hid a
// stale-package deployment bug), but never echo the full attacker-supplied
// URL — the warn carries the origin alone.
const rej = postLogin(s(CFG), "email=jess@example.com&return_to=" + encodeURIComponent("https://evil.example.com/steal"));
const rejWarns = rej.effects.filter((e) => e.kind === "log" && e.level === "warn").map((e) => e.message);
expect(rejWarns.some((m) => m.indexOf("safeReturnTo") >= 0 && m.indexOf("https://evil.example.com") >= 0)).toBe(true);
expect(rejWarns.some((m) => m.indexOf("/steal") >= 0)).toBe(false);
