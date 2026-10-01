// Invoice history (rove#316): the owner-only list of an account's Stripe
// invoices, paged with Stripe's own cursor. Stripe is never reached offline —
// every list call is a held fetch resolved here with a recorded-shape body.
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
const sess = (sub, is_root) => j({ sub, is_root, exp: FAR });

const alice = "alice@x.com", bob = "bob@x.com", carol = "carol@x.com";
const A = uh(alice), B = uh(bob);
const TEAM = "team1";

// team1 (pro, a Stripe customer): alice owns it, bob is a member. alice's
// personal account has never been billed.
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
  ["account/" + TEAM + "/billing/customer"]: "cus_123",
  ["billing/customer/cus_123"]: TEAM,
  ["account/" + A + "/members/" + A]: "owner",
  ["user/" + A + "/accounts/" + A]: "owner",
  stripe_key: "sk_test_x", stripe_pk: "pk_test_x",
};
const s = scenario({ admin: true, now: "2026-08-15T00:00:00Z", seed: 3, kv: BASE });
const list = (aid, sid, qs) => s.inbound({ method: "GET",
  // The query rides the path, as on the wire; the engine splits it onto
  // `request.query`.
  path: "/v1/accounts/" + aid + "/billing/invoices" + (qs ? "?" + qs : ""),
  host: "app.rewindjs.com", session: sid ? { id: sid } : undefined });

const inv = (id, o) => Object.assign({
  id, object: "invoice", customer: "cus_123", number: "RW-" + id.slice(3), currency: "usd",
  status: "paid", total: 2500, tax: 0, amount_due: 2500, amount_paid: 2500, amount_remaining: 0,
  created: 1785000000, period_start: 1782400000, period_end: 1785000000, due_date: null,
  attempted: true, hosted_invoice_url: "https://invoice.stripe.com/i/" + id,
  invoice_pdf: "https://pay.stripe.com/invoice/" + id + "/pdf",
}, o || {});
const page = (data, has_more) => ({ status: 200, done: true,
  body: j({ object: "list", data, has_more: !!has_more, url: "/v1/invoices" }) });

// ── the owner's first page ───────────────────────────────────────────────
const first = list(TEAM, "al");
expect(first.disposition).toBe("held");
// Keyed by the account's OWN customer, from our rows; Stripe's page size.
expect(first).toHaveFetched(/api\.stripe\.com\/v1\/invoices\?customer=cus_123&limit=12$/);

const got = first.fetch(/stripe/).resolve(page([
  inv("in_3", { status: "open", amount_paid: 0, amount_remaining: 2500, due_date: 1786000000, attempted: true }),
  inv("in_draft", { status: "draft", number: null }),          // a working copy — never shown
  inv("in_alien", { customer: "cus_other" }),                  // not this account's — never shown
  inv("in_2"),
  inv("in_1", { status: "void", amount_paid: 0 }),
], true));
expect(got.status).toBe(200);
expect(got.body.invoices.map((x) => x.id)).toEqual(["in_3", "in_2", "in_1"]);
// The cursor is Stripe's last row, so paging advances even past filtered rows.
expect(got.body.has_more).toBe(true);
expect(got.body.next_cursor).toBe("in_1");
// Seconds → ms, minor units kept, the links the page needs; nothing else.
expect(got.body.invoices[0]).toEqual({
  id: "in_3", number: "RW-3", status: "open", currency: "usd",
  total: 2500, tax: 0, amount_due: 2500, amount_paid: 0, amount_remaining: 2500,
  created_ms: 1785000000000, period_start_ms: 1782400000000, period_end_ms: 1785000000000,
  due_ms: 1786000000000, attempted: true,
  hosted_invoice_url: "https://invoice.stripe.com/i/in_3",
  invoice_pdf: "https://pay.stripe.com/invoice/in_3/pdf",
});

// ── the next page rides Stripe's cursor ──────────────────────────────────
const second = list(TEAM, "al", "starting_after=in_1");
expect(second).toHaveFetched(/customer=cus_123&limit=12&starting_after=in_1$/);
const tail = second.fetch(/stripe/).resolve(page([inv("in_0")], false));
expect(tail.body.has_more).toBe(false);
expect(tail.body.next_cursor).toBe(null);
// A cursor is an invoice id, nothing else — no smuggling query params through it.
const bad = list(TEAM, "al", "starting_after=" + encodeURIComponent("in_1&customer=cus_other"));
expect(bad.status).toBe(400);
expect(bad.effects.some((e) => e.kind === "fetch")).toBe(false);

// ── empty states ─────────────────────────────────────────────────────────
// Never billed → empty, and Stripe is not asked.
const none = list(A, "al");
expect(none.status).toBe(200);
expect(none.body).toEqual({ invoices: [], has_more: false, next_cursor: null });
expect(none.effects.some((e) => e.kind === "fetch")).toBe(false);
// A customer with no invoices yet.
const zero = list(TEAM, "al").fetch(/stripe/).resolve(page([], false));
expect(zero.body.invoices).toEqual([]);

// ── Stripe failing is ours to absorb, not to relay ───────────────────────
const down = list(TEAM, "al").fetch(/stripe/).resolve({ status: 401, done: true,
  body: j({ error: { message: "Invalid API Key provided: sk_test_x" } }) });
expect(down.status).toBe(502);
expect(j(down.body).includes("sk_test")).toBe(false);

// ── authz: invoices carry payer details, so owners only ──────────────────
expect(list(TEAM, "bo").status).toBe(403);   // a member sees the plan, not the invoices
expect(list(TEAM, "ca").status).toBe(403);   // a stranger
expect(list(TEAM, null).status).toBe(401);
expect(list(TEAM, "bo").effects.some((e) => e.kind === "fetch")).toBe(false);
