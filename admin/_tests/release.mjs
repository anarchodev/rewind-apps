// publishRelease — locks the CRITICAL dep_id coercion regression.
//
// The live release path once base-10-coerced a hex dep_id (JSON.parse → f64):
// sha256-derived dep_ids exceed 2^53, so a coerced id released the WRONG (rounded)
// manifest, and a–f ids were rejected outright. The fix rejects a JSON *number*
// and requires a hex *string*, echoed byte-for-byte into platform.releases.publish.
// This suite pins that: a number 400s, and a hex id (with a–f, and a full 16-digit
// id above 2^53) round-trips unchanged.
//
// publishRelease is reached through the real router + the real `_middlewares` OIDC
// guard, so the scenario seeds the RP config (config-mirrored from
// admin/_config/oidc/rp/default.json on deploy) and an unexpired `_rp/sess/{sid}`.
// `admin: true` unlocks platform.* (releases.publish is admin-gated).
import { scenario, expect } from "rewind:test";

const RP_CONFIG = {
  issuer: "https://auth.rewindjs.com",
  client_id: "admin-dashboard",
  redirect_uri: "https://app.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000; // 2100-01-01 in ms — well past the scenario clock

const sess = (sub, is_root) => JSON.stringify({ sub, is_root, exp: FAR });

// An operator session: is_root bypasses the tenant-ownership gate, so the run
// exercises the dep_id logic itself rather than authz.
const op = scenario({
  admin: true,
  now: "2026-07-01T00:00:00Z",
  kv: {
    "_config/oidc/rp/default": RP_CONFIG,
    "_rp/sess/op": sess("ops@rewindjs.com", true),
  },
});

function release(s, id, body, sid) {
  return s.inbound({
    method: "POST",
    path: "/v1/instances/" + id + "/release",
    body,
    session: sid ? { id: sid } : undefined,
  });
}

const published = (n) => n.effects.some((e) => e.kind === "platform" && e.op === "releases.publish");

// ── CRITICAL: a JSON-number dep_id is REJECTED, never coerced ──
// 0x12345678 as a bare number — the old path base-10-coerced this and released a
// rounded manifest. It must 400 and publish nothing.
const num = release(op, "acme", { dep_id: 305419896 }, "op");
expect(num.status).toBe(400);
expect(num.body.error).toMatch(/hex string/);
expect(published(num)).toBe(false);

// ── CRITICAL: a hex dep_id with a–f digits releases, echoed byte-for-byte ──
const hex = release(op, "acme", { dep_id: "abcdef123456" }, "op");
expect(hex.status).toBe(202);
expect(hex.body).toEqual({ instance_id: "acme", dep_id: "abcdef123456", status: "queued" });
expect(published(hex)).toBe(true);

// ── CRITICAL: a full 16-hex-digit id (> 2^53) survives with no precision loss ──
const big = release(op, "acme", { dep_id: "ffffffffffffffff" }, "op");
expect(big.status).toBe(202);
expect(big.body.dep_id).toBe("ffffffffffffffff");

// ── validation: a non-hex string → 400 ──
const bad = release(op, "acme", { dep_id: "zzz" }, "op");
expect(bad.status).toBe(400);
expect(bad.body.error).toMatch(/hex u64/);
expect(published(bad)).toBe(false);

// ── validation: a missing dep_id → 400 ──
expect(release(op, "acme", {}, "op").status).toBe(400);

// ── validation: an invalid instance_id → 400 ──
expect(release(op, "bad!", { dep_id: "1a2b" }, "op").status).toBe(400);

// ── the middleware gate: no session → 401, the handler never runs ──
const anon = release(op, "acme", { dep_id: "1a2b" });
expect(anon.status).toBe(401);
expect(published(anon)).toBe(false);

// ── authz: a non-operator who doesn't own the tenant → 403, before the thunk ──
const stranger = scenario({
  admin: true,
  now: "2026-07-01T00:00:00Z",
  kv: {
    "_config/oidc/rp/default": RP_CONFIG,
    "_rp/sess/jess": sess("jess@example.com", false),
  },
});
const denied = release(stranger, "acme", { dep_id: "1a2b" }, "jess");
expect(denied.status).toBe(403);
expect(published(denied)).toBe(false);
