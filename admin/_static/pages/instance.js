// Per-instance dashboard: logs, KV, and the code editor.

import { ApiError } from "../api.js";

const TABS = [
  { id: "logs", label: "Logs" },
  { id: "kv", label: "KV" },
  { id: "code", label: "Code" },
  { id: "settings", label: "Settings" },
];

export function render(root, { goto, api, params }) {
  const instanceId = params.id;

  const wrap = document.createElement("div");
  wrap.className = "instance";
  wrap.innerHTML = `
    <header class="page-header">
      <div>
        <a class="back-link" href="#/instances">← Instances</a>
        <h1>${escapeHtml(instanceId)}</h1>
        <a class="instance-url" hidden></a>
      </div>
      <button type="button" class="logout">Sign out</button>
    </header>
    <p class="error" hidden></p>

    <nav class="tabs"></nav>
    <section class="tab-body"></section>
  `;

  const errorBox = wrap.querySelector(".error");
  const tabsNav = wrap.querySelector(".tabs");
  const tabBody = wrap.querySelector(".tab-body");
  const logoutBtn = wrap.querySelector(".logout");

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  const tabButtons = new Map();
  let activeTab = "logs";
  let activeTeardown = null;

  function selectTab(tabId) {
    if (activeTab === tabId && tabBody.childElementCount > 0) return;
    activeTab = tabId;
    for (const [id, btn] of tabButtons.entries()) {
      btn.classList.toggle("active", id === tabId);
    }
    if (typeof activeTeardown === "function") {
      try { activeTeardown(); } catch {}
    }
    activeTeardown = null;
    tabBody.replaceChildren();
    clearError();

    const ctx = { instanceId, api, showError, clearError };
    if (tabId === "logs") activeTeardown = renderLogs(tabBody, ctx) || null;
    else if (tabId === "kv") activeTeardown = renderKv(tabBody, ctx) || null;
    else if (tabId === "code") activeTeardown = renderCode(tabBody, ctx) || null;
    else if (tabId === "settings") activeTeardown = renderSettings(tabBody, { ...ctx, goto }) || null;
  }

  for (const t of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.textContent = t.label;
    btn.addEventListener("click", () => selectTab(t.id));
    tabsNav.appendChild(btn);
    tabButtons.set(t.id, btn);
  }

  // Full RP-Initiated logout: a whole-page navigation to /_rp/logout, which
  // clears the RP session AND ends the IdP SSO session (an XHR clear alone
  // leaves the IdP session live → the login interstitial silently re-logs in).
  logoutBtn.addEventListener("click", () => {
    window.location.assign("/_rp/logout?return_to=" + encodeURIComponent("/#/login"));
  });

  // The instance's public URL, as the control plane reported it at provision
  // time. Fetched rather than derived: the dashboard holds no copy of the
  // platform's zone, and an instance provisioned before that was recorded (or
  // on a platform with no wildcard zone) genuinely has no URL to show.
  const urlLink = wrap.querySelector(".instance-url");
  api.getInstance(instanceId).then((inst) => {
    if (!inst || !inst.host) return;
    urlLink.href = `https://${inst.host}`;
    urlLink.target = "_blank";
    urlLink.rel = "noopener";
    urlLink.textContent = `${inst.host} ↗`;
    urlLink.hidden = false;
  }).catch(() => { /* the tabs carry the real work; a missing link is cosmetic */ });

  root.appendChild(wrap);
  selectTab("logs");

  return () => {
    if (typeof activeTeardown === "function") {
      try { activeTeardown(); } catch {}
    }
    activeTeardown = null;
  };
}

// ── Settings panel ─────────────────────────────────────────────────

/// Instance settings — currently just the irreversible part. Deletion lives on
/// its own tab rather than beside the routine controls: a destructive action
/// should take a deliberate navigation to reach, not sit one mis-click away
/// from Refresh.
function renderSettings(root, { instanceId, api, showError, clearError, goto }) {
  const el = document.createElement("div");
  el.className = "settings-panel";
  el.innerHTML = `
    <section class="export-section">
      <h3>Export this instance's data</h3>
      <p>Everything you'd need to leave or to keep a copy: the KV store as
        JSON-lines parts, and the deployed code bundle (the deployment
        manifest plus a link per source file and static asset). Parts are
        content-addressed; download links expire after 5 minutes — request
        them again to re-mint.</p>
      <p class="export-status" hidden></p>
      <button type="button" class="export-start">Export data</button>
      <button type="button" class="export-links" hidden>Get download links</button>
      <ul class="export-list" hidden></ul>
    </section>
    <section class="danger-zone">
      <h3>Delete this instance</h3>
      <p>Deletes <strong>${escapeHtml(instanceId)}</strong> permanently: its
        handlers, its KV data, and its request history. It stops answering
        immediately and the name becomes available to anyone again.
        Exports are destroyed with the instance — download first (above).
        <strong>This cannot be undone.</strong></p>
      <form class="delete-form">
        <label>
          <span>Type <code>${escapeHtml(instanceId)}</code> to confirm</span>
          <input type="text" name="confirm" autocomplete="off" spellcheck="false"
                 placeholder="${escapeHtml(instanceId)}">
        </label>
        <button type="submit" class="danger" disabled>Delete instance</button>
      </form>
    </section>
  `;
  root.appendChild(el);

  const form = el.querySelector(".delete-form");
  const input = form.querySelector("input[name=confirm]");
  const btn = form.querySelector("button");

  // The button stays inert until the typed name matches exactly — the guard is
  // the server's, but there is no reason to let the click happen at all.
  input.addEventListener("input", () => {
    btn.disabled = input.value !== instanceId;
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (input.value !== instanceId) return;
    clearError();
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await api.deleteInstance(instanceId, input.value);
      goto("#/instances");
    } catch (e) {
      // The control plane's own words: a partial teardown asks for a retry,
      // and saying so is more useful than a generic failure.
      const reason = (e instanceof ApiError && e.body && typeof e.body.error === "string")
        ? e.body.error
        : (e && e.message) || "unknown error";
      showError(`Delete failed: ${reason}`);
      btn.disabled = false;
      btn.textContent = "Delete instance";
    }
  });

  // ── Export (rove#340) ─────────────────────────────────────────────
  const expStatus = el.querySelector(".export-status");
  const expStart = el.querySelector(".export-start");
  const expLinks = el.querySelector(".export-links");
  const expList = el.querySelector(".export-list");
  let pollTimer = null;
  let currentExport = null;

  function setStatus(text) {
    expStatus.textContent = text;
    expStatus.hidden = !text;
  }

  function stopPoll() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  }

  function showState(st) {
    if (!st) return;
    currentExport = st.id;
    if (st.state === "running") {
      setStatus(`Export running — ${st.entries} entries, `
        + `${st.bytes} bytes, ${st.parts} part(s) so far…`);
      expStart.disabled = true;
      expLinks.hidden = true;
    } else if (st.state === "done") {
      stopPoll();
      const when = st.finished_at ? new Date(st.finished_at).toLocaleString() : "";
      setStatus(`Last export: ${st.entries} entries, ${st.bytes} bytes in `
        + `${st.parts} part(s)${st.bundle ? " + code bundle" : ""}`
        + (when ? ` — finished ${when}` : ""));
      expStart.disabled = false;
      expStart.textContent = "Export again";
      expLinks.hidden = false;
    } else if (st.state === "failed") {
      stopPoll();
      setStatus(`Export failed: ${st.error || "unknown error"}`);
      expStart.disabled = false;
    }
  }

  async function poll() {
    if (!currentExport) return;
    try { showState(await api.getExport(instanceId, currentExport)); }
    catch (_) { /* transient — next tick retries */ }
  }

  // Adopt the newest prior export so a refresh shows where things stand.
  (async () => {
    try {
      const res = await api.listExports(instanceId);
      const newest = (res.exports || [])[0];
      if (newest) {
        showState(newest);
        if (newest.state === "running") pollTimer = setInterval(poll, 3000);
      }
    } catch (_) { /* absent list is just "no exports yet" */ }
  })();

  expStart.addEventListener("click", async () => {
    clearError();
    expStart.disabled = true;
    expList.hidden = true;
    try {
      const res = await api.startExport(instanceId);
      currentExport = res.id;
      setStatus("Export started…");
      stopPoll();
      pollTimer = setInterval(poll, 3000);
    } catch (e) {
      expStart.disabled = false;
      showError(e instanceof ApiError && e.status === 409
        ? "An export is already running — it will appear here when done."
        : `Export failed to start: ${e.message}`);
    }
  });

  expLinks.addEventListener("click", async () => {
    clearError();
    try {
      const res = await api.getExportLinks(instanceId, currentExport);
      expList.replaceChildren();
      for (const l of res.links || []) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = l.url;
        a.textContent = (l.kind === "bundle" ? "code bundle manifest" : "kv part")
          + " — " + l.hash.slice(0, 12) + "… (" + l.bytes + " bytes)";
        a.target = "_blank";
        a.rel = "noopener";
        li.appendChild(a);
        expList.appendChild(li);
      }
      const note = document.createElement("li");
      note.textContent = "Links expire in " + Math.round((res.ttl_seconds || 300) / 60)
        + " min — click “Get download links” again to re-mint. "
        + "Concatenate kv parts in order to rebuild the KV JSONL.";
      expList.appendChild(note);
      expList.hidden = false;
    } catch (e) {
      showError(`Links failed: ${e.message}`);
    }
  });

  return () => { stopPoll(); };
}

// ── Logs panel ─────────────────────────────────────────────────────

function renderLogs(root, { instanceId, api, showError, clearError }) {
  const el = document.createElement("div");
  el.className = "logs-panel";
  el.innerHTML = `
    <div class="toolbar">
      <button type="button" class="refresh">Refresh</button>
      <select class="f-status" title="Filter by response status — Failures selects every request whose outcome was not ok (faults, errors, refusals), whatever its status">
        <option value="">Status: all</option>
        <option value="2xx">2xx</option>
        <option value="3xx">3xx</option>
        <option value="4xx">4xx</option>
        <option value="5xx">5xx</option>
        <option value="failures">Failures</option>
      </select>
      <select class="f-method" title="Filter by request method">
        <option value="">Method: all</option>
        <option>GET</option>
        <option>POST</option>
        <option>PUT</option>
        <option>PATCH</option>
        <option>DELETE</option>
        <option>HEAD</option>
        <option>OPTIONS</option>
      </select>
      <select class="f-activation" title="Filter by activation kind — what woke the handler">
        <option value="">Kind: all</option>
        <option>inbound</option>
        <option>inbound_headers</option>
        <option>inbound_chunk</option>
        <option>ws_message</option>
        <option>send_callback</option>
        <option>fetch_chunk</option>
        <option>wake_batch</option>
        <option>durable_wake</option>
        <option>timer</option>
        <option>subscription_fire</option>
        <option>disconnect</option>
      </select>
      <input type="text" class="f-path" placeholder="path contains…"
             title="Case-sensitive substring of the request path" />
      <span class="count muted"></span>
    </div>
    <div class="table-wrap">
      <table class="log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Deploy</th>
            <th>Method</th>
            <th>Path</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Outcome</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="load-more-wrap" hidden>
      <button type="button" class="load-more">Load older</button>
    </div>
    <aside class="drawer" hidden>
      <div class="drawer-header">
        <h3></h3>
        <button type="button" class="drawer-close" aria-label="Close">×</button>
      </div>
      <div class="drawer-body"></div>
    </aside>
  `;
  root.appendChild(el);

  const tbody = el.querySelector("tbody");
  const refreshBtn = el.querySelector(".refresh");
  const statusSel = el.querySelector(".f-status");
  const methodSel = el.querySelector(".f-method");
  const activationSel = el.querySelector(".f-activation");
  const pathInput = el.querySelector(".f-path");
  const countLabel = el.querySelector(".count");
  const loadMoreWrap = el.querySelector(".load-more-wrap");
  const loadMoreBtn = el.querySelector(".load-more");
  const drawer = el.querySelector(".drawer");
  const drawerTitle = drawer.querySelector("h3");
  const drawerBody = drawer.querySelector(".drawer-body");
  const drawerClose = drawer.querySelector(".drawer-close");

  const PAGE_SIZE = 50;
  let rendering = false;
  let cursor = null; // null = no more pages, set to next_cursor after a page
  let totalLoaded = 0;
  const recordsById = new Map();

  async function load({ append } = { append: false }) {
    if (rendering) return;
    rendering = true;
    refreshBtn.disabled = true;
    loadMoreBtn.disabled = true;
    clearError();
    try {
      // "failures" is an outcome filter wearing the status dropdown —
      // it selects outcome != ok server-side, whatever the status.
      const statusVal = statusSel.value;
      const res = await api.listLogs(instanceId, {
        limit: PAGE_SIZE,
        after: append ? cursor : null,
        status: statusVal && statusVal !== "failures" ? statusVal : null,
        failures: statusVal === "failures",
        method: methodSel.value || null,
        activation: activationSel.value || null,
        path: pathInput.value.trim() || null,
      });
      const records = res.records ?? [];
      cursor = res.next_cursor || null;

      if (!append) {
        recordsById.clear();
        tbody.replaceChildren();
        totalLoaded = 0;
      }

      for (const r of records) recordsById.set(r.request_id, r);

      if (!append && records.length === 0) {
        const filtered = statusSel.value || methodSel.value
          || activationSel.value || pathInput.value.trim();
        const tr = document.createElement("tr");
        tr.className = "empty";
        tr.innerHTML = filtered
          ? `<td colspan="8"><em>no requests match these filters</em></td>`
          : `<td colspan="8"><em>no requests logged yet</em></td>`;
        tbody.appendChild(tr);
      } else {
        for (const r of records) tbody.appendChild(buildRow(r));
      }

      totalLoaded += records.length;
      const more = cursor !== null && records.length > 0;
      countLabel.textContent =
        `${totalLoaded} record${totalLoaded === 1 ? "" : "s"}${more ? " (more available)" : ""}`;
      loadMoreWrap.hidden = !more;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.hash = "#/login";
        return;
      }
      showError(`Load logs failed: ${err.message}`);
    } finally {
      refreshBtn.disabled = false;
      loadMoreBtn.disabled = false;
      rendering = false;
    }
  }

  function buildRow(r) {
    const tr = document.createElement("tr");
    tr.className = "log-row";
    tr.dataset.id = r.request_id;
    tr.tabIndex = 0;
    tr.innerHTML = `
      <td class="time" title="${escapeHtml(absTime(r.received_ns))}">${escapeHtml(relTime(r.received_ns))}</td>
      <td class="deploy" title="deployment ${r.deployment_id}">#${r.deployment_id}</td>
      <td class="method">${escapeHtml(r.method)}</td>
      <td class="path">${escapeHtml(r.path)}</td>
      <td class="status status-${statusClass(r.status)}">${r.status}</td>
      <td class="duration">${formatDuration(r.duration_ns)}</td>
      <td class="outcome outcome-${escapeHtml(r.outcome)}">${escapeHtml(r.outcome)}</td>
      <td class="actions">
        <button type="button" class="row-act replay" title="Open this request in the replay shell (scrubber, source view, variables)">Replay</button>
        <button type="button" class="row-act copy-id" title="Copy request ID">⎘</button>
      </td>
    `;
    tr.addEventListener("click", (ev) => {
      // Don't open the drawer when clicking row-action buttons.
      if (ev.target.closest(".row-act")) return;
      openDrawer(r.request_id);
    });
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openDrawer(r.request_id);
      }
    });
    tr.querySelector(".replay").addEventListener("click", (ev) => {
      ev.stopPropagation();
      void replayRequest(r.request_id, ev.currentTarget);
    });
    tr.querySelector(".copy-id").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      try {
        await navigator.clipboard.writeText(r.request_id);
        const orig = btn.textContent;
        btn.textContent = "✓";
        setTimeout(() => { btn.textContent = orig; }, 1200);
      } catch (err) {
        showError("copy failed: " + err.message);
      }
    });
    return tr;
  }

  async function replayRequest(requestId, btn) {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "…";
    clearError();
    try {
      const bundle = await api.composeReplayBundle(instanceId, requestId);
      api.replayOpen(bundle, instanceId, requestId);
    } catch (err) {
      showError(`Replay failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function openDrawer(requestId) {
    drawer.hidden = false;
    drawerTitle.textContent = requestId;
    drawerBody.textContent = "Loading…";
    try {
      const full = await api.showLog(instanceId, requestId);
      drawerBody.replaceChildren();
      drawerBody.appendChild(renderRecordDetail(full));
    } catch (err) {
      drawerBody.textContent = `Failed to load: ${err.message}`;
    }
  }

  function closeDrawer() {
    drawer.hidden = true;
    drawerBody.replaceChildren();
  }

  refreshBtn.addEventListener("click", () => load({ append: false }));
  loadMoreBtn.addEventListener("click", () => load({ append: true }));

  // Filter changes restart from the newest page (the cursor belongs to
  // the previous filter shape). The path box debounces so typing
  // doesn't fire a query per keystroke.
  for (const sel of [statusSel, methodSel, activationSel]) {
    sel.addEventListener("change", () => load({ append: false }));
  }
  let pathDebounce = 0;
  pathInput.addEventListener("input", () => {
    clearTimeout(pathDebounce);
    pathDebounce = setTimeout(() => load({ append: false }), 300);
  });
  drawerClose.addEventListener("click", closeDrawer);

  load({ append: false });
  return () => {};
}

function renderRecordDetail(r) {
  const wrap = document.createElement("dl");
  wrap.className = "record-detail";
  const rows = [
    ["Request ID", r.request_id],
    ["Deployment", String(r.deployment_id)],
    ["Host", r.host],
    ["Method", r.method],
    ["Path", r.path],
    ["Status", String(r.status)],
    ["Outcome", r.outcome],
    ["Received", absTime(r.received_ns)],
    ["Duration", formatDuration(r.duration_ns)],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    wrap.appendChild(dt);
    wrap.appendChild(dd);
  }
  if (r.console && r.console.length > 0) {
    const dt = document.createElement("dt");
    dt.textContent = "Console";
    const dd = document.createElement("dd");
    const pre = document.createElement("pre");
    pre.textContent = r.console;
    dd.appendChild(pre);
    wrap.appendChild(dt);
    wrap.appendChild(dd);
  }
  if (r.exception && r.exception.length > 0) {
    const dt = document.createElement("dt");
    dt.textContent = "Exception";
    const dd = document.createElement("dd");
    const pre = document.createElement("pre");
    pre.className = "error";
    pre.textContent = r.exception;
    dd.appendChild(pre);
    wrap.appendChild(dt);
    wrap.appendChild(dd);
  }
  return wrap;
}

// ── KV panel ───────────────────────────────────────────────────────

function renderKv(root, { instanceId, api, showError, clearError }) {
  const el = document.createElement("div");
  el.className = "kv-panel";
  el.innerHTML = `
    <div class="toolbar">
      <label class="prefix-label">
        <span>Prefix</span>
        <input class="prefix-input" type="text" placeholder="(any)">
      </label>
      <button type="button" class="refresh">Refresh</button>
      <span class="count muted"></span>
    </div>
    <form class="kv-create">
      <input name="key" placeholder="key" autocomplete="off" required>
      <input name="value" placeholder="value" autocomplete="off">
      <button type="submit">Set</button>
    </form>
    <div class="table-wrap">
      <table class="kv-table">
        <thead>
          <tr><th>Key</th><th>Value</th><th></th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  root.appendChild(el);

  const tbody = el.querySelector("tbody");
  const prefixInput = el.querySelector(".prefix-input");
  const refreshBtn = el.querySelector(".refresh");
  const countLabel = el.querySelector(".count");
  const createForm = el.querySelector(".kv-create");

  async function load() {
    refreshBtn.disabled = true;
    clearError();
    try {
      const res = await api.listKv(instanceId, {
        prefix: prefixInput.value,
        limit: 200,
      });
      const entries = res.entries ?? [];
      tbody.replaceChildren();
      if (entries.length === 0) {
        const tr = document.createElement("tr");
        tr.className = "empty";
        tr.innerHTML = `<td colspan="3"><em>no matching keys</em></td>`;
        tbody.appendChild(tr);
      } else {
        for (const e of entries) tbody.appendChild(kvRow(e));
      }
      countLabel.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.hash = "#/login";
        return;
      }
      showError(`Load failed: ${err.message}`);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function kvRow(entry) {
    const tr = document.createElement("tr");
    tr.dataset.key = entry.key;

    const keyCell = document.createElement("td");
    keyCell.className = "kv-key";
    keyCell.textContent = entry.key;
    tr.appendChild(keyCell);

    const valCell = document.createElement("td");
    valCell.className = "kv-value";
    const valInput = document.createElement("input");
    valInput.type = "text";
    valInput.className = "kv-value-input";
    valInput.value = entry.value;
    valInput.dataset.original = entry.value;
    valCell.appendChild(valInput);
    tr.appendChild(valCell);

    const actionCell = document.createElement("td");
    actionCell.className = "kv-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true;
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    actionCell.appendChild(saveBtn);
    actionCell.appendChild(delBtn);
    tr.appendChild(actionCell);

    valInput.addEventListener("input", () => {
      saveBtn.disabled = valInput.value === valInput.dataset.original;
    });

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        await api.setKv(instanceId, entry.key, valInput.value);
        valInput.dataset.original = valInput.value;
      } catch (err) {
        showError(`Save failed: ${err.message}`);
        saveBtn.disabled = false;
      }
    });

    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete "${entry.key}"?`)) return;
      try {
        await api.deleteKv(instanceId, entry.key);
        tr.remove();
      } catch (err) {
        showError(`Delete failed: ${err.message}`);
      }
    });

    return tr;
  }

  async function onCreate(ev) {
    ev.preventDefault();
    clearError();
    const data = new FormData(createForm);
    const key = String(data.get("key") ?? "").trim();
    const value = String(data.get("value") ?? "");
    if (!key) return;
    try {
      await api.setKv(instanceId, key, value);
      createForm.reset();
      await load();
    } catch (err) {
      showError(`Set failed: ${err.message}`);
    }
  }

  refreshBtn.addEventListener("click", load);
  createForm.addEventListener("submit", onCreate);
  prefixInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      load();
    }
  });

  load();
  return () => {};
}

// ── Code panel ─────────────────────────────────────────────────────

// The Code tab builds a deploy bundle IN THE BROWSER (a "draft") and ships it
// in one shot via api.deployAndRelease (reset → per-file stage → cut →
// release). The current deployment's handler sources load editable through
// the cross-tenant read door (api.readSources). Statics list as metadata
// rows: a TEXT static opens into the editor on click (lazy single-file read,
// api.readSourceFile); a binary one stays byte-opaque. Deploy ships the
// draft, carries every remaining current static by hash-reference (the
// /v1/deploy/ref door — no byte round-trip), and hands cut the package set
// as a resolution so a package-using app redeploys with its capability
// grants intact (package EDITING stays the rewind CLI's job — the set
// carries through frozen). Removing a file from the next deploy is the
// explicit per-row × — nothing is dropped implicitly.
//
// The tree groups the bundle by ROLE, derived purely from the path
// conventions the engine itself dispatches by (rove: src/js/router.zig,
// src/js/deployment_cache.zig, docs/handler-shape.md):
//
//   **/index.mjs                  HTTP route — /a/b resolves to
//                                 a/b/index.mjs with walk-up on miss, so the
//                                 root index.mjs is the catch-all
//   any other *.mjs               helper module — importable, never routed
//   _middlewares/index.mjs        the one middleware entry (runs before
//                                 every routed dispatch; undefined return
//                                 continues, any other short-circuits)
//   _triggers/<prefix>/index.mjs  kv write guard — the path IS the guarded
//                                 prefix (beforePut / beforeDelete)
//   _subscriptions/<name>/        durable kv reaction — index.mjs +
//                                 spec.json (spec.json ships as a STATIC,
//                                 never into the handler-compile set)
//   _static/**                    static assets, served at the path minus
//                                 the prefix; _static/_404.html is the
//                                 convention 404 page
//   _config/**                    package config (static kind, not
//                                 URL-served)
//
// Only `.mjs` is a deployable handler source (the compile pipeline builds
// `.js` as a classic script, so `export` is a syntax error) — every
// creation flow emits `.mjs`.

const CODE_SECTIONS = [
  { role: "route", label: "Routes", add: true },
  { role: "module", label: "Modules", add: true,
    note: "imported by routes — not URL-routable" },
  { role: "middleware", label: "Middleware", add: true },
  { role: "trigger", label: "Triggers", add: true,
    note: "write guards — run inside the writing activation" },
  { role: "subscription", label: "Subscriptions", add: true,
    note: "cron recurrence registers from code (the cron verb), not a file" },
  { role: "static", label: "Static", add: true },
  { role: "config", label: "Config" },
  { role: "package", label: "Packages" },
];

/// Bundle role from the path conventions above. `kind` breaks the tie for
/// stray non-JS files at bare paths (a CLI-published bundle may carry
/// them) — anything the manifest calls a static that isn't under a role
/// dir files under Static rather than vanishing.
function roleFor(path, kind) {
  if (path.startsWith("_static/")) return "static";
  if (path.startsWith("_config/")) return "config";
  if (path.startsWith("_middlewares/")) return "middleware";
  if (path.startsWith("_triggers/")) return "trigger";
  if (path.startsWith("_subscriptions/")) return "subscription";
  if (/(^|\/)index\.mjs$/.test(path)) return "route";
  if (/\.(mjs|js)$/.test(path)) return "module";
  return kind === "handler" ? "module" : "static";
}

/// "index.mjs" → "/", "api/users/index.mjs" → "/api/users".
function routeUrlFor(path) {
  const base = path.replace(/\/?index\.mjs$/, "");
  return base ? "/" + base : "/";
}

function triggerAnnotFor(path) {
  const rest = path.slice("_triggers/".length);
  if (rest === "index.mjs") return "guards every key";
  if (rest.endsWith("/index.mjs"))
    return "guards " + rest.slice(0, -"index.mjs".length);
  return "helper";
}

function subAnnotFor(path) {
  const rest = path.slice("_subscriptions/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return "";
  const name = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (tail === "index.mjs") return name + " · handler";
  if (tail === "spec.json") return name + " · spec";
  return name + " · helper";
}

function annotFor(path, role) {
  switch (role) {
    case "route":
      return routeUrlFor(path) + (path === "index.mjs" ? " · catch-all" : "");
    case "middleware": return "every request";
    case "trigger": return triggerAnnotFor(path);
    case "subscription": return subAnnotFor(path);
    case "static":
      return path === "_static/_404.html"
        ? "404 page" : "/" + path.slice("_static/".length);
    default: return "";
  }
}

/// Row display path: the role dir is the section, so strip it.
function displayPathFor(path, role) {
  switch (role) {
    case "static": return path.slice("_static/".length);
    case "config": return path.slice("_config/".length);
    case "middleware": return path.slice("_middlewares/".length);
    case "trigger": return path.slice("_triggers/".length);
    case "subscription": return path.slice("_subscriptions/".length);
    default: return path;
  }
}

/// Mirror of the /v1/source door's text gate: only these content-types open
/// in the editor; anything else is byte-opaque and carries through deploys
/// by hash-reference.
function isTextualType(ct) {
  const base = String(ct || "").split(";")[0].trim().toLowerCase();
  if (base.startsWith("text/")) return true;
  return base === "application/json" || base === "application/javascript" ||
         base === "application/xml" || base === "image/svg+xml";
}

function renderCode(root, { instanceId, api, showError, clearError }) {
  const el = document.createElement("div");
  el.className = "code-panel";
  el.innerHTML = `
    <div class="code-layout">
      <aside class="file-list">
        <div class="toolbar">
          <button type="button" class="deploy" disabled>Deploy</button>
          <span class="draft-note muted">Deploy ships the whole draft at
            once.</span>
        </div>
        <ul></ul>
      </aside>
      <section class="editor">
        <div class="editor-header">
          <span class="current-path muted">(no file selected)</span>
          <span class="editor-meta muted"></span>
        </div>
        <div class="editor-body" tabindex="-1"></div>
      </section>
    </div>
  `;
  root.appendChild(el);

  const list = el.querySelector(".file-list ul");
  const deployBtn = el.querySelector(".deploy");
  const pathLabel = el.querySelector(".current-path");
  const metaLabel = el.querySelector(".editor-meta");
  const editorMount = el.querySelector(".editor-body");

  // Draft bundle: path → { kind, content_type, source }. Editing updates
  // `source` live; Deploy ships the whole map.
  const draft = {};
  // The CURRENTLY-deployed statics ({path, content_type, hash}), loaded via
  // the read door for the tree. A text one moves into the draft when opened
  // (lazy source read); the rest carry through Deploy by hash-reference.
  // Removing one here (the row's ×) is the only way it leaves the bundle.
  let currentStatics = [];
  // The current deployment's package set. Deploy re-stages each file's
  // source and passes the metadata to cut as a resolution, so the set
  // carries through FROZEN — editing packages stays the rewind CLI's job.
  let currentPackages = [];
  // The app modules' `@scope/pkg` → pkg_hash map — the other half of the
  // resolution cut needs (buildResolution forwards it into the manifest).
  let currentAppImports = {};
  let selected = null; // { path, kind, content_type }
  let cm = null;       // { CM, view, langCompartment, editableCompartment }
  let cmLoading = null; // in-flight import promise

  // Lazy-load + mount the CodeMirror editor on first use. Returns
  // the resolved `cm` handle. The vendored bundle is ~450 KB; only
  // pulled when the user actually opens the Code tab.
  function ensureEditor() {
    if (cm) return Promise.resolve(cm);
    if (cmLoading) return cmLoading;
    cmLoading = import("/codemirror.mjs").then((CM) => {
      const langCompartment = new CM.Compartment();
      const editableCompartment = new CM.Compartment();
      const docChanged = CM.EditorView.updateListener.of((u) => {
        if (!u.docChanged || !selected) return;
        // Live-write the edit into the draft; Deploy ships the whole map.
        draft[selected.path].source = u.state.doc.toString();
        deployBtn.disabled = Object.keys(draft).length === 0;
      });
      const state = CM.EditorState.create({
        doc: "",
        extensions: [
          CM.lineNumbers(),
          CM.highlightActiveLine(),
          CM.history(),
          CM.bracketMatching(),
          CM.indentOnInput(),
          CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true }),
          CM.keymap.of([...CM.defaultKeymap, ...CM.historyKeymap, CM.indentWithTab]),
          langCompartment.of([]),
          editableCompartment.of(CM.EditorView.editable.of(false)),
          docChanged,
        ],
      });
      const view = new CM.EditorView({ state, parent: editorMount });
      cm = { CM, view, langCompartment, editableCompartment };
      return cm;
    }).catch((err) => {
      cmLoading = null;
      showError(`Code editor failed to load: ${err.message}`);
      throw err;
    });
    return cmLoading;
  }

  /// Empty the editor and make it non-editable (read-only rows, package
  /// rows). No-op when CodeMirror was never loaded.
  function clearEditorView() {
    if (!cm) return;
    cm.view.dispatch({
      changes: { from: 0, to: cm.view.state.doc.length, insert: "" },
      effects: [
        cm.langCompartment.reconfigure([]),
        cm.editableCompartment.reconfigure(cm.CM.EditorView.editable.of(false)),
      ],
    });
  }

  function selectRow(key) {
    for (const node of list.querySelectorAll("li")) {
      node.classList.toggle("active", node.dataset.path === key);
    }
  }

  /// The tree's file rows: the draft (editable) plus current statics the
  /// draft doesn't shadow (read-only).
  function bundleRows() {
    const rows = new Map();
    for (const [p, e] of Object.entries(draft)) {
      rows.set(p, {
        path: p, kind: e.kind, content_type: e.content_type, editable: true,
      });
    }
    for (const s of currentStatics) {
      if (!rows.has(s.path)) {
        rows.set(s.path, {
          path: s.path, kind: "static", content_type: s.content_type,
          hash: s.hash, editable: false,
        });
      }
    }
    return [...rows.values()];
  }

  function renderTree() {
    list.replaceChildren();
    deployBtn.disabled = Object.keys(draft).length === 0;

    const rows = bundleRows();
    const byRole = {};
    for (const r of rows) {
      const role = roleFor(r.path, r.kind);
      (byRole[role] = byRole[role] || []).push(r);
    }

    if (rows.length === 0 && currentPackages.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.innerHTML = `<em>empty bundle — create a route with +</em>`;
      list.appendChild(li);
    }

    for (const sec of CODE_SECTIONS) {
      const entries = (byRole[sec.role] || [])
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      const pkgs = sec.role === "package" ? currentPackages : [];
      const showAdd = !!sec.add &&
        !(sec.role === "middleware" && entries.length > 0);
      if (entries.length === 0 && pkgs.length === 0 && !showAdd) continue;

      const h = document.createElement("li");
      h.className = "section";
      h.innerHTML = `<span class="section-label">${sec.label}</span>` +
        (showAdd ? `<button type="button" class="add"
           title="New ${escapeHtml(sec.label.replace(/s$/, "").toLowerCase())}">+</button>` : "");
      if (showAdd) {
        h.querySelector(".add").addEventListener("click", (ev) => {
          ev.stopPropagation();
          addEntry(sec.role);
        });
      }
      list.appendChild(h);

      if (sec.note) {
        const n = document.createElement("li");
        n.className = "note";
        n.textContent = sec.note;
        list.appendChild(n);
      }

      for (const r of entries) list.appendChild(buildFileLi(r, sec.role));
      for (const p of pkgs) list.appendChild(buildPkgLi(p));
    }
  }

  function buildFileLi(r, role) {
    const li = document.createElement("li");
    li.className = "file" + (r.editable ? "" : " read-only");
    li.dataset.path = r.path;
    const annot = annotFor(r.path, role);
    li.innerHTML =
      `<span class="file-path">${escapeHtml(displayPathFor(r.path, role))}</span>` +
      (annot ? `<span class="file-annot">${escapeHtml(annot)}</span>` : "") +
      `<button type="button" class="rm" title="Remove from the next deploy">×</button>`;
    li.addEventListener("click", () => openEntry(r));
    li.querySelector(".rm").addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeEntry(r.path);
    });
    return li;
  }

  // Explicit removal — the ONLY way a file leaves the next deploy (nothing
  // is dropped implicitly). Clears the path from both maps: a text static
  // opened into the draft must not resurface as a hash-reference row.
  function removeEntry(path) {
    if (!window.confirm("Remove " + path + " from the next deploy?")) return;
    delete draft[path];
    currentStatics = currentStatics.filter((s) => s.path !== path);
    if (selected && selected.path === path) {
      selected = null;
      pathLabel.textContent = "(no file selected)";
      metaLabel.textContent = "";
      clearEditorView();
    }
    renderTree();
  }

  function buildPkgLi(p) {
    const li = document.createElement("li");
    li.className = "file read-only";
    li.dataset.path = "pkg:" + (p.pkg_hash || p.spec);
    const nfiles = (p.files || []).length;
    li.innerHTML =
      `<span class="file-path">${escapeHtml(p.spec || "(package)")}</span>` +
      `<span class="file-annot">${escapeHtml(
        (p.version || "") + (nfiles ? " · " + nfiles + " files" : ""))}</span>`;
    li.addEventListener("click", () => {
      selectRow(li.dataset.path);
      selected = null;
      pathLabel.textContent = p.spec || "(package)";
      metaLabel.textContent =
        "package · " + (p.version || "?") + " · " +
        String(p.pkg_hash || "").slice(0, 12) +
        " · carries through deploy frozen — edit via the rewind CLI";
      clearEditorView();
    });
    return li;
  }

  let sourceLoading = false; // one lazy read at a time

  async function openEntry(r) {
    if (r.editable) { openFile(r.path); return; }
    clearError();
    selectRow(r.path);
    selected = null;
    const meta =
      (r.kind || "static") + " · " + (r.content_type || "(no content-type)") +
      (r.hash ? " · " + String(r.hash).slice(0, 12) : "");
    pathLabel.textContent = r.path;

    // Binary → byte-opaque: it carries through Deploy by hash-reference.
    if (!isTextualType(r.content_type)) {
      metaLabel.textContent = meta + " · binary — carries through deploy";
      clearEditorView();
      return;
    }

    // Text → pull the source through the single-file read door, promote the
    // entry into the draft, and open it like any other editable file.
    if (sourceLoading) return;
    sourceLoading = true;
    metaLabel.textContent = meta + " · loading source…";
    try {
      const res = await api.readSourceFile(instanceId, "current", r.path);
      draft[r.path] = {
        kind: "static",
        content_type: r.content_type || res.content_type || "",
        source: res.source ?? "",
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { location.hash = "#/login"; return; }
      metaLabel.textContent = meta;
      showError(`Source read failed: ${err.message}`);
      return;
    } finally {
      sourceLoading = false;
    }
    renderTree();
    await openFile(r.path);
  }

  /// Pick a CodeMirror language extension based on the file path.
  /// `.mjs` / `.js` → JavaScript (with optional JSX flag off);
  /// `.html` / `.htm` → HTML; `.css` → CSS; otherwise plain text.
  function langFor(CM, path) {
    if (path.endsWith(".mjs") || path.endsWith(".js")) return CM.javascript();
    if (path.endsWith(".html") || path.endsWith(".htm")) return CM.html();
    if (path.endsWith(".css")) return CM.css();
    return [];
  }

  async function openFile(path) {
    clearError();
    const entry = draft[path];
    if (!entry) return;
    selectRow(path);
    pathLabel.textContent = path;
    metaLabel.textContent = "Loading editor…";

    let editor;
    try {
      editor = await ensureEditor();
    } catch {
      return; // showError already invoked inside ensureEditor
    }
    selected = { path, kind: entry.kind, content_type: entry.content_type };
    editor.view.dispatch({
      changes: { from: 0, to: editor.view.state.doc.length, insert: entry.source },
      effects: [
        editor.langCompartment.reconfigure(langFor(editor.CM, path)),
        editor.editableCompartment.reconfigure(
          editor.CM.EditorView.editable.of(true),
        ),
      ],
    });
    metaLabel.textContent =
      `${entry.kind} · ${entry.content_type || "(no content-type)"} · draft`;
  }

  // ── Creation templates ───────────────────────────────────────────

  function routeTemplate(url) {
    return `// Inbound HTTP for ${url} — the default export is the inbound arm;
// request/response are ambient (rove docs/handler-shape.md).
export default function () {
  response.headers = { "content-type": "text/plain" };
  return "hello from ${url}\\n";
}
`;
  }

  const MODULE_TEMPLATE = `// Shared module — not URL-routable (only **/index.mjs routes).
// Import it from a route or another module.
export function hello(name) {
  return "hello " + name;
}
`;

  const MW_TEMPLATE = `// Runs before every routed dispatch (continuations and __system/
// modules skip it). Mutations to request persist into the handler —
// request.auth is the usual one. Return undefined to continue; any
// other return value short-circuits as the response body.
export function before() {
  // request.auth = { ... };
}
`;

  function triggerTemplate(prefix) {
    const what = prefix === "" ? "every key" : '"' + prefix + '"';
    return `// kv write guard for ${what} — runs synchronously inside the
// writing activation. beforePut may normalize (return a string to
// replace the stored value) or reject (throw); beforeDelete may
// reject (throw).
export function beforePut(event) {
  // const v = JSON.parse(event.value);
  // if (!v.name) throw new Error("name required");
  // return JSON.stringify(v);
}

export function beforeDelete(event) {
  // if (event.key === "${prefix}protected") throw new Error("protected");
}
`;
  }

  function subTemplate(prefix) {
    return `// Durable kv subscription — fires (coalesced, at-least-once) after
// commits under "${prefix}" (see spec.json). The payload names only the
// dirty prefix, never a key/op — read current committed state and
// reconcile; a redundant re-fire must be harmless.
export function onSubscription() {
  const a = request.activation;
  const rows = kv.prefix(a.source.prefix, "", 100);
  // reconcile from rows…
  return "";
}
`;
  }

  function createDraft(path, kind, content_type, source) {
    if (draft[path] &&
        !window.confirm(path + " is already in the draft — replace it?")) {
      return;
    }
    draft[path] = { kind, content_type, source };
    renderTree();
    openFile(path);
  }

  // Typed creation, one flow per section. All handler flows emit `.mjs`.
  function addEntry(role) {
    clearError();
    switch (role) {
      case "route": {
        const raw = prompt(
          'URL path the route serves (e.g. "/" or "/api/users"):', "/");
        if (raw == null) return;
        const p = raw.trim().replace(/^\/+|\/+$/g, "");
        if (p.startsWith("_")) {
          showError("Leading-underscore paths are platform-reserved.");
          return;
        }
        if (p && !/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(p)) {
          showError("URL path segments may use letters, digits, and . _ ~ -");
          return;
        }
        createDraft(p ? p + "/index.mjs" : "index.mjs", "handler",
          "application/javascript", routeTemplate(p ? "/" + p : "/"));
        return;
      }
      case "module": {
        const raw = prompt('Module path (e.g. "lib/util.mjs"):', "lib/");
        if (raw == null) return;
        let p = raw.trim().replace(/^\/+/, "");
        if (!p) return;
        if (p.startsWith("_")) {
          showError("Leading-underscore paths are platform-reserved.");
          return;
        }
        if (!p.endsWith(".mjs")) p += ".mjs";
        if (/(^|\/)index\.mjs$/.test(p) &&
            !window.confirm(p + " is an index.mjs, so it will be SERVED as " +
              "the route " + routeUrlFor(p) + " — continue?")) {
          return;
        }
        createDraft(p, "handler", "application/javascript", MODULE_TEMPLATE);
        return;
      }
      case "middleware":
        createDraft("_middlewares/index.mjs", "handler",
          "application/javascript", MW_TEMPLATE);
        return;
      case "trigger": {
        const raw = prompt(
          'kv prefix to guard (e.g. "users/"; empty guards every key):', "");
        if (raw == null) return;
        let pre = raw.trim().replace(/^\/+/, "");
        if (pre.startsWith("_")) {
          showError("Leading-underscore prefixes are platform-reserved.");
          return;
        }
        if (pre && !pre.endsWith("/")) pre += "/";
        createDraft("_triggers/" + pre + "index.mjs", "handler",
          "application/javascript", triggerTemplate(pre));
        return;
      }
      case "subscription": {
        const name = prompt(
          "Subscription name ([A-Za-z0-9_-], up to 64 chars):", "");
        if (name == null) return;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name.trim())) {
          showError("Subscription names are 1–64 chars of [A-Za-z0-9_-].");
          return;
        }
        const rawPre = prompt('kv prefix to react to (e.g. "orders/"):', "");
        if (rawPre == null) return;
        let pre = rawPre.trim().replace(/^\/+/, "");
        if (!pre) { showError("A subscription needs a kv prefix."); return; }
        if (pre.startsWith("_")) {
          showError("Leading-underscore prefixes are platform-reserved.");
          return;
        }
        if (!pre.endsWith("/")) pre += "/";
        const dir = "_subscriptions/" + name.trim() + "/";
        // spec.json ships as a STATIC — it must never enter the
        // handler-compile set (the cut would try to compile JSON).
        createDraft(dir + "spec.json", "static", "application/json",
          JSON.stringify({ kind: "kv", prefix: pre }, null, 2) + "\n");
        createDraft(dir + "index.mjs", "handler",
          "application/javascript", subTemplate(pre));
        return;
      }
      case "static": {
        const raw = prompt(
          'Static path (served at the path minus "_static/"):', "_static/");
        if (raw == null) return;
        let p = raw.trim().replace(/^\/+/, "");
        if (!p || p === "_static/") return;
        if (!p.startsWith("_static/") && !p.startsWith("_config/")) {
          p = "_static/" + p;
        }
        createDraft(p, "static", inferContentType(p), "");
        return;
      }
    }
  }

  deployBtn.addEventListener("click", async () => {
    if (Object.keys(draft).length === 0) return;
    // The package set carries through as a resolution, which needs every
    // package file's SOURCE to restage. A missing one (blob unreadable —
    // GC'd?) can't be carried, and deploying without it would cut a
    // manifest with broken imports — refuse.
    const gone = currentPackages.flatMap((p) =>
      (p.files || []).filter((f) => f.missing || f.source == null)
        .map((f) => p.spec + ":" + f.path));
    if (gone.length > 0) {
      showError("Package sources unavailable (" + gone.join(", ") +
        ") — cannot carry the package set through. Publish via the rewind CLI.");
      return;
    }
    deployBtn.disabled = true;
    const orig = deployBtn.textContent;
    deployBtn.textContent = "Deploying…";
    clearError();
    try {
      // draft entries → api.deploy's {path: {kind, source, content_type?}}
      // map. `kind` rides along so a static at a bare path (spec.json)
      // still routes to the byte-upload door, not the handler compile.
      const files = {};
      for (const [p, e] of Object.entries(draft)) {
        files[p] = e.kind === "handler"
          ? { kind: "handler", source: e.source }
          : { kind: "static", source: e.source, content_type: e.content_type };
      }
      // Current statics the draft doesn't shadow carry through by
      // hash-reference — no byte round-trip, nothing dropped implicitly
      // (removal is the row's explicit ×).
      for (const s of currentStatics) {
        if (!(s.path in files)) {
          files[s.path] = { kind: "static", hash: s.hash, content_type: s.content_type };
        }
      }
      const resolution = currentPackages.length > 0
        ? {
            packages: currentPackages.map((p) => ({
              spec: p.spec, version: p.version, pkg_hash: p.pkg_hash,
              imports: p.imports || {},
              capabilities: p.capabilities || [], private: !!p.private,
              files: (p.files || []).map((f) => ({ path: f.path, source: f.source })),
            })),
            app_imports: currentAppImports,
          }
        : undefined;
      const result = await api.deployAndRelease(instanceId, files, resolution);
      metaLabel.textContent = `deployed + released · dep ${result.dep_id}`;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.hash = "#/login";
        return;
      }
      showError(`Deploy failed: ${err.message}`);
    } finally {
      deployBtn.textContent = orig;
      deployBtn.disabled = Object.keys(draft).length === 0;
    }
  });

  // Load the CURRENT deployment's handler sources into the draft (edit-existing
  // via the cross-tenant read door). Handlers become editable; statics and the
  // package set are recorded for the tree (text statics promote into the draft
  // when opened; everything else carries through Deploy by reference). No
  // deployment yet → empty draft.
  async function loadCurrent() {
    try {
      const res = await api.readSources(instanceId, "current");
      for (const e of res.entries || []) {
        if (e.kind === "handler" && e.source != null) {
          draft[e.path] = {
            kind: "handler",
            content_type: e.content_type || "application/javascript",
            source: e.source,
          };
        } else if (e.kind !== "handler") {
          currentStatics.push({
            path: e.path,
            content_type: e.content_type || "",
            hash: e.source_hex || "",
          });
        }
      }
      currentPackages = res.packages || [];
      currentAppImports = res.app_imports || {};
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { location.hash = "#/login"; return; }
      // 404 (no current deployment) or read failure → start from an empty draft.
    }
    renderTree();
  }

  loadCurrent();
  return () => {
    if (cm) {
      cm.view.destroy();
      cm = null;
    }
  };
}

/// Small extension → MIME table for new static files. Covers the
/// obvious cases; falls back to octet-stream for unknowns.
function inferContentType(path) {
  const i = path.lastIndexOf(".");
  const ext = i >= 0 ? path.slice(i + 1).toLowerCase() : "";
  switch (ext) {
    case "html": case "htm": return "text/html; charset=utf-8";
    case "css":  return "text/css";
    case "js":   case "mjs": return "application/javascript";
    case "json": return "application/json";
    case "svg":  return "image/svg+xml";
    case "png":  return "image/png";
    case "jpg":  case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "ico":  return "image/x-icon";
    case "txt":  case "md": return "text/plain; charset=utf-8";
    case "xml":  return "application/xml";
    case "wasm": return "application/wasm";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    default:     return "application/octet-stream";
  }
}

// ── Formatters ─────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusClass(n) {
  if (n >= 500) return "5xx";
  if (n >= 400) return "4xx";
  if (n >= 300) return "3xx";
  if (n >= 200) return "2xx";
  return "1xx";
}

function formatDuration(ns) {
  const us = ns / 1000;
  if (us < 1000) return `${us.toFixed(0)}µs`;
  const ms = us / 1000;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function relTime(nsEpoch) {
  const nowMs = Date.now();
  const thenMs = Number(BigInt(nsEpoch) / 1_000_000n);
  const diff = nowMs - thenMs;
  if (diff < 0) return "just now";
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function absTime(nsEpoch) {
  const ms = Number(BigInt(nsEpoch) / 1_000_000n);
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(nsEpoch);
  }
}
