// registry auth gate. The registry is a pure OIDC relying party (like admin,
// auth-domain-plan §4.7): authentication lives at the __auth__ IdP; this gate
// just resolves the RP session oidc.rp minted.
//
// Unlike admin, the registry is READ-MOSTLY and public: resolve + discovery
// (GET /v1/packages*, POST /v1/resolve, GET /v1/blobs/*) are open to anyone,
// so this guard is OPPORTUNISTIC — it sets request.auth when a valid session
// is present and otherwise falls through unauthenticated. The one gated
// surface, publish (POST /v1/packages, operator-only in v1), enforces is_root
// itself in the router's routeAuthz. So there is no PRE_AUTH_PATHS list and no
// 401 here; a missing/invalid session simply means request.auth is unset.
//
// `kv` here is this tenant's own home store, so the RP session lookup
// (_rp/sess/{sid}) is naturally correct on every dispatch.
//
// ── operator (genesis-seed / CI) publish path ────────────────────────────
//
// (`oidc` is the first-party @rewind/oidc package, declared in manifest.json.)
// The registry is a NORMAL tenant with no platform.auth.checkRootToken (that
// native is admin-only), and at genesis there is no OIDC IdP to mint a session
// yet — so the genesis seed (rove-side) cannot log in to publish the first
// @rewind packages. Instead it authenticates a Bearer against a hash the
// operator seeds into this tenant's own kv via platform kv-put:
//   _optoken/publish_sha256  = sha256(operator_token)   (raw 64-hex, no JSON)
// A request whose `Authorization: Bearer <t>` satisfies sha256(t) == that hash
// gets is_root. The comparison is self-contained (the token secret never lives
// here, only its hash) and INERT until seeded — with no seed key present, a
// Bearer grants nothing and publish stays OIDC-only. This is also the general
// operator/CI publish path once genesis exists.
import oidc from "@rewind/oidc";

export function before() {
    const auth = oidc.rp("default").guard();
    if (auth) { request.auth = auth; return; } // { sub, is_root }

    const op = operatorAuth();
    if (op) request.auth = op;
    // else fall through unauthenticated → routeAuthz gates the one publish route
}

// Resolve the operator Bearer against the seeded hash. Returns an is_root auth
// object or null. Cheap: only touches kv when a Bearer is actually presented.
function operatorAuth() {
    const token = bearerToken();
    if (!token) return null;
    const seeded = kv.get("_optoken/publish_sha256");
    if (seeded == null) return null;
    if (!constantTimeEqualHex(crypto.sha256(token), String(seeded).trim())) return null;
    return { sub: "operator", is_root: true, operator: true };
}

function bearerToken() {
    const h = request.headers || {};
    const raw = h.authorization || h.Authorization || "";
    const m = /^Bearer[ \t]+(.+)$/.exec(String(raw).trim());
    return m ? m[1].trim() : null;
}

// Length-checked constant-time hex compare — avoids leaking the seeded hash via
// early-exit timing. (Both sides are sha256 hex, so reversing a leaked hash to
// the token is infeasible regardless; this is defense-in-depth.)
function constantTimeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
