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
}
