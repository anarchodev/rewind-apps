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
  ["account/" + TEAM + "/billing/item"]: "si_9",
  stripe_key: "sk_test_x", stripe_pk: "pk_test_x",
  "stripe_price/pro": "price_pro", "stripe_price/enterprise": "price_ent",
  ["account/" + TEAM + "/instances/app1"]: "1",
  ["account/" + TEAM + "/instances/app2"]: "1",
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
  period_end: 1790000000000, cancel_at_period_end: false, plan: "pro",
});

// An account with no billing rows reads as the null shape on the free plan —
// the UI branches on `customer === null` for "no payment method yet".
const empty = call("GET", "/v1/accounts/" + A + "/billing", "al");
expect(empty.status).toBe(200);
expect(empty.body).toEqual({
  customer: null, subscription: null, status: null, period_end: null,
  cancel_at_period_end: false, plan: "free",
});

// Authz is the accountMember matrix: a non-member is refused, no session 401s.
expect(call("GET", "/v1/accounts/" + TEAM + "/billing", "ca").status).toBe(403);
expect(call("GET", "/v1/accounts/" + TEAM + "/billing", null).status).toBe(401);

// ── Stripe webhook (rove#309) ──────────────────────────────────────────────
// The only unauthenticated write surface: no call below carries a session.
// Payloads are signed in-test with the same secret the handler reads, at a
// timestamp equal to the scenario clock (verifyWebhook enforces tolerance
// against Date.now(), which the sim pins to `now`).
const WHSEC = "whsec_testsecret";
const T = Math.floor(Date.parse("2026-08-15T00:00:00Z") / 1000);
const signedPost = (sc, evt) => {
  const body = j(evt);
  const sig = "t=" + T + ",v1=" + crypto.hmacSha256(WHSEC, T + "." + body);
  return sc.inbound({ method: "POST", path: "/v1/billing/webhook", host: "app.rewindjs.com",
                      body, headers: { "stripe-signature": sig } });
};
const subEvt = (over) => Object.assign({
  id: "evt_1", created: T, type: "customer.subscription.updated",
  data: { object: { id: "sub_456", customer: "cus_123", status: "past_due",
                    current_period_end: T + 86400 } },
}, over);

const w = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 4, kv: Object.assign({
  stripe_whsec: WHSEC,
  // pre-applied markers for the dedupe + ordering branches
  "billing/event/evt_dup": String(T - 50),
}, BASE) });

// A valid subscription event updates the rows from the event's OWN object —
// status verbatim, period_end in ms — and stamps the ordering watermark.
const ok = signedPost(w, subEvt({}));
expect(ok.status).toBe(200);
expect(ok.body).toEqual({ received: true });
expect(ok.kv("account/" + TEAM + "/billing/status")).toBe("past_due");
expect(ok.kv("account/" + TEAM + "/billing/period_end")).toBe(String((T + 86400) * 1000));
expect(ok.kv("account/" + TEAM + "/billing/last_event_ts")).toBe(String(T));
expect(ok.kv("billing/event/evt_1")).toBe(String(T));

// Tampered body → 400 before ANY work; nothing written.
const bad = w.inbound({ method: "POST", path: "/v1/billing/webhook", host: "app.rewindjs.com",
  body: j(subEvt({})), headers: { "stripe-signature": "t=" + T + ",v1=" + "0".repeat(64) } });
expect(bad.status).toBe(400);
expect(bad.kv("account/" + TEAM + "/billing/status")).toBe("active"); // untouched BASE value

// Redelivery of a processed event id is a no-op (Stripe retries until 2xx).
const dup = signedPost(w, subEvt({ id: "evt_dup" }));
expect(dup.body).toEqual({ received: true, duplicate: true });
expect(dup.kv("account/" + TEAM + "/billing/status")).toBe("active");

// Out-of-order: an event OLDER than the applied watermark is refused by the
// event's own `created`, not by arrival order.
const w2 = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 4, kv: Object.assign({
  stripe_whsec: WHSEC,
  ["account/" + TEAM + "/billing/last_event_ts"]: String(T + 100),
}, BASE) });
const stale = signedPost(w2, subEvt({ id: "evt_old" }));
expect(stale.body).toEqual({ received: true, stale: true });
expect(stale.kv("account/" + TEAM + "/billing/status")).toBe("active");

// A customer we never linked is acknowledged, not errored — a 4xx would make
// Stripe retry forever on events we can never consume.
const unk = signedPost(w, subEvt({ id: "evt_unk",
  data: { object: { id: "sub_x", customer: "cus_nobody", status: "active" } } }));
expect(unk.body).toEqual({ received: true, ignored: "unknown customer" });

// Non-subscription events are acknowledged and ignored.
const other = signedPost(w, { id: "evt_inv", created: T, type: "invoice.paid", data: { object: {} } });
expect(other.body).toEqual({ received: true });
expect(other.kv("billing/event/evt_inv")).toBe(String(T));

// subscription.deleted with a malformed object still lands "canceled".
const del = signedPost(w, subEvt({ id: "evt_del", type: "customer.subscription.deleted",
  data: { object: { id: "sub_456", customer: "cus_123" } } }));
expect(del.kv("account/" + TEAM + "/billing/status")).toBe("canceled");

// Unconfigured secret → 503, fail loud (no silent fallback).
const bare = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 4, kv: BASE });
expect(signedPost(bare, subEvt({})).status).toBe(503);

// ── Webhook → enforcement (rove#311) ───────────────────────────────────────
// The tier rides the subscription's own metadata (stamped at checkout). An
// `active` event sets the plan row and durably pushes plan/{tenant} to the CP
// for EVERY owned instance — all inside the same atomic commit as the 200.
// Count durable plan pushes on a result — the marker writes webhook.send
// leaves under _send/owed/ whose url is the CP plan door. (`toHaveSent`
// asserts presence; absence needs the effect view.)
const planPushes = (r) => r.effects.filter((e) =>
  e.kind === "write" && typeof e.key === "string" && e.key.indexOf("_send/owed/") === 0 &&
  JSON.parse(e.value).url === "http://rewind-cp.internal/_control/plan").length;
const activeEvt = (over) => subEvt(Object.assign({
  id: "evt_up",
  data: { object: { id: "sub_456", customer: "cus_123", status: "active",
                    current_period_end: T + 86400, metadata: { tier: "enterprise" },
                    items: { data: [{ id: "si_evt" }] } } },
}, over));
const up = signedPost(w, activeEvt({}));
expect(up.status).toBe(200);
expect(up.kv("account/" + TEAM + "/plan")).toBe("enterprise");
expect(up.kv("account/" + TEAM + "/billing/item")).toBe("si_evt");
expect(up).toHaveSent("webhook", {
  url: "http://rewind-cp.internal/_control/plan",
  body: j({ tenant: "app1", plan: "enterprise" }),
  maxAttempts: 8,
});
expect(up).toHaveSent("webhook", {
  url: "http://rewind-cp.internal/_control/plan",
  body: j({ tenant: "app2", plan: "enterprise" }),
});

// Convergent no-op: active at the tier the account already has → row + no push.
// (BASE plan is "pro".)
const same = signedPost(w, activeEvt({ id: "evt_same",
  data: { object: { id: "sub_456", customer: "cus_123", status: "active",
                    metadata: { tier: "pro" } } } }));
expect(same.status).toBe(200);
expect(planPushes(same)).toBe(0);

// Cancellation walks the account back to free and pushes it to every tenant.
const down = signedPost(w, activeEvt({ id: "evt_down",
  data: { object: { id: "sub_456", customer: "cus_123", status: "canceled" } } }));
expect(down.kv("account/" + TEAM + "/plan")).toBe("free");
expect(down).toHaveSent("webhook", { body: j({ tenant: "app1", plan: "free" }) });
expect(down).toHaveSent("webhook", { body: j({ tenant: "app2", plan: "free" }) });

// past_due is the grace window: billing rows update, plan does NOT move and
// nothing is pushed — the dunning policy is rove#313's, not this handler's.
// (The evt_1 case above is exactly this: status past_due.)
expect(ok.kv("account/" + TEAM + "/plan")).toBe("pro");
expect(planPushes(ok)).toBe(0);

// An active event with an unknown/missing tier changes nothing — the plan
// cannot be guessed from a subscription we cannot map.
const mystery = signedPost(w, activeEvt({ id: "evt_myst",
  data: { object: { id: "sub_456", customer: "cus_123", status: "active",
                    metadata: { tier: "platinum" } } } }));
expect(mystery.status).toBe(200);
expect(mystery.kv("account/" + TEAM + "/plan")).toBe("pro");
expect(planPushes(mystery)).toBe(0);

// ── Plan-gated allowances (rove#312) ───────────────────────────────────────
// TEAM is on pro (max_instances 5) with 2 instances → provisioning passes the
// allowance gate (disposition held = the CP call was issued).
const provOk = w.inbound({ method: "POST", path: "/v1/instances", host: "app.rewindjs.com",
  body: j({ name: "app3", account: TEAM }), session: { id: "al" } });
expect(provOk.disposition).toBe("held");

// The downgrade case, decided: an account holding MORE instances than its
// tier allows keeps them all — the gate only refuses NEW creation. TEAM on
// free (limit 1) with 2 instances → 403, and both instance rows still stand.
const wFree = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 5,
  kv: Object.assign({}, BASE, { ["account/" + TEAM + "/plan"]: "free" }) });
const provBlocked = wFree.inbound({ method: "POST", path: "/v1/instances", host: "app.rewindjs.com",
  body: j({ name: "app3", account: TEAM }), session: { id: "al" } });
expect(provBlocked.status).toBe(403);
expect(provBlocked.body).toEqual({ error: "account_limit_reached", limit: 1, owned: 2 });
expect(provBlocked.kv("account/" + TEAM + "/instances/app1")).toBe("1");
expect(provBlocked.kv("account/" + TEAM + "/instances/app2")).toBe("1");

// Team-account allowance rides the caller's PERSONAL plan. Alice on free
// (max_team_accounts 2) already owning two teams → 403; on pro → allowed.
const twoTeams = {
  ["account/t2/members/" + A]: "owner", ["user/" + A + "/accounts/t2"]: "owner",
  ["account/t3/members/" + A]: "owner", ["user/" + A + "/accounts/t3"]: "owner",
};
const wTeams = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 6,
  kv: Object.assign({}, BASE, twoTeams) });
const teamBlocked = wTeams.inbound({ method: "POST", path: "/v1/accounts", host: "app.rewindjs.com",
  body: j({ name: "Team Four" }), session: { id: "al" } });
expect(teamBlocked.status).toBe(403);
expect(teamBlocked.body).toEqual({ error: "team_limit_reached", limit: 2 });

const wTeamsPro = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 6,
  kv: Object.assign({}, BASE, twoTeams, { ["account/" + A + "/plan"]: "pro" }) });
const teamOk = wTeamsPro.inbound({ method: "POST", path: "/v1/accounts", host: "app.rewindjs.com",
  body: j({ name: "Team Four" }), session: { id: "al" } });
expect(teamOk.status).toBe(201);

// ── Billing flow (rove#310) ────────────────────────────────────────────────
// Publishable key is config, not baked; unseeded is a loud 503.
expect(call("GET", "/v1/billing/config", "al").body).toEqual({ publishable_key: "pk_test_x" });
expect(signedPost(bare, subEvt({ id: "evt_cfg" })).status).toBe(503); // bare also lacks whsec
const noStripe = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 9, kv: {
  "_config/oidc/rp/default": RP_CONFIG, "_rp/sess/al": sess(alice, false),
} });
const cfgBare = noStripe.inbound({ method: "GET", path: "/v1/billing/config", host: "app.rewindjs.com",
  session: { id: "al" } });
expect(cfgBare.status).toBe(503);

// The full subscribe chain from an UNLINKED account (alice's personal): the
// customer-create hop carries everything in ctx and writes NOTHING (a kv
// write in a resume hop drops the platform call it issues — rove#344); the
// terminal hop writes the link rows, the subscription rows, and relays the
// payment intent secret.
const sub1 = w.inbound({ method: "POST", path: "/v1/accounts/" + A + "/billing/subscribe",
  host: "app.rewindjs.com", body: j({ tier: "pro" }), session: { id: "al" } });
expect(sub1.disposition).toBe("held");
expect(sub1).toHaveFetched(/api\.stripe\.com\/v1\/customers/);
const hop2 = sub1.fetch(/v1\/customers/).resolve({ status: 200, done: true, body: j({ id: "cus_new" }) });
expect(hop2.disposition).toBe("held");
expect(hop2).toHaveFetched(/api\.stripe\.com\/v1\/subscriptions/);
// First-ever attempt: the idempotency key is scoped by the prior
// subscription ("first" when none) — a static per-(aid,tier) key would make
// Stripe's 24h idempotent replay serve a dead attempt's canceled payment
// intent to the next subscribe.
const subFx = hop2.effects.filter((e) => e.kind === "fetch" && /v1\/subscriptions/.test(e.url))[0];
expect(subFx.headers["Idempotency-Key"]).toBe("subinc-" + A + "-pro-first");
const fin = hop2.fetch(/v1\/subscriptions/).resolve({ status: 200, done: true, body: j({
  id: "sub_new", status: "incomplete", customer: "cus_new",
  items: { data: [{ id: "si_new" }] },
  latest_invoice: { payment_intent: { client_secret: "pi_secret_x" } },
}) });
expect(fin.status).toBe(200);
expect(fin.body).toEqual({ subscription: "sub_new", status: "incomplete", client_secret: "pi_secret_x" });
expect(fin.kv("account/" + A + "/billing/customer")).toBe("cus_new");
expect(fin.kv("billing/customer/cus_new")).toBe(A);
expect(fin.kv("account/" + A + "/billing/subscription")).toBe("sub_new");
expect(fin.kv("account/" + A + "/billing/status")).toBe("incomplete");
expect(fin.kv("account/" + A + "/billing/item")).toBe("si_new");

// A Stripe-side failure in the chain relays as 502 and writes nothing.
const subFail = w.inbound({ method: "POST", path: "/v1/accounts/" + A + "/billing/subscribe",
  host: "app.rewindjs.com", body: j({ tier: "pro" }), session: { id: "al" } });
const failHop = subFail.fetch(/v1\/customers/).resolve({ status: 402, done: true,
  body: j({ error: { message: "card declined" } }) });
expect(failHop.status).toBe(502);
expect(failHop.body).toEqual({ error: "card declined", upstream: 402 });
expect(failHop.kv("account/" + A + "/billing/customer")).toBe(null);

// An account already subscribed cannot subscribe again (TEAM is active).
const dblSub = w.inbound({ method: "POST", path: "/v1/accounts/" + TEAM + "/billing/subscribe",
  host: "app.rewindjs.com", body: j({ tier: "enterprise" }), session: { id: "al" } });
expect(dblSub.status).toBe(409);

// A LINKED but inactive account subscribes in one hop (no customer create).
const wLapsed = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 8,
  kv: Object.assign({}, BASE, { ["account/" + TEAM + "/billing/status"]: "canceled" }) });
const reSub = wLapsed.inbound({ method: "POST", path: "/v1/accounts/" + TEAM + "/billing/subscribe",
  host: "app.rewindjs.com", body: j({ tier: "pro" }), session: { id: "al" } });
expect(reSub.disposition).toBe("held");
expect(reSub).toHaveFetched(/api\.stripe\.com\/v1\/subscriptions/);
// Resubscribe after a dead subscription: the key carries the DEAD sub's id,
// so it differs from the original attempt's key and Stripe creates a fresh
// subscription instead of replaying the corpse.
const reSubFx = reSub.effects.filter((e) => e.kind === "fetch" && /v1\/subscriptions/.test(e.url))[0];
expect(reSubFx.headers["Idempotency-Key"]).toBe("subinc-" + TEAM + "-pro-sub_456");

// Owner-only + tier validation.
expect(w.inbound({ method: "POST", path: "/v1/accounts/" + TEAM + "/billing/subscribe",
  host: "app.rewindjs.com", body: j({ tier: "pro" }), session: { id: "bo" } }).status).toBe(403);
expect(w.inbound({ method: "POST", path: "/v1/accounts/" + A + "/billing/subscribe",
  host: "app.rewindjs.com", body: j({ tier: "platinum" }), session: { id: "al" } }).status).toBe(400);

// Plan change is DURABLE: item-addressed, metadata.tier moves WITH the price
// (or the webhook would re-apply the old tier), idempotency-keyed.
const chg = w.inbound({ method: "POST", path: "/v1/accounts/" + TEAM + "/billing/change",
  host: "app.rewindjs.com", body: j({ tier: "enterprise" }), session: { id: "al" } });
expect(chg.status).toBe(200);
expect(chg.body).toEqual({ ok: true, pending: "enterprise" });
const chgMarker = chg.effects.filter((e) => e.kind === "write" && e.key.indexOf("_send/owed/") === 0)
  .map((e) => JSON.parse(e.value))[0];
expect(chgMarker.url).toBe("https://api.stripe.com/v1/subscriptions/sub_456");
expect(chgMarker.body.indexOf("items%5B0%5D%5Bid%5D=si_9") >= 0).toBe(true);
expect(chgMarker.body.indexOf("items%5B0%5D%5Bprice%5D=price_ent") >= 0).toBe(true);
expect(chgMarker.body.indexOf("metadata%5Btier%5D=enterprise") >= 0).toBe(true);
expect(chgMarker.headers["Idempotency-Key"]).toBe("subchg-" + TEAM + "-enterprise");

// Cancel is PERIOD-END (rove#313 decision 5): a durable update setting
// cancel_at_period_end, never a DELETE — the customer paid through the
// period, and the plan only walks to free when Stripe's deleted event lands
// at the boundary. Without a subscription it is a 409, not a Stripe call.
const cxl = w.inbound({ method: "POST", path: "/v1/accounts/" + TEAM + "/billing/cancel",
  host: "app.rewindjs.com", body: "{}", session: { id: "al" } });
expect(cxl.body).toEqual({ ok: true, cancels_at: 1790000000000 });
const cxlMarker = cxl.effects.filter((e) => e.kind === "write" && e.key.indexOf("_send/owed/") === 0)
  .map((e) => JSON.parse(e.value))[0];
expect(cxlMarker.method).toBe("POST");
expect(cxlMarker.url).toBe("https://api.stripe.com/v1/subscriptions/sub_456");
expect(cxlMarker.body).toBe("cancel_at_period_end=true");
expect(cxl.kv("account/" + TEAM + "/plan")).toBe("pro"); // plan moves at the boundary, not now

// The webhook's subscription.updated carries the flag → the row lands, the
// plan stays (status is still active until the boundary).
const flagEvt = signedPost(w, activeEvt({ id: "evt_flag",
  data: { object: { id: "sub_456", customer: "cus_123", status: "active",
                    cancel_at_period_end: true, current_period_end: T + 86400,
                    metadata: { tier: "pro" } } } }));
expect(flagEvt.kv("account/" + TEAM + "/billing/cancel_at_period_end")).toBe("1");
expect(flagEvt.kv("account/" + TEAM + "/plan")).toBe("pro");
expect(w.inbound({ method: "POST", path: "/v1/accounts/" + A + "/billing/cancel",
  host: "app.rewindjs.com", body: "{}", session: { id: "al" } }).status).toBe(409);
