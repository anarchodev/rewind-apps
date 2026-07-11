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

export function before() {
    const auth = oidc.rp("default").guard();
    if (auth) request.auth = auth; // { sub, is_root }; unauth → leave undefined
    // fall through (undefined return) → continue to handler
}
