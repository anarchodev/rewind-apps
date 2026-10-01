// Billing page (#/billing/:aid?) — embedded Stripe Payment Element (rove#310).
//
// CARD DATA NEVER TOUCHES REWIND. The card inputs live inside Stripe's own
// iframes (the Payment Element); confirmation is a browser→Stripe call
// (`stripe.confirmPayment`). The only bodies this page ever sends to our
// backend are `{"tier": "..."}` JSON — so no card field value can reach a
// request body, and therefore none can reach a tape or a replay log. Keep it
// that way: never add a form field of our own to this page that could hold a
// card number, and never proxy a Stripe call through the backend that could
// carry one.
//
// The subscribe flow is Stripe's `default_incomplete` mode: our backend
// creates an incomplete subscription and relays the payment intent's
// client_secret; Elements mounts on that secret; the browser confirms (SCA /
// 3DS happens in-page via Stripe); the webhook (rove#309/#311) flips the
// subscription active and pushes the plan. The UI POLLS billing state after
// confirmation rather than trusting the confirm result — the plan is only
// real once the webhook landed.

import { ApiError } from "../api.js";

const TIERS = [
  { id: "pro", label: "Pro" },
  { id: "enterprise", label: "Enterprise" },
];
const ACTIVE = { active: true, trialing: true, past_due: true };

// Stripe.js may only be loaded from js.stripe.com (their requirement — it is
// what keeps the card iframes under their origin). Loaded on demand, once.
let stripeJsPromise = null;
function loadStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (stripeJsPromise) return stripeJsPromise;
  stripeJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error("Stripe.js failed to load")));
    s.onerror = () => reject(new Error("Stripe.js failed to load"));
    document.head.appendChild(s);
  });
  return stripeJsPromise;
}

export function render(root, { goto, api, params, who }) {
  if (!who) { goto("#/login"); return; }
  const accounts = who.accounts || [];
  const wanted = params.aid || api.getActiveAccount() || who.active_account;
  const acct = accounts.find((a) => a.aid === wanted)
    || accounts.find((a) => a.is_personal) || accounts[0];
  if (!acct) { root.textContent = "No account."; return; }
  const aid = acct.aid;
  const amOwner = acct.role === "owner";

  const wrap = document.createElement("div");
  wrap.className = "instances billing";
  wrap.innerHTML = `
    <header class="page-header">
      <h1 class="billing-title"></h1>
      <nav class="page-nav">
        <a href="#/instances">Instances</a>
        <a href="#/team/${encodeURIComponent(aid)}">Members</a>
        <button type="button" class="logout">Sign out</button>
      </nav>
    </header>
    <p class="error" hidden></p>
    <section class="current">
      <h2>Current plan</h2>
      <p class="plan-line"></p>
      <p class="renewal-line" hidden></p>
    </section>
    <section class="tiers"></section>
    <section class="invoices">
      <h2>Invoices</h2>
      <div class="invoice-body"></div>
      <button type="button" class="invoice-more" hidden>Load more</button>
    </section>
    <section class="payment" hidden>
      <h2>Payment details</h2>
      <div class="payment-element"></div>
      <button type="button" class="pay">Confirm</button>
      <button type="button" class="pay-cancel">Back</button>
      <p class="pay-note" hidden></p>
    </section>
  `;
  root.replaceChildren(wrap);

  const errEl = wrap.querySelector(".error");
  const note = wrap.querySelector(".pay-note");
  const paySection = wrap.querySelector(".payment");
  const tiersEl = wrap.querySelector(".tiers");
  wrap.querySelector(".billing-title").textContent =
    "Billing — " + (acct.name || (acct.is_personal ? "Personal" : aid));
  wrap.querySelector(".logout").addEventListener("click", () => {
    window.location.assign("/_rp/logout?return_to=" + encodeURIComponent("/#/login"));
  });

  const showError = (e) => {
    errEl.hidden = false;
    errEl.textContent = e instanceof ApiError
      ? ((e.body && e.body.error) || (e.status + " " + e.message)) : String(e.message || e);
  };

  let billing = null;

  function renderState() {
    const b = billing;
    const live = b.status !== null && ACTIVE[b.status];
    // The parenthetical qualifies a LIVE subscription ("pro (past_due)"
    // during grace). A dead one's residual status row (canceled,
    // incomplete_expired) would otherwise leak into what reads as the
    // current plan — "free (incomplete_expired)".
    wrap.querySelector(".plan-line").textContent =
      b.plan + (live ? " (" + b.status + ")" : "");
    const renew = wrap.querySelector(".renewal-line");
    if (live && b.period_end) {
      renew.hidden = false;
      renew.textContent = (b.cancel_at_period_end ? "Cancels " : "Renews ")
        + new Date(b.period_end).toLocaleDateString();
    } else renew.hidden = true;

    tiersEl.replaceChildren();
    if (!amOwner) {
      const p = document.createElement("p");
      p.textContent = "Only an account owner can change the plan.";
      tiersEl.appendChild(p);
      return;
    }
    for (const t of TIERS) {
      const card = document.createElement("div");
      card.className = "tier-card";
      const btn = document.createElement("button");
      if (live && b.plan === t.id) {
        btn.textContent = t.label + " — current";
        btn.disabled = true;
      } else if (live) {
        btn.textContent = "Switch to " + t.label;
        btn.addEventListener("click", () => doChange(t.id, btn));
      } else {
        btn.textContent = "Subscribe to " + t.label;
        btn.addEventListener("click", () => doSubscribe(t.id, btn));
      }
      card.appendChild(btn);
      tiersEl.appendChild(card);
    }
    if (live && !b.cancel_at_period_end) {
      const cxl = document.createElement("button");
      cxl.className = "cancel-sub";
      cxl.textContent = "Cancel subscription";
      cxl.addEventListener("click", () => doCancel(cxl));
      tiersEl.appendChild(cxl);
    }
  }

  // The webhook is the source of truth (rove#311): after any mutation, poll
  // billing state until it reflects, instead of trusting our own 200.
  async function pollUntil(pred, ms = 30000) {
    const until = Date.now() + ms;
    for (;;) {
      billing = await api.getBilling(aid);
      if (pred(billing) || Date.now() > until) return pred(billing);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function doSubscribe(tier, btn) {
    errEl.hidden = true;
    btn.disabled = true;
    try {
      const [{ publishable_key }, sub] = await Promise.all([
        api.billingConfig(), api.subscribeBilling(aid, tier)]);
      const Stripe = await loadStripeJs();
      const stripe = Stripe(publishable_key);
      const elements = stripe.elements({ clientSecret: sub.client_secret });
      elements.create("payment").mount(wrap.querySelector(".payment-element"));
      paySection.hidden = false;
      wrap.querySelector(".pay-cancel").onclick = () => { paySection.hidden = true; renderState(); };
      wrap.querySelector(".pay").onclick = async () => {
        note.hidden = true;
        try {
          // SCA / 3DS runs in-page; redirect only if the method demands it.
          const { error } = await stripe.confirmPayment({
            elements, confirmParams: { return_url: location.href }, redirect: "if_required",
          });
          if (error) { note.hidden = false; note.textContent = error.message; return; }
          note.hidden = false;
          note.textContent = "Payment confirmed — activating…";
          const ok = await pollUntil((b) => b.status === "active" && b.plan === tier);
          paySection.hidden = true;
          if (!ok) showError(new Error("activation is taking longer than expected — refresh shortly"));
          renderState();
        } catch (e) { showError(e); }
      };
    } catch (e) { showError(e); btn.disabled = false; }
  }

  async function doChange(tier, btn) {
    errEl.hidden = true;
    btn.disabled = true;
    try {
      await api.changeBilling(aid, tier);
      const ok = await pollUntil((b) => b.plan === tier);
      if (!ok) showError(new Error("plan change is taking longer than expected — refresh shortly"));
      renderState();
    } catch (e) { showError(e); btn.disabled = false; }
  }

  async function doCancel(btn) {
    if (!window.confirm("Cancel the subscription? Service continues until the end of the paid period, then the account returns to the free plan.")) return;
    errEl.hidden = true;
    btn.disabled = true;
    try {
      await api.cancelBilling(aid);
      // Period-end cancel (rove#313): the plan does not move now — the flag
      // does, via the webhook's subscription.updated. Poll for that.
      const ok = await pollUntil((b) => b.cancel_at_period_end === true);
      if (!ok) showError(new Error("cancellation is taking longer than expected — refresh shortly"));
      renderState();
    } catch (e) { showError(e); btn.disabled = false; }
  }

  api.getBilling(aid).then((b) => { billing = b; renderState(); }).catch(showError);

  // ── Invoice history ────────────────────────────────────────────────
  // Payment is embedded, so there is no Stripe portal: this is where an
  // owner sees what was charged, gets the PDF, and pays an open invoice.
  // Members see the plan above but not invoices (they carry payer details).
  const invBody = wrap.querySelector(".invoice-body");
  const moreBtn = wrap.querySelector(".invoice-more");
  let invTable = null, cursor = null;

  async function loadInvoices(next = false) {
    if (!amOwner) {
      invBody.innerHTML = `<p class="muted">Only an account owner can see invoices.</p>`;
      return;
    }
    moreBtn.disabled = true;
    try {
      const page = await api.listInvoices(aid, next ? cursor : null);
      if (!next) { invBody.replaceChildren(); invTable = null; }
      if (!invTable && page.invoices.length === 0) {
        invBody.innerHTML = `<p class="muted">No invoices yet. Your first one appears here when a paid plan starts.</p>`;
      } else {
        if (!invTable) {
          invTable = document.createElement("table");
          invTable.className = "instance-table invoice-table";
          invTable.innerHTML = `<thead><tr><th>Date</th><th>Invoice</th><th>Period</th>
            <th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody></tbody>`;
          invBody.appendChild(invTable);
        }
        const tb = invTable.querySelector("tbody");
        for (const inv of page.invoices) tb.appendChild(invoiceRow(inv));
      }
      cursor = page.next_cursor;
      moreBtn.hidden = !page.has_more || !cursor;
    } catch (e) {
      invBody.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Invoices could not be loaded. " +
        ((e instanceof ApiError && e.body && e.body.error) || "Try again shortly.");
      invBody.appendChild(p);
    } finally {
      moreBtn.disabled = false;
    }
  }
  moreBtn.addEventListener("click", () => loadInvoices(true));
  loadInvoices();
}

/// One invoice as a table row. The state is a word (with an icon when it
/// needs action), never color alone; an unpaid invoice links to Stripe's own
/// payment page for it.
function invoiceRow(inv) {
  const tr = document.createElement("tr");
  const st = invoiceState(inv, Date.now());
  const td = (text, cls) => {
    const c = document.createElement("td");
    if (cls) c.className = cls;
    c.textContent = text;
    tr.appendChild(c);
    return c;
  };
  td(inv.created_ms ? fmtDate(inv.created_ms) : "—");
  td(inv.number || inv.id);
  td(inv.period_start_ms && inv.period_end_ms && inv.period_end_ms > inv.period_start_ms
    ? fmtDate(inv.period_start_ms) + " – " + fmtDate(inv.period_end_ms) : "—");
  const amt = td(fmtMoney(inv.total, inv.currency), "num");
  if (typeof inv.tax === "number" && inv.tax > 0) amt.title = "incl. tax " + fmtMoney(inv.tax, inv.currency);
  const sc = td("", "inv-status " + st.cls);
  if (st.icon) {
    const i = document.createElement("span");
    i.className = "inv-icon";
    i.setAttribute("aria-hidden", "true");
    i.textContent = st.icon + " ";
    sc.appendChild(i);
  }
  sc.appendChild(document.createTextNode(st.label));
  const links = td("", "actions");
  const link = (href, text) => {
    if (!href) return;
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text;
    if (links.childElementCount) links.appendChild(document.createTextNode(" · "));
    links.appendChild(a);
  };
  link(inv.hosted_invoice_url, st.payable ? "Pay" : "View");
  link(inv.invoice_pdf, "PDF");
  return tr;
}

/// Stripe's invoice status in the customer's words. `open` splits on whether
/// payment is already late: past its due date, or a charge was attempted and
/// money is still owed.
export function invoiceState(inv, nowMs) {
  switch (inv.status) {
    case "paid": return { label: "Paid", cls: "paid" };
    case "void": return { label: "Void", cls: "void" };
    case "uncollectible": return { label: "Uncollectible", cls: "late", icon: "■" };
    case "open": {
      const late = (inv.due_ms && inv.due_ms < nowMs) || (inv.attempted && inv.amount_remaining > 0);
      return late
        ? { label: "Past due", cls: "late", icon: "▲", payable: true }
        : { label: inv.due_ms ? "Due " + fmtDate(inv.due_ms) : "Open", cls: "open", payable: true };
    }
    default: return { label: inv.status || "—", cls: "" };
  }
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/// Stripe amounts are in the currency's minor unit; the currency's own
/// fraction digits decide the divisor (JPY has none, USD two).
export function fmtMoney(minor, currency) {
  if (typeof minor !== "number" || !currency) return "—";
  const cur = currency.toUpperCase();
  try {
    const f = new Intl.NumberFormat(undefined, { style: "currency", currency: cur });
    const digits = f.resolvedOptions().maximumFractionDigits;
    return f.format(minor / Math.pow(10, digits));
  } catch (_) {
    return (minor / 100).toFixed(2) + " " + cur;
  }
}
