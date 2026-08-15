// Billing state on the account (rove#308): the subscription graph lives in
// the dashboard's own kv, hanging off account/{aid}/billing/*, with a
// billing/customer/{cus} reverse index so a webhook resolves the account in
// O(1). This file drives the read surface; the writers land with their first
// caller (the webhook route, rove#309) and extend this file.
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

// team1 has a live subscription; alice's personal account has none.
const BASE = {
  "_config/oidc/rp/default": RP_CONFIG,
  "_rp/sess/al": sess(alice, false),
  "_rp/sess/bo": sess(bob, false),
  "_rp/sess/ca": sess(carol, false),
  ["account/" + TEAM + "/members/" + A]: "owner",
  ["account/" + TEAM + "/members/" + B]: "member",
  ["user/" + A + "/accounts/" + TEAM]: "owner",
  ["user/" + B + "/accounts/" + TEAM]: "member",
  ["account/" + TEAM + "/plan"]: "pro",
  ["account/" + TEAM + "/meta"]: j({ name: "Team One" }),
  ["account/" + TEAM + "/billing/customer"]: "cus_123",
  ["account/" + TEAM + "/billing/subscription"]: "sub_456",
  ["account/" + TEAM + "/billing/status"]: "active",
  ["account/" + TEAM + "/billing/period_end"]: "1790000000000",
  ["billing/customer/cus_123"]: TEAM,
  // alice's personal account — no billing rows at all
  ["account/" + A + "/members/" + A]: "owner",
  ["user/" + A + "/accounts/" + A]: "owner",
};

const s = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 3, kv: BASE });
const call = (method, path, sid) =>
  s.inbound({ method, path, host: "app.rewindjs.com", session: sid ? { id: sid } : undefined });

// A member reads the populated state; status is Stripe's vocabulary verbatim,
// period_end comes back numeric, plan rides along.
const asMember = call("GET", "/v1/accounts/" + TEAM + "/billing", "bo");
expect(asMember.status).toBe(200);
expect(asMember.body).toEqual({
  customer: "cus_123", subscription: "sub_456", status: "active",
  period_end: 1790000000000, plan: "pro",
});

// An account with no billing rows reads as the null shape on the free plan —
// the UI branches on `customer === null` for "no payment method yet".
const empty = call("GET", "/v1/accounts/" + A + "/billing", "al");
expect(empty.status).toBe(200);
expect(empty.body).toEqual({
  customer: null, subscription: null, status: null, period_end: null, plan: "free",
});

// Authz is the accountMember matrix: a non-member is refused, no session 401s.
expect(call("GET", "/v1/accounts/" + TEAM + "/billing", "ca").status).toBe(403);
expect(call("GET", "/v1/accounts/" + TEAM + "/billing", null).status).toBe(401);
