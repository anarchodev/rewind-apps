// Typed wrapper around the rove admin API.
//
// Auth is OIDC: the admin dashboard is a pure relying party of the
// __auth__ IdP. Login is a full-page redirect to `/_rp/login`; the
// server binds a session to the platform `__Host-rove_sid` cookie
// (oidc.rp), which every subsequent fetch replays automatically
// (`credentials: "include"`). No tokens in localStorage, no
// rove_session cookie, no client-held credential.
//
// One REST surface on the `__admin__` handler: `GET/POST/PUT/DELETE /v1/...`
// (instances, accounts/members/invites, per-tenant kv, releases, domains), all
// same-origin fetches carrying the session cookie. The deploy/logs/cp/sources
// paths are chokepoints that issue the privileged internal-door fetches
// server-side — no services token, log token, or move-secret enters the browser.
// Per-tenant kv is nested under the instance (`/v1/instances/:id/kv`); there is
// no `X-Rove-Scope` header anymore.

const BASE_KEY = "rove.admin.api_base";

export class ApiError extends Error {
  constructor(status, statusText, body) {
    super(`${status} ${statusText}`);
    this.status = status;
    this.body = body;
  }
}

/// The admin API base. Defaults to this page's origin (prod shape:
/// same-origin as the UI bundle). Override via `?api=` once and it
/// sticks in localStorage — useful for dev against a remote worker.
function adminBase() {
  const override = window.__rove_api_base ?? localStorage.getItem(BASE_KEY);
  if (override && override.length > 0) return override.replace(/\/+$/, "");
  return window.location.origin;
}

/// Call the admin REST API. `path` is `/v1/...` (already query-encoded); `body`
/// (when given) is JSON. Sends the session cookie. Parses JSON or text; throws
/// ApiError on non-2xx. The one transport for every admin operation.
async function rest(method, path, body) {
  const init = { method, credentials: "include", headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(adminBase() + path, init);
  const ct = res.headers.get("content-type") ?? "";
  const parsed = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text();
  if (!res.ok) throw new ApiError(res.status, res.statusText, parsed);
  return parsed;
}

/// Encode a path segment (instance id, account id, hash, host).
const seg = (s) => encodeURIComponent(String(s));

/// Minimal JSON POST used by /v1/logout. Returns the parsed body or
/// throws on non-2xx. Always same-origin, cookie-authenticated.
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") ?? "";
  const parsed = ct.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text();
  if (!res.ok) throw new ApiError(res.status, res.statusText, parsed);
  return parsed;
}

/// Same-origin GET against an admin chokepoint path (logs / cp reads).
/// Carries the RP session cookie; throws ApiError on non-2xx.
async function originGet(path) {
  const res = await fetch(adminBase() + path, { credentials: "same-origin" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new ApiError(res.status, res.statusText, txt);
  }
  return res;
}

// Logs go through the admin app's OWN chokepoint (`/v1/logs/*`), which issues
// the privileged `rewind-logs.internal` door fetch server-side — the worker
// mints a tenant-scoped `logs-read` cap and the log-server verifies it
// (step3-auth-plan.md A5). So there is NO services token in the browser:
// same-origin, carrying the RP session cookie. Call sites keep passing the
// log-server path shape `/v1/{inst}/...`; the chokepoint mounts it under
// `/v1/logs/`.
async function logFetch(path) {
  return originGet(path.replace(/^\/v1\//, "/v1/logs/"));
}

/// base64 → Uint8Array (browser-side; statics + tape decode).
function decodeB64(s) {
  if (!s) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// Uint8Array | ArrayBuffer | string → base64 (for the deploy bundle's
/// static entries).
function encodeB64(bytes) {
  let view;
  if (typeof bytes === "string") view = new TextEncoder().encode(bytes);
  else if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
  else view = bytes;
  let bin = "";
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

export const api = {
  // ── Auth ─────────────────────────────────────────────────────────
  // Login is the OIDC RP handshake: a full-page navigation to
  // `/_rp/login` (see pages/login.js) — there is no token/signup form
  // and no client-held credential.
  logout() {
    return postJson(adminBase() + "/v1/logout", {});
  },
  /// Provision an instance into `account` (defaults to the caller's
  /// personal account). Identity is the OIDC-verified session `sub`
  /// server-side; any active member of `account` may provision, counting
  /// against that account's plan.
  provisionInstance(name, account = null) {
    return rest("POST", "/v1/instances", account ? { name, account } : { name });
  },
  /// Returns `{is_root, sub, accounts, active_account, owned}` on a valid
  /// session, null on 401. `accounts` is [{aid, role, is_personal, name,
  /// instances}]; `owned` is the personal account's instances (back-compat).
  async whoami() {
    try {
      const res = await fetch(adminBase() + "/v1/session", {
        method: "GET",
        credentials: "include",
      });
      if (res.status === 401) return null;
      if (!res.ok) throw new ApiError(res.status, res.statusText, null);
      return await res.json();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      return null;
    }
  },

  // ── Teams / accounts ─────────────────────────────────────────────
  //
  // An account is the team / billing entity. Every user has a permanent
  // personal account; team accounts are created explicitly. Members share
  // ownership of the account's tenants; invites are tokened magic-links by
  // email. All gated server-side (owner-only for invite/remove/role; member
  // for list; the personal account is non-leavable).
  createAccount(name) {
    return rest("POST", "/v1/accounts", { name });
  },
  listMembers(aid) {
    return rest("GET", "/v1/accounts/" + seg(aid) + "/members");
  },
  inviteMember(aid, email) {
    return rest("POST", "/v1/accounts/" + seg(aid) + "/invites", { email });
  },
  acceptInvite(token) {
    return rest("POST", "/v1/invites/accept", { token });
  },
  setMemberRole(aid, memberHash, role) {
    return rest("PUT", "/v1/accounts/" + seg(aid) + "/members/" + seg(memberHash), { role });
  },
  removeMember(aid, memberHash) {
    return rest("DELETE", "/v1/accounts/" + seg(aid) + "/members/" + seg(memberHash));
  },
  revokeInvite(aid, emailHash) {
    return rest("DELETE", "/v1/accounts/" + seg(aid) + "/invites/" + seg(emailHash));
  },
  leaveAccount(aid) {
    return rest("POST", "/v1/accounts/" + seg(aid) + "/leave");
  },
  /// The UI's "active account" selection (which account new instances land
  /// in / the members page targets). Persisted client-side; falls back to
  /// whoami's `active_account` (the personal account).
  getActiveAccount() {
    return localStorage.getItem("rove.admin.active_account");
  },
  setActiveAccount(aid) {
    if (aid) localStorage.setItem("rove.admin.active_account", aid);
  },

  // ── Instances + domains ──────────────────────────────────────────
  // listInstances → caller's accessible tenants (operator: all). createInstance
  // is the operator raw create (PUT); customers provision via provisionInstance.
  listInstances() {
    return rest("GET", "/v1/instances");
  },
  createInstance(id) {
    return rest("PUT", "/v1/instances/" + seg(id));
  },
  getInstance(id) {
    return rest("GET", "/v1/instances/" + seg(id));
  },
  deleteInstance(id) {
    return rest("DELETE", "/v1/instances/" + seg(id));
  },
  listDomains() {
    return rest("GET", "/v1/domains");
  },
  assignDomain(host, instance_id) {
    return rest("PUT", "/v1/domains/" + seg(host), { instance_id });
  },

  // ── Per-tenant KV (nested under the instance; no X-Rove-Scope) ────
  listKv(instance_id, { prefix = "", cursor = "", limit = 100 } = {}) {
    const qs = new URLSearchParams({ prefix, cursor, limit: String(limit) }).toString();
    return rest("GET", "/v1/instances/" + seg(instance_id) + "/kv?" + qs);
  },
  getKv(instance_id, key) {
    return rest("GET", "/v1/instances/" + seg(instance_id) + "/kv?key=" + seg(key));
  },
  setKv(instance_id, key, value) {
    return rest("PUT", "/v1/instances/" + seg(instance_id) + "/kv", { key, value });
  },
  deleteKv(instance_id, key) {
    return rest("DELETE", "/v1/instances/" + seg(instance_id) + "/kv?key=" + seg(key));
  },

  // ── Deploy (per-file workspace flow) ─────────────────────────────
  //
  // Files upload ONE AT A TIME into a durable per-tenant workspace, then a
  // release is cut from it: POST /v1/deploy/reset (clear) → /v1/deploy/file
  // per file (handler source compiles, static content-addresses) →
  // /v1/deploy/cut (stampManifest → dep_id). Each request is small (the old
  // single mega-POST OOM'd the deploy app's JS heap on real bundles).
  // Ownership-gated server-side (is_root OR the session owns the tenant).
  //
  // `files` is `{ path: { source } }` for handlers and
  // `{ path: { bytes, content_type } }` for statics (a `_static/`- or
  // `_config/`-prefixed path, or any entry carrying `bytes`, is a static).
  async _deployFile(instance_id, sub, body) {
    const res = await fetch(adminBase() + "/v1/deploy/" + sub, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, res.statusText, parsed);
    return parsed;
  },
  /// Stream one static's raw bytes straight to S3 (PUT /v1/upload).
  async _uploadStatic(instance_id, path, content_type, bytes) {
    const qs = new URLSearchParams({ tenant: instance_id, path, content_type }).toString();
    const res = await fetch(adminBase() + "/v1/upload?" + qs, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, res.statusText, parsed);
    return parsed;
  },
  async deploy(instance_id, files) {
    await this._deployFile(instance_id, "reset", { tenant: instance_id });
    for (const [path, f] of Object.entries(files)) {
      const isStatic = f.bytes != null || path.startsWith("_static/") ||
                       path.startsWith("_config/");
      if (isStatic) {
        const bytes = f.bytes != null ? f.bytes : new TextEncoder().encode(f.source ?? "");
        await this._uploadStatic(instance_id, path,
                                 f.content_type || "application/octet-stream", bytes);
      } else {
        await this._deployFile(instance_id, "file",
          { tenant: instance_id, path, kind: "handler", source: f.source ?? "" });
      }
    }
    return this._deployFile(instance_id, "cut", { tenant: instance_id });
    // { ok: true, dep_id: "<016x>" }
  },

  /// Flip the live deployment pointer. `dep_id` is the hex string from
  /// `deploy`. Ownership-gated server-side (publishRelease — step3 B5).
  /// The worker proposes the release through raft. Pass the hex string straight
  /// through — sha256-derived dep_ids exceed 2^53, so converting to a JS number
  /// (parseInt) would round and release the wrong manifest. publishRelease
  /// parses the hex string to an exact u64.
  releaseDeployment(instance_id, dep_id) {
    const hex = typeof dep_id === "string" ? dep_id : dep_id.toString(16);
    return rest("POST", "/v1/instances/" + seg(instance_id) + "/release", { dep_id: hex });
  },

  /// High-level helper: deploy a bundle then release it. Returns the
  /// deploy result `{ ok, dep_id }`.
  async deployAndRelease(instance_id, files) {
    const result = await this.deploy(instance_id, files);
    await this.releaseDeployment(instance_id, result.dep_id);
    return result;
  },

  // ── Operator: cluster control plane (is_root only) ───────────────
  //
  // The cluster-management surface — the GUI twin of `rewind-ops`. Each
  // call goes through the admin app's /v1/cp/* chokepoint, which issues
  // the `rewind-cp.internal` door fetch (the worker attaches the
  // move-secret) — no CP secret in the browser (step3-auth-plan.md B4).
  // All are operator-only; a non-operator session gets 403.
  async cpProvision(tenant, cluster, host) {
    return this._cpPost("provision", { tenant, cluster, host });
  },
  async cpMove(tenant, cluster, { live = false } = {}) {
    return this._cpPost("move", { tenant, cluster, live });
  },
  async cpHost(host, tenant) {
    return this._cpPost("host", { host, tenant });
  },
  async cpPlan(tenant, plan) {
    return this._cpPost("plan", { tenant, plan });
  },
  async _cpPost(op, body) {
    const res = await fetch(adminBase() + "/v1/cp/" + op, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) throw new ApiError(res.status, res.statusText, txt);
    return txt ? JSON.parse(txt) : null;
  },
  /// Placement read for a host → `{cluster, tenant, moving, nodes}`.
  async clusterRoute(host) {
    const res = await originGet("/v1/cp/route?host=" + encodeURIComponent(host));
    return res.json();
  },
  /// Plan read for a tenant.
  async clusterPlan(tenant) {
    const res = await originGet("/v1/cp/plan?tenant=" + encodeURIComponent(tenant));
    return res.json();
  },

  // ── Logs (same-origin chokepoint, RP cookie) ─────────────────────
  //
  // request_id / deployment_id are opaque prefixed tokens (`req_<16hex>`
  // / `dep_<16hex>`, commit d561287) — the log server emits them and
  // requires them verbatim on `/show/{id}` and `?after_request_id=`. Pass
  // them through unmodified; the pagination cursor is
  // `{received_ns, request_id}` where request_id is the `req_` token.
  async listLogs(instance_id, { limit = 100, after = null } = {}) {
    const params = { limit: String(limit) };
    if (after) {
      params.after_received_ns = String(after.received_ns);
      params.after_request_id = String(after.request_id);
    }
    const qs = new URLSearchParams(params).toString();
    const res = await logFetch(
      `/v1/${encodeURIComponent(instance_id)}/list?${qs}`);
    return res.json();
  },
  async showLog(instance_id, request_id) {
    const res = await logFetch(
      `/v1/${encodeURIComponent(instance_id)}/show/${encodeURIComponent(String(request_id))}`);
    const body = await res.json();
    return body.record;
  },
  async countLogs(instance_id) {
    const res = await logFetch(
      `/v1/${encodeURIComponent(instance_id)}/count`);
    return res.text();
  },

  // ── Source read (cross-tenant read door) ─────────────────────────
  //
  // Reads a deployment's handler sources back through the admin app's
  // /v1/sources chokepoint, which composes the cross-tenant read door
  // (platform.scope(t).deploy.readManifest + scope(t).blob.get) — the
  // read twin of the deploy path. `dep` is a 16-hex dep_id, or "current"
  // for the live deployment (resolved server-side from _deploy/current).
  // Returns {ok, dep_id, entries:[{path, kind, content_type, source_hex,
  // source?, missing?}]} — handlers carry `source`; statics metadata only.
  async readSources(instance_id, dep = "current") {
    const res = await originGet(
      `/v1/sources/${encodeURIComponent(instance_id)}/${encodeURIComponent(String(dep))}`);
    return res.json();
  },

  // ── Replay bundle composer ───────────────────────────────────────
  //
  // Composes the bundle the WASM replay shell consumes. The log record
  // (fetched via the same-origin logs chokepoint) carries the captured
  // tapes + scalars + request body INLINE; the handler MODULE SOURCES come
  // from the read door (`readSources`), keyed by the request's captured
  // `deployment_id` so a replay steps through the source the handler
  // ACTUALLY ran with. If that deployment's blobs were GC'd (or the read
  // fails), `modules` is empty and `sources_unavailable` is set so the
  // replay shell can explain why it can't show source.
  async composeReplayBundle(instance_id, request_id) {
    const inst = encodeURIComponent(instance_id);
    const rid = encodeURIComponent(String(request_id));

    const recordRes = await logFetch(`/v1/${inst}/show/${rid}`);
    const record = (await recordRes.json()).record;
    const tapesField = record.tapes || {};

    // Historical module sources via the read door (by captured dep_id).
    let modules = [];
    let entryPath = null;
    let entrySource = "";
    let sourcesUnavailable = false;
    try {
      // record.deployment_id is the opaque `dep_<16hex>` token (§7.5);
      // the read door is keyed by the bare hex, so strip the prefix.
      const depHex = String(record.deployment_id ?? "").replace(/^dep_/, "");
      const sr = await this.readSources(instance_id, depHex);
      const handlers = (sr.entries || [])
        .filter((e) => e.kind === "handler" && e.source != null);
      modules = handlers.map((e) => ({ path: e.path, hash: e.source_hex, source: e.source }));
      const entry = handlers.find((e) => e.path === "index.mjs" || e.path === "index.js")
        || handlers[0];
      if (entry) { entryPath = entry.path; entrySource = entry.source; }
      if (handlers.length === 0) sourcesUnavailable = true;
    } catch (_) {
      sourcesUnavailable = true;
    }

    const tapeBlobs = {
      kv: decodeB64(tapesField.kv_tape_b64),
      module: decodeB64(tapesField.module_tree_b64),
      request_reads: decodeB64(tapesField.request_reads_tape_b64),
      // Non-inbound channels (callback / continuation replay). The log
      // server records these for fetch_chunk / ws_message / wake
      // activations; the shell decodes them to rebuild request.ctx +
      // the flattened fetch-result surface. Null for a plain inbound
      // request (the channels were empty).
      fetch_responses: decodeB64(tapesField.fetch_responses_tape_b64),
      trigger_payload: decodeB64(tapesField.trigger_payload_tape_b64),
    };
    // The WS-frame / activation Msg bytes ([opcode][data]) for a
    // ws_message activation — raw, not an RTAP tape.
    const activationBytes = decodeB64(tapesField.activation_bytes_b64);
    // The resolved dispatch export the activation actually ran (the
    // `{to}` override or onFetchResult/Chunk/Done), recorded server-side
    // per commit 41f9d30. Emitted only when set; absent for a plain
    // inbound `default`, in which case the shell falls back to deriving
    // the export from `activation`.
    const exportName = tapesField.export || null;
    const seed = tapesField.seed != null ? BigInt(tapesField.seed) : 0n;
    const timestamp_ns = tapesField.timestamp_ns != null
      ? BigInt(tapesField.timestamp_ns) : 0n;
    // The JS engine version that ran the captured request
    // (format-versioning-audit.md §4). The replay driver will use this to
    // fetch the matching engine WASM once we ship more than one engine; a
    // no-op today (one engine), but threaded now so old captures stay
    // attributable. 0 = unknown (pre-stamp / non-handler record).
    const js_engine_version = tapesField.js_engine_version ?? 0;
    const bodyBytes = decodeB64(tapesField.request_body_b64);

    return {
      request_id: record.request_id,
      deployment_id: record.deployment_id,
      received_ns: record.received_ns,
      duration_ns: record.duration_ns,
      request: {
        method: record.method,
        path: record.path,
        host: record.host,
        body_bytes: bodyBytes,
        body_truncated: !!tapesField.request_body_truncated,
      },
      response: {
        status: record.status,
        outcome: record.outcome,
        console: record.console,
        exception: record.exception,
      },
      entry_path: entryPath,
      entry_source: entrySource,
      modules,
      seed,
      timestamp_ns,
      js_engine_version,
      tape_blobs: tapeBlobs,
      activation: record.activation,
      // The recorded export the shell should invoke. Null → the shell
      // derives it from `activation` (exportForActivation).
      entry_fn: exportName,
      activation_bytes: activationBytes,
      activation_bytes_truncated: !!tapesField.activation_bytes_truncated,
      sources_unavailable: sourcesUnavailable,
      historical_manifest_missing: sourcesUnavailable,
    };
  },

  /// Open the replay shell in a new tab and send it the bundle via
  /// postMessage. The shell is at `replay.<suffix>` — derived from the
  /// dashboard's own origin by replacing the `app.` label.
  replayOpen(bundle) {
    const replayOrigin = window.location.origin.replace("://app.", "://replay.");
    const popup = window.open(replayOrigin + "/", "_blank");
    if (!popup) {
      throw new Error("popup blocked — allow popups for the dashboard");
    }
    function onMsg(e) {
      if (e.origin !== replayOrigin) return;
      if (e.source !== popup) return;
      if (e.data?.kind === "replay:ready") {
        window.removeEventListener("message", onMsg);
        popup.postMessage({ kind: "replay:bundle", bundle }, replayOrigin);
      }
    }
    window.addEventListener("message", onMsg);
    setTimeout(() => window.removeEventListener("message", onMsg), 30_000);
    return popup;
  },
};
