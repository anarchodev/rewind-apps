// Ownership is bound to a tenant's INCARNATION, not its name (rove#552).
//
// An operator-side deprovision (`rewind-ops delete` → CP `/_control/delete`)
// never reaches this app, so the dashboard's ownership rows outlive the tenant.
// When the name is provisioned again it is a different tenant — fresh storage
// under a fresh incarnation — and the rows left from the earlier lifetime must
// grant nothing on any gated surface. Every request below runs as a
// NON-operator: an operator passes every gate and would prove nothing.
import { scenario, expect } from "rewind:test";

const RP_CONFIG = {
  issuer: "https://auth.rewindjs.com",
  client_id: "admin-dashboard",
  redirect_uri: "https://app.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000;
const uh = (email) => crypto.sha256(email.trim().toLowerCase()); // == userHashFor
const j = JSON.stringify;

const alice = "alice@x.com", bob = "bob@x.com", ops = "ops@rewindjs.com";
const A = uh(alice), B = uh(bob);
const NAME = "reused";
const INC_A = "aaaaaaaaaaaaaaaa", INC_B = "bbbbbbbbbbbbbbbb";
const sess = (sub, is_root) => j({ sub, is_root, exp: FAR });

// Two customers, each with a personal account, and an operator.
const PEOPLE = {
  "_config/oidc/rp/default": RP_CONFIG,
  "_rp/sess/op": sess(ops, true),
  "_rp/sess/al": sess(alice, false),
  "_rp/sess/bo": sess(bob, false),
  ["account/" + A + "/members/" + A]: "owner",
  ["user/" + A + "/accounts/" + A]: "owner",
  ["account/" + A + "/plan"]: "free",
  ["account/" + B + "/members/" + B]: "owner",
  ["user/" + B + "/accounts/" + B]: "owner",
  ["account/" + B + "/plan"]: "free",
};
// What alice's provision left behind — and what an operator-side delete
// leaves behind, untouched.
const ALICE_ROWS = {
  ["account/" + A + "/instances/" + NAME]: "",
  ["instance/" + NAME + "/owner"]: A,
  ["instance/" + NAME + "/incarnation"]: INC_A,
};

const world = (kv, instances) => scenario({
  admin: true, now: "2026-07-01T00:00:00Z", seed: 7,
  kv: Object.assign({}, PEOPLE, kv), instances,
  // The root store's existence marker follows the instance set, as it does
  // live: a deleted tenant has neither.
  root: { kv: Object.fromEntries(Object.keys(instances).map((id) => ["instance/" + id, instances[id].incarnation || "1"])) },
});
const caller = (s) => (method, path, sid, body) =>
  s.inbound({ method, path, host: "app.rewindjs.com", body, session: sid ? { id: sid } : undefined });

// Every surface that reads or changes a tenant's data, each through its gate.
const SURFACES = [
  ["GET",    "/v1/logs/" + NAME + "/list"],
  ["GET",    "/v1/logs/" + NAME + "/show/r1"],
  ["GET",    "/v1/sources/" + NAME + "/current"],
  ["GET",    "/v1/source/" + NAME + "/current"],
  ["GET",    "/v1/history/" + NAME],
  ["GET",    "/v1/instances/" + NAME],
  ["GET",    "/v1/instances/" + NAME + "/kv"],
  ["PUT",    "/v1/instances/" + NAME + "/kv", { key: "k", value: "v" }],
  ["POST",   "/v1/instances/" + NAME + "/release", { dep_id: "abcdef" }],
  ["POST",   "/v1/instances/" + NAME + "/export"],
  ["DELETE", "/v1/instances/" + NAME, { confirm: NAME }],
  ["POST",   "/v1/deploy/reset", { tenant: NAME }],
];
const refusedEverywhere = (call, sid) => {
  for (const [method, path, body] of SURFACES) {
    const r = call(method, path, sid, body);
    expect(r.status).toBe(403);
    // Refused BEFORE any door: nothing reached the logs, CP, or the tenant.
    expect(r.effects.some((e) => e.kind === "fetch" || (e.kind === "platform" && e.op === "dispatch"))).toBe(false);
  }
};

// ── 1. alice provisions; the binding is recorded with the ownership ───────
const fresh = caller(world({}, { [NAME]: { incarnation: INC_A } }));
const made = fresh("POST", "/v1/instances", "al", { name: NAME }).fetch(/rewind-cp/).resolve({
  status: 200,
  body: j({ tenant: NAME, cluster: "prod", host: NAME + ".rewindjs.app", incarnation: INC_A }),
});
expect(made.status).toBe(201);
expect(made.kv("instance/" + NAME + "/owner")).toBe(A);
expect(made.kv("instance/" + NAME + "/incarnation")).toBe(INC_A);

// A CP reply without the field falls back to the engine's own answer.
const older = fresh("POST", "/v1/instances", "al", { name: NAME }).fetch(/rewind-cp/).resolve({
  status: 200, body: j({ tenant: NAME, cluster: "prod", host: NAME + ".rewindjs.app" }),
});
expect(older.kv("instance/" + NAME + "/incarnation")).toBe(INC_A);

// While that lifetime is current, alice reaches her tenant.
const live = caller(world(ALICE_ROWS, { [NAME]: { incarnation: INC_A } }));
expect(live("GET", "/v1/logs/" + NAME + "/list", "al").disposition).toBe("held");
expect(live("GET", "/v1/instances/" + NAME + "/kv", "al").status === 403).toBe(false);
expect(live("GET", "/v1/logs/" + NAME + "/list", "bo").status).toBe(403);

// ── 2. operator deletes it out-of-band: the name resolves to nothing ──────
// alice's rows are all still there; the tenant is not.
refusedEverywhere(caller(world(ALICE_ROWS, {})), "al");

// ── 3. the name is provisioned again outside the dashboard ────────────────
// (an operator `rewind-ops provision`): a new incarnation, and alice's rows,
// still naming her, now point at someone else's tenant.
refusedEverywhere(caller(world(ALICE_ROWS, { [NAME]: { incarnation: INC_B } })), "al");

// ── 4. bob re-provisions the name through the dashboard ───────────────────
const reborn = caller(world(ALICE_ROWS, { [NAME]: { incarnation: INC_B } }));
const bobs = reborn("POST", "/v1/instances", "bo", { name: NAME }).fetch(/rewind-cp/).resolve({
  status: 200,
  body: j({ tenant: NAME, cluster: "prod", host: NAME + ".rewindjs.app", incarnation: INC_B }),
});
expect(bobs.status).toBe(201);
expect(bobs.kv("instance/" + NAME + "/owner")).toBe(B);
expect(bobs.kv("instance/" + NAME + "/incarnation")).toBe(INC_B);
// alice no longer lists — or pays a plan slot for — a tenant she lost.
expect(bobs.kv("account/" + A + "/instances/" + NAME)).toBe(null);

const after = caller(world({
  ["account/" + A + "/instances/" + NAME]: "", // even if her listing row survived
  ["account/" + B + "/instances/" + NAME]: "",
  ["instance/" + NAME + "/owner"]: B,
  ["instance/" + NAME + "/incarnation"]: INC_B,
}, { [NAME]: { incarnation: INC_B } }));
refusedEverywhere(after, "al");
// bob reaches every surface (none of these is a 403).
for (const [method, path, body] of SURFACES) {
  if (method === "DELETE") continue; // destructive; covered by teams.mjs
  expect(after(method, path, "bo", body).status === 403).toBe(false);
}
expect(after("GET", "/v1/logs/" + NAME + "/list", "bo").disposition).toBe("held");

// ── 5. fail closed on a row with no binding ───────────────────────────────
// An owner row with no recorded incarnation — written before the binding
// existed — grants nothing until an operator binds it.
const unbound = world({
  ["account/" + A + "/instances/" + NAME]: "",
  ["instance/" + NAME + "/owner"]: A,
}, { [NAME]: { incarnation: INC_A } });
const ub = caller(unbound);
expect(ub("GET", "/v1/logs/" + NAME + "/list", "al").status).toBe(403);

// The bind route is operator-only.
expect(ub("POST", "/v1/ops/incarnations/bind", "al", {}).status).toBe(403);
// dry_run reports what it would bind (for the operator's check) and writes nothing.
const dry = ub("POST", "/v1/ops/incarnations/bind", "op", { dry_run: true });
expect(dry.status).toBe(200);
expect(dry.body.bound).toEqual([{ tenant: NAME, owner: A, incarnation: INC_A }]);
expect(dry.kv("instance/" + NAME + "/incarnation")).toBe(null);
const bind = ub("POST", "/v1/ops/incarnations/bind", "op", {});
expect(bind.kv("instance/" + NAME + "/incarnation")).toBe(INC_A);

// A row already bound is never rewritten — a mismatch is the refusal working.
const stale = caller(world(ALICE_ROWS, { [NAME]: { incarnation: INC_B } }));
const kept = stale("POST", "/v1/ops/incarnations/bind", "op", {});
expect(kept.body.already_bound).toEqual([NAME]);
expect(kept.kv("instance/" + NAME + "/incarnation")).toBe(INC_A);
// A name that does not resolve is reported, not bound.
const gone = caller(world({ ["instance/" + NAME + "/owner"]: A }, {}));
expect(gone("POST", "/v1/ops/incarnations/bind", "op", {}).body.unresolved).toEqual([NAME]);
