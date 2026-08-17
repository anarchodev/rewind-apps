// Account deletion (rove#340): the durable job in __admin__'s own kv —
// acctdel/{aid} is both the job marker and the tombstone. Covers the entry
// guards (typed confirm, sole-owner refusal, in-progress 409), each phase of
// the acctdelWake driver (billing → instances → rows → idp), the CP-delete
// terminal callback (both arms), the tombstone's resurrection guards, the
// team-account variant, the root ops surface, and the account-rows export.
//
// Every phase is driven in isolation from an explicitly seeded marker —
// exactly how the job itself resumes after a crash, which is the point.
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

const alice = "alice@x.com", bob = "bob@x.com", ops = "ops@rewindjs.com";
const A = uh(alice), B = uh(bob);
const TEAM = "team1";
const sess = (sub, is_root) => j({ sub, is_root, exp: FAR });

// alice: personal account owning app1+app2 with a live subscription; also
// SOLE owner of team1 (which blocks deletion until transferred/deleted).
const BASE = {
  "_config/oidc/rp/default": RP_CONFIG,
  "_rp/sess/op": sess(ops, true),
  "_rp/sess/al": sess(alice, false),
  "_rp/sess/bo": sess(bob, false),
  ["account/" + A + "/members/" + A]: "owner",
  ["user/" + A + "/accounts/" + A]: "owner",
  ["account/" + A + "/email/" + A]: alice,
  ["account/" + A + "/instances/app1"]: "",
  ["account/" + A + "/instances/app2"]: "",
  "instance/app1/owner": A,
  "instance/app2/owner": A,
  "instance/app1/host": "app1.rewindjs.app",
  ["account/" + A + "/billing/customer"]: "cus_123",
  ["account/" + A + "/billing/subscription"]: "sub_456",
  ["account/" + A + "/billing/status"]: "active",
  "billing/customer/cus_123": A,
  "stripe_key": "sk_test_x",
  // team1: alice sole owner, bob member
  ["account/" + TEAM + "/members/" + A]: "owner",
  ["account/" + TEAM + "/members/" + B]: "member",
  ["user/" + A + "/accounts/" + TEAM]: "owner",
  ["user/" + B + "/accounts/" + TEAM]: "member",
  ["account/" + TEAM + "/meta"]: j({ name: "Team One" }),
  ["account/" + TEAM + "/email/" + A]: alice,
};

const mk = (extra) => scenario({
  admin: true,
  now: "2026-08-16T00:00:00Z",
  seed: 11,
  kv: Object.assign({}, BASE, extra || {}),
  instances: { app1: {}, app2: {}, __auth__: { kv: {
    // __auth__ rows the idp phase must sweep (alice's) or keep (bob's).
    ["_oidc/session/sid-a"]: j({ sub: alice, auth_time: 1 }),
    ["_oidc/session/sid-b"]: j({ sub: bob, auth_time: 2 }),
    ["_oidc/magic/tok-a"]: j({ email: alice, return_to: "/", exp: FAR }),
    ["_oidc/at/default/at-a"]: j({ sub: alice, exp: FAR }),
    ["_oidc/rt/default/rt-b"]: j({ sub: bob, exp: FAR }),
    ["_oidc/magic_cooldown/" + uh(alice)]: "1",
  } } },
});
const s = mk();
const call = (method, path, sid, body) =>
  s.inbound({ method, path, host: "app.rewindjs.com", body, session: sid ? { id: sid } : undefined });

const DEL = "acctdel/";
const marker = (over) => j(Object.assign({
  state: "running", phase: "billing", is_team: false, email: alice,
  requested_by: A, started_ms: 1, updated_ms: 1,
}, over || {}));

// ── Entry guards ───────────────────────────────────────────────────────────
// No session → 401 (authed class); root M2M has no personal account → 401.
expect(call("POST", "/v1/account/delete", null, { confirm: alice }).status).toBe(401);
// Wrong confirm → 400 and NO marker.
const badc = call("POST", "/v1/account/delete", "al", { confirm: "wrong@x.com" });
expect(badc.status).toBe(400);
expect(badc.kv(DEL + A)).toBe(null);
// Sole owner of team1 → 409 naming it, and NO marker.
const sole = call("POST", "/v1/account/delete", "al", { confirm: alice });
expect(sole.status).toBe(409);
expect(sole.body.error).toBe("sole_owner_of_teams");
expect(sole.body.teams[0].name).toBe("Team One");
expect(sole.kv(DEL + A)).toBe(null);

// ── Start (happy path) — bob has no teams and owns nothing beyond himself ──
const sB = mk({
  ["account/" + B + "/members/" + B]: "owner",
  ["user/" + B + "/accounts/" + B]: "owner",
  ["account/" + B + "/instances/appb"]: "",
  "instance/appb/owner": B,
});
const started = sB.inbound({ method: "POST", path: "/v1/account/delete",
  host: "app.rewindjs.com", body: { confirm: " Bob@X.com " }, // normalization point
  session: { id: "bo" } });
expect(started.status).toBe(202);
expect(started.body.deleting).toBe(true);
const m0 = started.kv(DEL + B); // kv() auto-parses JSON values
expect(m0.state).toBe("running");
expect(m0.phase).toBe("billing");
expect(m0.email).toBe(bob);
// He left team1 synchronously (member row + reverse index gone).
expect(started.kv("account/" + TEAM + "/members/" + B)).toBe(null);
expect(started.kv("user/" + B + "/accounts/" + TEAM)).toBe(null);
expect(started).toHaveScheduled("index.mjs.acctdelWake");
// Double-submit while running → 409.
const dup = mk({ [DEL + A]: marker() })
  .inbound({ method: "POST", path: "/v1/account/delete", host: "app.rewindjs.com",
             body: { confirm: alice }, session: { id: "al" } });
expect(dup.status).toBe(409);
expect(dup.body.error).toBe("deletion_in_progress");

// ── Tombstone guards ────────────────────────────────────────────────────────
const sDel = mk({ [DEL + A]: marker() });
// Session mid-deletion reports it and materializes nothing.
const who = sDel.inbound({ method: "GET", path: "/v1/session",
  host: "app.rewindjs.com", session: { id: "al" } });
expect(who.body.deleting).toBe(true);
expect(who.body.accounts).toEqual([]);
// Provision under a deleting account → 409.
expect(sDel.inbound({ method: "POST", path: "/v1/instances", host: "app.rewindjs.com",
  body: { name: "fresh" }, session: { id: "al" } }).status).toBe(409);
// New team while deleting → 409.
expect(sDel.inbound({ method: "POST", path: "/v1/accounts", host: "app.rewindjs.com",
  body: { name: "NewTeam" }, session: { id: "al" } }).status).toBe(409);
// A FAILED job blocks identically (frozen, operator-owned).
const sFail = mk({ [DEL + A]: marker({ state: "failed", error: "x" }) });
expect(sFail.inbound({ method: "GET", path: "/v1/session", host: "app.rewindjs.com",
  session: { id: "al" } }).body.deleting).toBe(true);
// Terminal `done` blocks NOTHING — the next session lazily re-materializes a
// fresh personal account under the same hash (the re-signup path). Seed a
// done marker with the account rows already erased.
const sDone = scenario({
  admin: true, now: "2026-08-16T00:00:00Z", seed: 11,
  kv: {
    "_config/oidc/rp/default": RP_CONFIG,
    "_rp/sess/al": sess(alice, false),
    [DEL + A]: marker({ state: "done", phase: "done" }),
  },
});
const reborn = sDone.inbound({ method: "GET", path: "/v1/session",
  host: "app.rewindjs.com", session: { id: "al" } });
expect(!!reborn.body.deleting).toBe(false);
expect(reborn.kv("account/" + A + "/members/" + A)).toBe("owner"); // backfilled fresh

// ── acctdelWake: billing phase ──────────────────────────────────────────────
// Cancels the subscription NOW (durable DELETE, idempotency-keyed) and falls
// through to the instances phase in the same activation.
const wBilling = mk({ [DEL + A]: marker() })
  .wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
expect(wBilling).toHaveSent("webhook", {
  method: "DELETE",
  url: "https://api.stripe.com/v1/subscriptions/sub_456",
});
// One durable CP delete per owned instance, keyed per (account, tenant).
expect(wBilling).toHaveSent("webhook", { body: j({ tenant: "app1" }) });
expect(wBilling).toHaveSent("webhook", { body: j({ tenant: "app2" }) });
const mB = wBilling.kv(DEL + A);
expect(mB.phase).toBe("instances");
expect(wBilling.kv(DEL + A + "/inst/app1")).toBe("pending");
expect(wBilling.kv(DEL + A + "/inst/app2")).toBe("pending");
// The watchdog re-armed (same key — the entry moves, never accumulates).
expect(wBilling).toHaveScheduled("index.mjs.acctdelWake");

// No subscription → no Stripe send, still advances.
const wNoSub = mk({ [DEL + B]: marker({ email: bob, requested_by: B }) })
  .wake({ on: "index.mjs.acctdelWake", ctx: { aid: B }, key: DEL + B });
expect(wNoSub.kv(DEL + B).phase).toBe("idp"); // no instances, no rows — straight through to idp

// ── onAcctdelCpDelete: the terminal callback, both arms ────────────────────
const instState = {
  [DEL + A]: marker({ phase: "instances" }),
  [DEL + A + "/inst/app1"]: "pending",
  [DEL + A + "/inst/app2"]: "gone",
};
const cbOk = mk(instState).sendCallback({
  on: "acctdel_result.mjs",
  result: { status: 204, attempts: 1 },
  ctx: { aid: A, tenant: "app1" },
});
expect(cbOk.kv(DEL + A + "/inst/app1")).toBe("gone");
expect(cbOk.kv("account/" + A + "/instances/app1")).toBe(null);
expect(cbOk.kv("instance/app1/owner")).toBe(null);
expect(cbOk.kv("instance/app1/host")).toBe(null);
expect(cbOk).toHaveScheduled("index.mjs.acctdelWake"); // kick the driver now
// 404 converges the same way (a retried job finds the tenant already gone).
const cbGone = mk(instState).sendCallback({
  on: "acctdel_result.mjs",
  result: { status: 404, attempts: 1 },
  ctx: { aid: A, tenant: "app1" },
});
expect(cbGone.kv(DEL + A + "/inst/app1")).toBe("gone");
// A terminal failure (the send burned its retry budget) freezes the job.
const cbFail = mk(instState).sendCallback({
  on: "acctdel_result.mjs",
  result: { status: 502, attempts: 8 },
  ctx: { aid: A, tenant: "app1" },
});
expect(cbFail.kv(DEL + A + "/inst/app1")).toBe("failed:502");
const mF = cbFail.kv(DEL + A);
expect(mF.state).toBe("failed");
// The account rows are STILL THERE — half-erased is never the resting state.
expect(cbFail.kv("account/" + A + "/instances/app1")).toBe("");

// ── acctdelWake: instances phase waits, then advances ──────────────────────
// All gone → rows phase in the same firing (the straggler instance rows the
// callbacks would normally have cleared are swept by the rows phase itself).
const wRows = mk({
  [DEL + A]: marker({ phase: "instances" }),
  [DEL + A + "/inst/app1"]: "gone",
  [DEL + A + "/inst/app2"]: "gone",
}).wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
const mR = wRows.kv(DEL + A);
// rows phase ran immediately (small account): account rows + reverse
// indexes are gone and the job advanced to the idp phase.
expect(mR.phase).toBe("idp");
expect(wRows.kv("account/" + A + "/members/" + A)).toBe(null);
expect(wRows.kv("account/" + A + "/email/" + A)).toBe(null);
expect(wRows.kv("account/" + A + "/billing/subscription")).toBe(null);
expect(wRows.kv("billing/customer/cus_123")).toBe(null);
expect(wRows.kv("user/" + A + "/accounts/" + A)).toBe(null);
// A failed instance discovered at wake time freezes too.
const wFail = mk({
  [DEL + A]: marker({ phase: "instances" }),
  [DEL + A + "/inst/app1"]: "failed:503",
  [DEL + A + "/inst/app2"]: "gone",
}).wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
expect(wFail.kv(DEL + A).state).toBe("failed");

// ── acctdelWake: idp phase — each step is one bounded page, seeded exactly
// as a crash-resume would find it. Step order (ACCTDEL_IDP_STEPS):
// 0=_rp/sess (admin kv), 1=_oidc/session, 2=magic, 3=code, 4=at, 5=rt,
// 6=device, 7=device_user (all in __auth__), then the cooldown + finish.
const idpAt = (step) => ({ [DEL + A]: marker({ phase: "idp", idp_step: step, idp_cursor: "" }) });
// Step 0: alice's dashboard session dies; bob's survives.
const w0 = mk(idpAt(0)).wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
expect(w0.kv("_rp/sess/al")).toBe(null);
expect(w0.kv("_rp/sess/bo")).toEqual({ sub: bob, is_root: false, exp: FAR });
expect(w0.kv(DEL + A).idp_step).toBe(1);
expect(w0).toHaveScheduled("index.mjs.acctdelWake"); // continues immediately
// Step 1: __auth__ sessions — alice's swept by sub match, bob's kept.
const w1 = mk(idpAt(1)).wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
expect(w1.instanceKv("__auth__", "_oidc/session/sid-a")).toBe(null);
expect(w1.instanceKv("__auth__", "_oidc/session/sid-b")).toEqual({ sub: bob, auth_time: 2 });
// Step 2: live magic links match on the payload email.
const w2 = mk(idpAt(2)).wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
expect(w2.instanceKv("__auth__", "_oidc/magic/tok-a")).toBe(null);
// Step 4: access tokens by sub; bob's refresh token (step 5's prefix) intact.
const w4 = mk(idpAt(4)).wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
expect(w4.instanceKv("__auth__", "_oidc/at/default/at-a")).toBe(null);
expect(w4.instanceKv("__auth__", "_oidc/rt/default/rt-b")).toEqual({ sub: bob, exp: FAR });
// Step 7 (last): finishing deletes the send cooldown, drops the per-instance
// bookkeeping, and the marker goes terminal `done`.
const w7 = mk(Object.assign(idpAt(7), { [DEL + A + "/inst/app1"]: "gone" }))
  .wake({ on: "index.mjs.acctdelWake", ctx: { aid: A }, key: DEL + A });
const st7 = w7.kv(DEL + A);
expect(st7.state).toBe("done");
expect(w7.instanceKv("__auth__", "_oidc/magic_cooldown/" + uh(alice))).toBe(null);
expect(w7.kv(DEL + A + "/inst/app1")).toBe(null);

// ── Team deletion ───────────────────────────────────────────────────────────
// bob (member) can't; alice (owner) types the wrong name; then the real one.
expect(call("DELETE", "/v1/accounts/" + TEAM, "bo", { confirm: "Team One" }).status).toBe(403);
expect(call("DELETE", "/v1/accounts/" + TEAM, "al", { confirm: "team one" }).status).toBe(400);
const tdel = call("DELETE", "/v1/accounts/" + TEAM, "al", { confirm: "Team One" });
expect(tdel.status).toBe(202);
expect(tdel.kv(DEL + TEAM).is_team).toBe(true);
// Personal accounts are not deletable through the team route.
expect(call("DELETE", "/v1/accounts/" + A, "al", { confirm: alice }).status).toBe(400);
// A team job skips the idp phase: rows → done directly.
const wTeam = mk({
  [DEL + TEAM]: marker({ is_team: true, email: null, phase: "rows", cursor: "" }),
}).wake({ on: "index.mjs.acctdelWake", ctx: { aid: TEAM }, key: DEL + TEAM });
const mT = wTeam.kv(DEL + TEAM);
expect(mT.state).toBe("done");
expect(wTeam.kv("account/" + TEAM + "/members/" + B)).toBe(null);
expect(wTeam.kv("user/" + B + "/accounts/" + TEAM)).toBe(null); // reverse index harvested

// ── Root ops surface ────────────────────────────────────────────────────────
const sOps = mk({
  [DEL + A]: marker({ state: "failed", phase: "instances", error: "instance app1 delete failed" }),
  [DEL + A + "/inst/app1"]: "failed:502",
  [DEL + A + "/inst/app2"]: "gone",
});
expect(sOps.inbound({ method: "GET", path: "/v1/deletions", host: "app.rewindjs.com",
  session: { id: "al" } }).status).toBe(403); // root-only
const listed = sOps.inbound({ method: "GET", path: "/v1/deletions",
  host: "app.rewindjs.com", session: { id: "op" } });
expect(listed.status).toBe(200);
expect(listed.body.deletions.length).toBe(1); // inst rows filtered out
expect(listed.body.deletions[0].state).toBe("failed");
const retried = sOps.inbound({ method: "POST", path: "/v1/deletions/" + A + "/retry",
  host: "app.rewindjs.com", session: { id: "op" } });
expect(retried.status).toBe(200);
expect(retried.kv(DEL + A + "/inst/app1")).toBe(null); // reset to unsent
expect(retried.kv(DEL + A + "/inst/app2")).toBe("gone"); // completed work kept
expect(retried.kv(DEL + A).state).toBe("running");
expect(retried).toHaveScheduled("index.mjs.acctdelWake");

// ── Account-rows export (slice 4) ───────────────────────────────────────────
expect(call("GET", "/v1/accounts/" + TEAM + "/export", null).status).toBe(401);
const exp2 = call("GET", "/v1/accounts/" + TEAM + "/export", "bo"); // member may export
expect(exp2.status).toBe(200);
expect(exp2.body.name).toBe("Team One");
expect(exp2.body.members.some((m) => m.email === alice && m.role === "owner")).toBe(true);
// Redactions hold: no invite token hashes, no Stripe item id.
expect(j(exp2.body).indexOf("tokenHash")).toBe(-1);
expect(Object.keys(exp2.body.billing).indexOf("item")).toBe(-1);
const expMine = call("GET", "/v1/accounts/" + A + "/export", "al");
expect(expMine.body.instances.some((i) => i.id === "app1" && i.host === "app1.rewindjs.app")).toBe(true);
// A non-member is refused.
expect(call("GET", "/v1/accounts/" + A + "/export", "bo").status).toBe(403);
