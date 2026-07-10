// The operator door sagas — log query + CP control — and the shared onFetchResult
// relay. These are held `after.fetch` chains through the internal
// rewind-logs.internal / rewind-cp.internal doors, so the test drives the full
// saga: the inbound holds and emits the door fetch, then `.fetch().resolve` (or
// `.branch`) delivers the upstream result into the onFetchResult resume. This is
// the fetch-resolve surface that answers "does my change still behave?".
import { scenario, expect } from "rewind:test";

const RP_CONFIG = {
  issuer: "https://auth.rewindjs.com",
  client_id: "admin-dashboard",
  redirect_uri: "https://app.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000;
const sess = (sub, is_root) => JSON.stringify({ sub, is_root, exp: FAR });

const s = scenario({
  admin: true,
  now: "2026-07-01T00:00:00Z",
  kv: {
    "_config/oidc/rp/default": RP_CONFIG,
    "_rp/sess/op": sess("ops@rewindjs.com", true),   // operator
    "_rp/sess/al": sess("alice@x.com", false),       // plain user
  },
});
const call = (method, path, sid, body) =>
  s.inbound({ method, path, host: "app.rewindjs.com", body, session: sid ? { id: sid } : undefined });

// ── log-door saga (GET /v1/logs/{tenant}/{sub}) ───────────────────────────
// authz gate: unauthenticated 401 (middleware), non-operator 403 (handler),
// bad sub-route 404 — none of these hold or emit a fetch.
expect(call("GET", "/v1/logs/acme/list", null).status).toBe(401);
const denied = call("GET", "/v1/logs/acme/list", "al");
expect(denied.status).toBe(403);
expect(denied.disposition).toBe("terminal");
expect(call("GET", "/v1/logs/acme/bogus", "op").status).toBe(404);

// operator query → holds + emits the door fetch verbatim
const q = call("GET", "/v1/logs/acme/list", "op");
expect(q.disposition).toBe("held");
expect(q).toHaveFetched(/rewind-logs\.internal\/v1\/acme\/list/);

// onFetchResult relay — three upstream outcomes from the one held chain:
//  200 → relayed verbatim; a 4xx (e.g. idempotent CP-style) → relayed, NOT
//  flattened; a transport failure with no upstream status → 502.
const [ok200, relay409, fail502] = q.fetch(/rewind-logs/).branch([
  { status: 200, body: '{"rows":[]}' },
  { status: 409, ok: false, body: '{"error":"exists"}' },
  { status: 0, ok: false },
]);
expect(ok200.status).toBe(200);
expect(ok200.body).toBe('{"rows":[]}');
expect(relay409.status).toBe(409);
expect(relay409.body).toBe('{"error":"exists"}');
expect(fail502.status).toBe(502);
expect(JSON.parse(fail502.body).error).toMatch(/door fetch failed/);

// ── CP control saga (POST /v1/cp/{op}) ────────────────────────────────────
// non-operator → 403, no fetch
const cpDenied = call("POST", "/v1/cp/move", "al", { live: true });
expect(cpDenied.status).toBe(403);
expect(cpDenied.disposition).toBe("terminal");

// operator move with live:true → holds + routes to the move-live control op
const mv = call("POST", "/v1/cp/move", "op", { live: true });
expect(mv.disposition).toBe("held");
expect(mv).toHaveFetched(/rewind-cp\.internal\/_control\/move-live/);
// a plain move (no live flag) → the non-live control op
const mvPlain = call("POST", "/v1/cp/move", "op", {});
expect(mvPlain).toHaveFetched(/rewind-cp\.internal\/_control\/move(?!-live)/);
// the upstream result relays through the same onFetchResult
const cpDone = mv.fetch(/rewind-cp/).resolve({ status: 200, body: '{"ok":true}' });
expect(cpDone.status).toBe(200);
expect(cpDone.body).toBe('{"ok":true}');
