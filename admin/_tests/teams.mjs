// Admin team-account model + the routeAuthz gate. The security-critical surface:
// the per-class authz matrix (authed / root / accountOwner / accountMember),
// ownership-transfer safety (last-owner guard, personal-account immutability),
// the email-bound invite accept, and the provisioning gate (reserved / taken /
// plan-limit / non-member). All membership rows are sha256(email)-keyed, so the
// fixture computes hashes with the same userHashFor the handler uses.
//
// Each assertion runs a fresh inbound from the shared BASE kv (writes don't leak
// between activations), driven through the real router + _middlewares OIDC guard.
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

const alice = "alice@x.com", bob = "bob@x.com", carol = "carol@x.com", ops = "ops@rewindjs.com";
const A = uh(alice), B = uh(bob), C = uh(carol);
const TEAM = "team1";
const INV = "inv-secret", INV_OLD = "inv-expired";

const sess = (sub, is_root) => j({ sub, is_root, exp: FAR });

// team1: alice owner, bob member; plus a pending + an expired invite for carol,
// and alice's personal account (aid === her hash).
const BASE = {
  "_config/oidc/rp/default": RP_CONFIG,
  "_rp/sess/op": sess(ops, true),
  "_rp/sess/al": sess(alice, false),
  "_rp/sess/bo": sess(bob, false),
  "_rp/sess/ca": sess(carol, false),
  ["account/" + TEAM + "/members/" + A]: "owner",
  ["account/" + TEAM + "/members/" + B]: "member",
  ["user/" + A + "/accounts/" + TEAM]: "owner",
  ["user/" + B + "/accounts/" + TEAM]: "member",
  ["account/" + TEAM + "/plan"]: "free",
  ["account/" + TEAM + "/meta"]: j({ name: "Team One" }),
  ["account/" + TEAM + "/email/" + A]: alice,
  ["account/" + TEAM + "/email/" + B]: bob,
  // alice's personal account
  ["account/" + A + "/members/" + A]: "owner",
  ["user/" + A + "/accounts/" + A]: "owner",
  // invites for carol (valid + expired)
  ["invite/" + uh(INV)]: j({ aid: TEAM, emailHash: C, email: carol, role: "member", exp_ms: FAR, invited_by: A }),
  ["account/" + TEAM + "/pending/" + C]: j({ email: carol, tokenHash: uh(INV), role: "member", exp_ms: FAR }),
  ["invite/" + uh(INV_OLD)]: j({ aid: TEAM, emailHash: C, email: carol, role: "member", exp_ms: 1, invited_by: A }),
};

const s = scenario({
  admin: true,
  now: "2026-07-01T00:00:00Z",
  seed: 7,
  kv: BASE,
});
const call = (method, path, sid, body) =>
  s.inbound({ method, path, host: "app.rewindjs.com", body, session: sid ? { id: sid } : undefined });

// ── routeAuthz matrix ─────────────────────────────────────────────────────
// authed: no session → 401
expect(call("POST", "/v1/instances", null, { name: "foo" }).status).toBe(401);
// root: a non-operator is refused; the operator passes
expect(call("GET", "/v1/domains", "al").status).toBe(403);
expect(call("GET", "/v1/domains", "op").status).toBe(200);
// accountOwner: a plain member (bob) can't invite; accountMember: a non-member (carol) can't list
expect(call("POST", "/v1/accounts/" + TEAM + "/invites", "bo", { email: "x@y.com" }).status).toBe(403);
expect(call("GET", "/v1/accounts/" + TEAM + "/members", "ca").status).toBe(403);
// accountMember: bob (a member) can list
expect(call("GET", "/v1/accounts/" + TEAM + "/members", "bo").status).toBe(200);

// ── setMemberRole: ownership-transfer safety (accountOwner, alice) ─────────
const role = (aid, h, r) => call("PUT", "/v1/accounts/" + aid + "/members/" + h, "al", { role: r });
expect(role(TEAM, B, "admin").status).toBe(400);                 // invalid role
const promo = role(TEAM, B, "owner");                            // promote bob
expect(promo.status).toBe(200);
expect(promo.kv("account/" + TEAM + "/members/" + B)).toBe("owner");
const demote = role(TEAM, A, "member");                          // can't strand the last owner
expect(demote.status).toBe(409);
expect(demote.body.error).toBe("last_owner");
expect(role(TEAM, C, "member").status).toBe(404);               // not a member
expect(role(A, B, "member").status).toBe(400);                  // personal account is immutable

// ── acceptInvite: acceptance is BOUND to the invited email ────────────────
const accept = (token, sid) => call("POST", "/v1/invites/accept", sid, { token });
expect(accept(INV, "bo").status).toBe(403);                     // bob isn't the invitee
const joined = accept(INV, "ca");                               // carol is
expect(joined.status).toBe(200);
expect(joined.kv("account/" + TEAM + "/members/" + C)).toBe("member");
expect(joined.kv("invite/" + uh(INV))).toBe(null);             // single-use
expect(accept(INV_OLD, "ca").status).toBe(410);                // expired

// ── provisionInstance: the provisioning gate (authed) ─────────────────────
// A provision is a two-activation saga (rove#291): this handler checks AUTHZ
// and then asks the control plane, which owns EXISTENCE — the name spec, the
// raft group, the placement. So the refusals a customer sees for a bad NAME are
// the CP's, delivered through the fetch resume; only the authz refusals are
// answered here without ever reaching the door.
const prov = (name, sid, account) => call("POST", "/v1/instances", sid, account ? { name, account } : { name });
expect(prov("newapp", null).status).toBe(401);                  // unauthenticated
expect(prov("newapp", "ca", TEAM).status).toBe(403);            // carol isn't a member of team1
// An authz refusal must not reach the control plane at all.
expect(prov("newapp", "ca", TEAM).effects.some((e) => e.kind === "fetch")).toBe(false);

// The CP's refusals reach the customer verbatim, with the CP's own status.
const reserved = prov("admin", "al").fetch(/rewind-cp/).resolve({
  status: 400, body: '{"error":"that name is reserved"}',
});
expect(reserved.status).toBe(400);
expect(reserved.body.error).toBe("that name is reserved");
const taken = prov("taken1", "al").fetch(/rewind-cp/).resolve({
  status: 409, body: '{"error":"that name is taken"}',
});
expect(taken.status).toBe(409);

// alice's personal account → placed. The reply carries the host the CP named,
// and the ownership rows appear only on this success path.
const made = prov("newapp", "al").fetch(/rewind-cp/).resolve({
  status: 200,
  body: '{"tenant":"newapp","cluster":"prod","host":"newapp.rewindjs.app"}',
});
expect(made.status).toBe(201);
expect(made.body.host).toBe("newapp.rewindjs.app");
expect(made.kv("instance/newapp/owner")).toBe(A);
expect(made.kv("instance/newapp/host")).toBe("newapp.rewindjs.app");
expect(made.effects.some((e) => e.kind === "platform" && e.op === "instances.deployStarter")).toBe(true);
// The local create is GONE — it made a tenant on one node that nothing routed
// to. Its presence here would mean the CP path had been bypassed again.
expect(made.effects.some((e) => e.kind === "platform" && e.op === "instances.create")).toBe(false);
// ── deleteInstance: deprovision (rove#294) ────────────────────────────────
// Mirror of provisioning: authz here, EXISTENCE at the control plane. The
// destructive guards are the point — everything below is what stands between a
// mis-click and a destroyed tenant.
// Its own scenario: the delete path needs an instance that EXISTS and is owned
// by team1, which the shared BASE deliberately has none of.
const owned = scenario({
  admin: true, now: "2026-07-01T00:00:00Z", seed: 7,
  kv: Object.assign({}, BASE, {
    ["account/" + TEAM + "/instances/existing"]: "",
    "instance/existing/owner": TEAM,
  }),
});
const del = (id, sid, confirm) =>
  owned.inbound({ method: "DELETE", path: "/v1/instances/" + id, host: "app.rewindjs.com",
                  body: confirm === undefined ? undefined : { confirm },
                  session: sid ? { id: sid } : undefined });

// Not yours → 403, and it never reaches the control plane.
expect(del("existing", "ca", "existing").status).toBe(403);
expect(del("existing", "ca", "existing").effects.some((e) => e.kind === "fetch")).toBe(false);

// A platform singleton is refused locally — deleting __admin__ would destroy
// the surface serving the request.
expect(del("__admin__", "op", "__admin__").status).toBe(403);
expect(del("__admin__", "op", "__admin__").effects.some((e) => e.kind === "fetch")).toBe(false);

// No confirmation, or the WRONG name, must not delete anything.
expect(del("taken1", "op").status).toBe(400);
expect(del("taken1", "op", "").status).toBe(400);
expect(del("taken1", "op", "wrongname").status).toBe(400);
expect(del("taken1", "op", "wrongname").effects.some((e) => e.kind === "fetch")).toBe(false);

// Confirmed + authorized → asks the CP, and on success frees the plan slot.
const gone = del("existing", "al", "existing").fetch(/rewind-cp/).resolve({ status: 204, body: "" });
expect(gone.status).toBe(204);
expect(gone.kv("account/" + TEAM + "/instances/existing")).toBe(null);
expect(gone.kv("instance/existing/owner")).toBe(null);

// A CP refusal leaves the ownership rows ALONE — the tenant still exists, and
// an account that lost its rows would own an instance it could no longer see.
const refused = del("existing", "al", "existing").fetch(/rewind-cp/).resolve({
  status: 502, body: '{"error":"tenant is unroutable, but its group was not fully torn down — retry"}',
});
expect(refused.status).toBe(502);
expect(refused.body.error).toMatch(/retry/);
expect(refused.kv("account/" + TEAM + "/instances/existing")).toBe("");

// team1 is at its free-plan limit (1 instance) → refused
const capped = scenario({
  admin: true, now: "2026-07-01T00:00:00Z", seed: 7,
  kv: Object.assign({}, BASE, { ["account/" + TEAM + "/instances/existing"]: "" }),
});
const limit = capped.inbound({ method: "POST", path: "/v1/instances", host: "app.rewindjs.com",
  body: { name: "another", account: TEAM }, session: { id: "al" } });
expect(limit.status).toBe(403);
expect(limit.body.error).toBe("account_limit_reached");
