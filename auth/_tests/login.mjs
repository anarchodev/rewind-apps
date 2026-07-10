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
