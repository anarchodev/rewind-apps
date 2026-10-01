// The billing page's invoice helpers, under node (the handler engine never
// loads `_static/`). Run: `node admin/_tests/_billing_view.node.mjs`.
import assert from "node:assert/strict";

globalThis.window = { location: { origin: "https://app.rewindjs.com" }, localStorage: { removeItem() {} } };
const { invoiceState, fmtMoney } = await import("../_static/pages/billing.js");

const NOW = Date.UTC(2026, 7, 15);
const DAY = 86400000;
const st = (o) => invoiceState(Object.assign({ amount_remaining: 0, attempted: false, due_ms: null }, o), NOW);

assert.equal(st({ status: "paid" }).label, "Paid");
assert.equal(st({ status: "void" }).label, "Void");
// Open and not yet late: due in the future, or a fresh invoice not yet charged.
assert.match(st({ status: "open", due_ms: NOW + 3 * DAY, amount_remaining: 2500 }).label, /^Due /);
assert.equal(st({ status: "open", amount_remaining: 2500 }).label, "Open");
assert.equal(st({ status: "open", amount_remaining: 2500 }).payable, true);
// Late either way: past the due date, or a charge failed and money is owed.
assert.equal(st({ status: "open", due_ms: NOW - DAY, amount_remaining: 2500 }).label, "Past due");
assert.equal(st({ status: "open", attempted: true, amount_remaining: 2500 }).label, "Past due");
assert.ok(st({ status: "open", attempted: true, amount_remaining: 2500 }).icon, "a late invoice is marked by more than color");
assert.equal(st({ status: "uncollectible" }).label, "Uncollectible");

// Minor units by the currency's own fraction digits.
assert.match(fmtMoney(2500, "usd"), /25\.00/);
assert.match(fmtMoney(500, "jpy"), /500/);
assert.doesNotMatch(fmtMoney(500, "jpy"), /5\.00/);
assert.equal(fmtMoney(null, "usd"), "—");

console.log("ok — invoice status words and amounts");
