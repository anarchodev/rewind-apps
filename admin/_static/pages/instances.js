// Instances page. Two shapes, chosen by role:
//  • Operator (is_root): the full control surface — every tenant, create /
//    delete / assign-domain, cluster link. (Unchanged from the original.)
//  • Customer: account-aware — an account switcher (personal + teams), the
//    instances of the active account, a "New instance" form that provisions
//    into it, a "Members" link, and "New team". Domain/createInstance are
//    operator-only server-side, so they're absent here.

import { ApiError } from "../api.js";

export function render(root, ctx) {
  const who = ctx.who;
  if (!who) { ctx.goto("#/login"); return; }
  if (who.is_root) return renderOperator(root, ctx);
  return renderCustomer(root, ctx, who);
}

// ── Customer view ───────────────────────────────────────────────────
function renderCustomer(root, ctx, whoInit) {
  const { goto, api } = ctx;
  let who = whoInit;

  const wrap = document.createElement("div");
  wrap.className = "instances";
  root.appendChild(wrap);

  function accounts() { return who.accounts || []; }
  function activeAcct() {
    const accts = accounts();
    const wanted = api.getActiveAccount() || who.active_account;
    return accts.find((a) => a.aid === wanted)
      || accts.find((a) => a.is_personal) || accts[0];
  }

  async function refresh() {
    const w = await api.whoami();
    if (!w) { goto("#/login"); return; }
    who = w;
    paint();
  }

  function paint() {
    const acct = activeAcct();
    wrap.replaceChildren();
    wrap.innerHTML = `
      <header class="page-header">
        <h1>Instances</h1>
        <nav class="page-nav">
          <label class="acct-switch">Account
            <select class="acct-select"></select>
          </label>
          <button type="button" class="new-team">New team</button>
          <a class="members-link" href="#/team">Members</a>
          <button type="button" class="logout">Sign out</button>
        </nav>
      </header>
      <p class="error" hidden></p>
      <section class="forms">
        <form class="provision-form">
          <h2 class="provision-title"></h2>
          <label><span>Instance name</span>
            <input name="name" required pattern="[A-Za-z0-9_-]{1,64}" placeholder="e.g. acme"></label>
          <button type="submit">Create instance</button>
        </form>
      </section>
      <section>
        <h2 class="tenants-title"></h2>
        <table class="instance-table">
          <thead><tr><th>ID</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </section>
    `;
    const errorBox = wrap.querySelector(".error");
    const select = wrap.querySelector(".acct-select");
    const tbody = wrap.querySelector("tbody");
    const provForm = wrap.querySelector(".provision-form");
    const showError = (m) => { errorBox.textContent = m; errorBox.hidden = false; };
    const clearError = () => { errorBox.hidden = true; errorBox.textContent = ""; };

    // Account switcher
    for (const a of accounts()) {
      const opt = document.createElement("option");
      opt.value = a.aid;
      opt.textContent = (a.is_personal ? "Personal" : (a.name || a.aid.slice(0, 8)))
        + (a.role === "owner" ? " (owner)" : "");
      if (a.aid === acct.aid) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => { api.setActiveAccount(select.value); paint(); });

    wrap.querySelector(".members-link").setAttribute(
      "href", "#/team/" + encodeURIComponent(acct.aid));
    const acctLabel = acct.is_personal ? "your personal account" : `"${acct.name || acct.aid.slice(0, 8)}"`;
    wrap.querySelector(".provision-title").textContent = "New instance in " + acctLabel;
    wrap.querySelector(".tenants-title").textContent = "Instances in " + acctLabel;

    // Instance rows for the active account
    const ids = acct.instances || [];
    tbody.replaceChildren();
    if (ids.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 2;
      const em = document.createElement("em");
      em.textContent = "No instances yet.";
      td.appendChild(em);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const id of ids) {
      const tr = document.createElement("tr");
      const idCell = document.createElement("td");
      const link = document.createElement("a");
      link.href = "#/instance/" + encodeURIComponent(id);
      link.textContent = id;
      idCell.appendChild(link);
      tr.appendChild(idCell);
      const actions = document.createElement("td");
      actions.className = "actions";
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => onDelete(id));
      actions.appendChild(del);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }

    provForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      clearError();
      const name = String(new FormData(provForm).get("name") || "").trim();
      if (!name) return;
      try {
        await api.provisionInstance(name, acct.aid);
        await refresh();
      } catch (e) {
        if (e instanceof ApiError && e.status === 403)
          showError("Instance limit reached for this account (free plan: 1).");
        else if (e instanceof ApiError && e.status === 409)
          showError("That name isn't available — try another.");
        else showError(`Create failed: ${e.message}`);
      }
    });

    wrap.querySelector(".new-team").addEventListener("click", async () => {
      const name = prompt("Name your new team");
      if (!name) return;
      clearError();
      try {
        const res = await api.createAccount(name.trim());
        api.setActiveAccount(res.aid);
        goto("#/team/" + encodeURIComponent(res.aid)); // land on it to invite
      } catch (e) {
        showError(e instanceof ApiError && e.status === 403
          ? "Team limit reached for your account."
          : `Create team failed: ${e.message}`);
      }
    });

    async function onDelete(id) {
      if (!confirm(`Delete instance "${id}"? This cannot be undone via the UI.`)) return;
      clearError();
      try { await api.deleteInstance(id); await refresh(); }
      catch (e) { showError(`Delete failed: ${e.message}`); }
    }

    wrap.querySelector(".logout").addEventListener("click", () => {
      window.location.assign("/_rp/logout?return_to=" + encodeURIComponent("/#/login"));
    });
  }

  paint();
}

// ── Operator view (unchanged) ───────────────────────────────────────
function renderOperator(root, { goto, api }) {
  const wrap = document.createElement("div");
  wrap.className = "instances";
  wrap.innerHTML = `
    <header class="page-header">
      <h1>Instances</h1>
      <nav class="page-nav">
        <a class="cluster-link" href="#/cluster">Cluster</a>
        <button type="button" class="logout">Sign out</button>
      </nav>
    </header>
    <p class="error" hidden></p>

    <section class="forms">
      <form class="create-form">
        <h2>Create instance</h2>
        <label>
          <span>Instance ID</span>
          <input name="id" required pattern="[A-Za-z0-9_-]{1,64}" placeholder="e.g. acme">
        </label>
        <button type="submit">Create</button>
      </form>

      <form class="assign-form">
        <h2>Assign domain</h2>
        <label>
          <span>Host</span>
          <input name="host" required placeholder="acme.example.com">
        </label>
        <label>
          <span>Instance</span>
          <select name="instance_id" required></select>
        </label>
        <button type="submit">Assign</button>
      </form>
    </section>

    <section>
      <h2>Tenants</h2>
      <table class="instance-table">
        <thead>
          <tr><th>ID</th><th>Domains</th><th></th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>
  `;

  const errorBox = wrap.querySelector(".error");
  const tbody = wrap.querySelector(".instance-table tbody");
  const selectInstance = wrap.querySelector("select[name=instance_id]");
  const createForm = wrap.querySelector(".create-form");
  const assignForm = wrap.querySelector(".assign-form");
  const logoutBtn = wrap.querySelector(".logout");

  function showError(msg) { errorBox.textContent = msg; errorBox.hidden = false; }
  function clearError() { errorBox.hidden = true; errorBox.textContent = ""; }

  async function reload() {
    clearError();
    let instancesRes, domainsRes;
    try {
      [instancesRes, domainsRes] = await Promise.all([
        api.listInstances(),
        api.listDomains(),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { goto("#/login"); return; }
      showError(`Load failed: ${err.message}`);
      return;
    }

    const ids = (instancesRes.instances ?? []).map((i) => i.id);
    const domainsByInstance = new Map();
    for (const d of domainsRes.domains ?? []) {
      if (!domainsByInstance.has(d.instance_id)) domainsByInstance.set(d.instance_id, []);
      domainsByInstance.get(d.instance_id).push(d.host);
    }

    tbody.replaceChildren();
    for (const id of ids) {
      const tr = document.createElement("tr");

      const idCell = document.createElement("td");
      const idLink = document.createElement("a");
      idLink.href = `#/instance/${encodeURIComponent(id)}`;
      idLink.textContent = id;
      idCell.appendChild(idLink);
      tr.appendChild(idCell);

      const domainCell = document.createElement("td");
      const domains = domainsByInstance.get(id) ?? [];
      if (domains.length === 0) {
        const em = document.createElement("em");
        em.textContent = "(none)";
        domainCell.appendChild(em);
      } else {
        domainCell.textContent = domains.join(", ");
      }
      tr.appendChild(domainCell);

      const actionCell = document.createElement("td");
      actionCell.className = "actions";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => onDelete(id));
      actionCell.appendChild(delBtn);
      tr.appendChild(actionCell);

      tbody.appendChild(tr);
    }

    selectInstance.replaceChildren();
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      selectInstance.appendChild(opt);
    }
  }

  async function onCreate(ev) {
    ev.preventDefault();
    clearError();
    const data = new FormData(createForm);
    const id = String(data.get("id") ?? "").trim();
    if (!id) return;
    try {
      await api.createInstance(id);
      createForm.reset();
      await reload();
    } catch (err) {
      showError(`Create failed: ${err.message}`);
    }
  }

  async function onAssign(ev) {
    ev.preventDefault();
    clearError();
    const data = new FormData(assignForm);
    const host = String(data.get("host") ?? "").trim();
    const instance_id = String(data.get("instance_id") ?? "").trim();
    if (!host || !instance_id) return;
    try {
      await api.assignDomain(host, instance_id);
      assignForm.reset();
      await reload();
    } catch (err) {
      showError(`Assign failed: ${err.message}`);
    }
  }

  async function onDelete(id) {
    if (!confirm(`Delete instance "${id}"? This cannot be undone via the UI.`)) return;
    clearError();
    try {
      await api.deleteInstance(id);
      await reload();
    } catch (err) {
      showError(`Delete failed: ${err.message}`);
    }
  }

  createForm.addEventListener("submit", onCreate);
  assignForm.addEventListener("submit", onAssign);
  logoutBtn.addEventListener("click", () => {
    window.location.assign("/_rp/logout?return_to=" + encodeURIComponent("/#/login"));
  });

  root.appendChild(wrap);
  reload();
}
