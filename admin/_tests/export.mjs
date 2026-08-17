// Instance data export through the dashboard (rove#340): the admin runs a
// customer's export FOR them — `@rewind/export.forScope(platform.scope(t))`
// writes the same `_export/{id}` marker + `_sched/` wake rows a self-start
// writes, into the TARGET's isolated store; the engine's target-envelope
// sched arm makes the job start immediately in production. Covers the route
// authz matrix, the one-running-at-a-time 409, the start's cross-tenant
// rows, list/poll metadata shapes, and the presigned links (scoped
// exportUrl, TTL-bounded).
import { scenario, expect } from "rewind:test";

const RP_CONFIG = {
  issuer: "https://auth.rewindjs.com",
  client_id: "admin-dashboard",
  redirect_uri: "https://app.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000;
const uh = (email) => crypto.sha256(email.trim().toLowerCase());
const j = JSON.stringify;

const alice = "alice@x.com", bob = "bob@x.com", carol = "carol@x.com";
const A = uh(alice), B = uh(bob);
const TEAM = "team1";
const sess = (sub, is_root) => j({ sub, is_root, exp: FAR });
const H1 = "a".repeat(64), H2 = "b".repeat(64), H3 = "c".repeat(64);

const DONE = j({
  format: 2, state: "done", cursor: "",
  parts: [{ hash: H1, bytes: 100, entries: 7 },
          { hash: H2, bytes: 60, entries: 2, kind: "bundle" }],
  bundle_requested: true, bundle: { manifest_hash: H2, dep_id: "00000000deadbeef" },
  bytes: 160, entries: 9, started_at: 1, finished_at: 2,
});
const RUNNING = j({
  format: 2, state: "running", cursor: "k/5", parts: [{ hash: H3, bytes: 40, entries: 3 }],
  bundle_requested: true, bytes: 40, entries: 3, started_at: 3,
});

// app1 is team-owned (alice owner, bob member); carol is a stranger.
const mk = (instKv) => scenario({
  admin: true,
  now: "2026-08-16T00:00:00Z",
  seed: 11,
  kv: {
    "_config/oidc/rp/default": RP_CONFIG,
    "_rp/sess/al": sess(alice, false),
    "_rp/sess/bo": sess(bob, false),
    "_rp/sess/ca": sess(carol, false),
    ["account/" + TEAM + "/members/" + A]: "owner",
    ["account/" + TEAM + "/members/" + B]: "member",
    ["user/" + A + "/accounts/" + TEAM]: "owner",
    ["user/" + B + "/accounts/" + TEAM]: "member",
    ["account/" + TEAM + "/instances/app1"]: "",
    "instance/app1/owner": TEAM,
  },
  instances: { app1: { kv: instKv || {} } },
});
const call = (s, method, path, sid) =>
  s.inbound({ method, path, host: "app.rewindjs.com",
              session: sid ? { id: sid } : undefined });

// ── Authz: reach over a tenant's export is reach over the tenant ──────────
const s0 = mk();
expect(call(s0, "POST", "/v1/instances/app1/export", null).status).toBe(401);
expect(call(s0, "POST", "/v1/instances/app1/export", "ca").status).toBe(403);
expect(call(s0, "GET", "/v1/instances/app1/export", "ca").status).toBe(403);

// ── Start: a MEMBER may export; the marker + wake rows land in app1 ───────
const started = call(mk(), "POST", "/v1/instances/app1/export", "bo");
expect(started.status).toBe(202);
const eid = started.body.id;
expect(typeof eid).toBe("string");
const m = started.instanceKv("app1", "_export/" + eid);
expect(m.state).toBe("running");
expect(m.format).toBe(2);
expect(m.bundle_requested).toBe(true);
// The wake rows are the schedule contract's, written through the SCOPED
// store: a `_sched/by_id/{sha256b64url(key)}` record aimed at the baked
// job, plus its `_sched/by_time/` index twin. Found via the effect log —
// the sid derivation is the package's own (crypto.sha256b64url is not a
// test-context global).
const schedWrites = started.effects.filter((e) =>
  typeof e.key === "string" && e.key.indexOf("_sched/by_id/") === 0 &&
  typeof e.value === "string" && e.value.indexOf("\"target\"") !== -1);
expect(schedWrites.length >= 1).toBe(true); // the re-arm read shows up too
const byId = JSON.parse(schedWrites[schedWrites.length - 1].value);
expect(byId.target).toBe("__system/export_run");
expect(byId.key).toBe("_export/" + eid);
expect(started.effects.some((e) =>
  typeof e.key === "string" && e.key.indexOf("_sched/by_time/") === 0)).toBe(true);

// ── One running export per tenant ──────────────────────────────────────────
const busy = call(mk({ ["_export/e-run"]: RUNNING }), "POST",
                  "/v1/instances/app1/export", "al");
expect(busy.status).toBe(409);
// A finished one does not block a fresh start.
expect(call(mk({ ["_export/e-done"]: DONE }), "POST",
            "/v1/instances/app1/export", "al").status).toBe(202);

// ── List: metadata only, newest first ──────────────────────────────────────
const listed = call(mk({ ["_export/e-done"]: DONE, ["_export/e-run"]: RUNNING }),
                    "GET", "/v1/instances/app1/export", "bo");
expect(listed.status).toBe(200);
expect(listed.body.exports.length).toBe(2);
expect(listed.body.exports[0].id).toBe("e-run");   // started_at 3 > 1
expect(listed.body.exports[0].state).toBe("running");
expect(listed.body.exports[1].parts).toBe(2);      // count, never hashes
expect(j(listed.body).indexOf(H1)).toBe(-1);

// ── Poll one export ─────────────────────────────────────────────────────────
const one = call(mk({ ["_export/e-done"]: DONE }),
                 "GET", "/v1/instances/app1/export/e-done", "bo");
expect(one.status).toBe(200);
expect(one.body.state).toBe("done");
expect(one.body.entries).toBe(9);
expect(one.body.bundle.dep_id).toBe("00000000deadbeef");
expect(call(mk(), "GET", "/v1/instances/app1/export/nope", "bo").status).toBe(404);

// ── Links: presigned per part against the TARGET's exports pool ────────────
const links = call(mk({ ["_export/e-done"]: DONE }),
                   "GET", "/v1/instances/app1/export/e-done/links", "bo");
expect(links.status).toBe(200);
expect(links.body.ttl_seconds).toBe(300);
expect(links.body.links.length).toBe(2);
expect(links.body.links[0].hash).toBe(H1);
expect(links.body.links[0].kind).toBe("kv");
expect(links.body.links[1].kind).toBe("bundle");
// The sim's presign facade mirrors the scoped shape: the TARGET tenant and
// the exports pool are in the signed path — never the admin's own prefix.
expect(links.body.links[0].url.indexOf("app1") !== -1).toBe(true);
expect(links.body.links[0].url.indexOf("exports") !== -1).toBe(true);
// An unfinished export has no links yet.
expect(call(mk({ ["_export/e-run"]: RUNNING }),
            "GET", "/v1/instances/app1/export/e-run/links", "bo").status).toBe(409);
