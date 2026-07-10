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
  root: { kv: { "instance/taken1": j({ created: true }) } }, // for provision name-taken
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
const prov = (name, sid, account) => call("POST", "/v1/instances", sid, account ? { name, account } : { name });
expect(prov("newapp", null).status).toBe(401);                  // unauthenticated
expect(prov("admin", "al").status).toBe(409);                   // reserved name
expect(prov("taken1", "al").status).toBe(409);                  // name already taken (root store)
expect(prov("newapp", "ca", TEAM).status).toBe(403);            // carol isn't a member of team1
const made = prov("newapp", "al");                              // alice's personal account → created
expect(made.status).toBe(201);
expect(made.effects.some((e) => e.kind === "platform" && e.op === "instances.create")).toBe(true);
// team1 is at its free-plan limit (1 instance) → refused
const capped = scenario({
  admin: true, now: "2026-07-01T00:00:00Z", seed: 7,
  kv: Object.assign({}, BASE, { ["account/" + TEAM + "/instances/existing"]: "" }),
});
const limit = capped.inbound({ method: "POST", path: "/v1/instances", host: "app.rewindjs.com",
  body: { name: "another", account: TEAM }, session: { id: "al" } });
expect(limit.status).toBe(403);
expect(limit.body.error).toBe("account_limit_reached");
