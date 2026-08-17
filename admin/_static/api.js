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
  return originGet(logPath(path));
}

/// The chokepoint mount, on its own so every log call site derives its URL
/// the same way — including the ones that must NOT throw on a non-2xx.
function logPath(path) {
  return path.replace(/^\/v1\//, "/v1/logs/");
}

/// base64 → Uint8Array (browser-side; statics + tape decode).
function decodeB64(s) {
  if (!s) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Out-of-line payload resolution ───────────────────────────────────
//
// A recorded payload over the inline cap is NOT in the log record: the
// record keeps a pointer and the bytes stay in object storage. The
// `body/{request_id}/{channel}/{index}` door turns that pointer back into
// bytes, addressed by RAW TAPE ORDINAL within the channel.
//
// It is resolved HERE, eagerly, and folded into the bundle — the same
// shape as the historical module sources, and for the same reason: the
// replay origin holds no credential (the session cookie is `__Host-`-bound
// to the dashboard), so the shell cannot reach the door at all. The shell
// also needs the bytes BEFORE `CursorEngine.materialise`, which memoizes
// the composed replay and re-runs it on every scrub — a lazy fetch
// afterwards would have to bust that memo on every UI interaction.

// A per-activation `fetch_responses` tape carries one entry — the chunk
// this activation delivers — but the shell reads the LAST entry, so probe
// a short run and stop at the first ordinal the door does not know. The
// cap bounds a record whose channel is longer than expected; it is not a
// correctness boundary, since only the last entry is ever read.
const FETCH_PROBE_LIMIT = 4;

/// Resolve ONE recorded payload. Returns the door's VERDICT, never a
/// throw: an unresolvable payload is a fact the shell has to show (409 —
/// recorded as nothing; 410 — no longer stored; 503 — no content store),
/// and an exception here would flatten it back into the silently-empty
/// body this door exists to eliminate.
async function resolveBody(instance_id, request_id, channel, index) {
  const path = logPath(`/v1/${seg(instance_id)}/body/${seg(request_id)}/${channel}/${index}`);
  let res;
  try {
    res = await fetch(adminBase() + path, { credentials: "same-origin" });
  } catch (e) {
    return { status: 0, error: String(e?.message || e) };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { status: res.status, error: (txt || res.statusText || "").trim() };
  }
  const j = await res.json().catch(() => null);
  if (!j || typeof j.bytes_b64 !== "string") {
    return { status: res.status, error: "the door returned no bytes" };
  }
  // `source` is HOW it resolved (pool | content | carried | empty) — the
  // shell repeats it when it has to explain what it is showing.
  return {
    status: 200,
    source: j.source || "unknown",
    len: j.len ?? 0,
    bytes: decodeB64(j.bytes_b64) ?? new Uint8Array(0),
  };
}

/// Every address this record's replay might need, keyed `"{channel}/{index}"`.
///
/// The dashboard does not parse RTAP, so it cannot see which entries are
/// out of line — it asks by ordinal and lets the door answer. An entry
/// whose bytes rode the tape comes back as `source: "carried"`, which is
/// inert (the shell already has those bytes from the tape blob); the probe
/// exists for the entries that did not.
async function resolveRecordBodies(instance_id, record, tapesField) {
  const out = {};
  const rid = String(record.request_id ?? "");
  if (!rid) return out;

  const jobs = [];
  // trigger_payload/0 — the activation's Msg: an inbound request body, or
  // a continuation's `{"ctx": …}` envelope. Skipped when the record
  // already carries the body inline, which is the common case.
  if (tapesField.trigger_payload_tape_b64 && !tapesField.request_body_b64) {
    jobs.push(["trigger_payload", 0]);
  }
  // fetch_responses — only a `fetch_chunk` activation takes its payload
  // from this channel; every other kind reads it from somewhere else.
  if (tapesField.fetch_responses_tape_b64 && record.activation === "fetch_chunk") {
    for (let i = 0; i < FETCH_PROBE_LIMIT; i++) jobs.push(["fetch_responses", i]);
  }

  for (const [channel, index] of jobs) {
    const r = await resolveBody(instance_id, rid, channel, index);
    // 404 on `fetch_responses` means the channel ended — stop probing
    // rather than recording a run of phantom failures.
    if (r.status === 404 && channel === "fetch_responses") break;
    out[channel + "/" + index] = r;
  }
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

// How many of a saga's seams get an interference scan before the viewer
// opens. Each is a bounded server-side scan, and a long-lived connection
// saga has one per hop — so the viewer would wait on N round-trips to
// draw a rail whose first screen shows a handful of them. Seams past the
// cap are simply absent from the result, and the rail renders them "not
// scanned" rather than as quiet seams: an unexamined seam and an empty
// one are different claims.
const SEAM_SCAN_CAP = 8;

/// Scan this saga's seams for interfering activations — foreign
/// activations whose writes the saga went on to read, or whose reads saw
/// what the saga wrote. Returns one entry per SCANNED seam, carrying the
/// bounds it was scanned over so the viewer can match it to its gap
/// rather than to a position.
///
/// A gap with no activations in it needs no scan: there is nothing there
/// to interfere. Those return a scanned-but-empty entry, which is the
/// honest reading — the seam WAS examined, by the gap count itself.
///
/// Best-effort throughout: a seam that fails to scan is left out, and
/// the viewer says "not scanned" for it. A rail-shaped problem must
/// never become "replay is broken".
async function scanSeams(instance_id, saga) {
  const gaps = Array.isArray(saga?.gaps) ? saga.gaps : [];
  if (gaps.length === 0) return [];
  const out = [];
  let scans = 0;
  for (const g of gaps) {
    if (!g?.before_seq) continue;
    if (!(Number(g.count) > 0)) {
      out.push({
        after_seq: String(g.after_seq ?? "0"), before_seq: String(g.before_seq),
        scanned: 0, scan_truncated: false, skipped_no_tape: 0, interacting: [],
      });
      continue;
    }
    if (scans >= SEAM_SCAN_CAP) break;
    scans++;
    try {
      out.push(await api.getSeam(instance_id, g.after_seq ?? "0", g.before_seq));
    } catch (_) { /* left unscanned — the rail says so */ }
  }
  return out;
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
  /// Delete the CALLER's personal account — immediate, no grace period.
  /// `confirm` must be the account email (server-normalized compare). 409
  /// `sole_owner_of_teams` lists teams to transfer/delete first.
  deleteAccount(confirm) {
    return rest("POST", "/v1/account/delete", { confirm });
  },
  /// Delete a team account (owner-only). `confirm` must be the team name.
  /// Destroys every team-owned instance for every member.
  deleteTeam(aid, confirm) {
    return rest("DELETE", "/v1/accounts/" + seg(aid), { confirm });
  },
  /// The account-rows export: members, roles, instances, billing meta as
  /// one JSON document (the per-instance data export is startExport).
  accountExport(aid) {
    return rest("GET", "/v1/accounts/" + seg(aid) + "/export");
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
  /// Deprovision an instance. DESTRUCTIVE and not undoable: the server
  /// requires `confirm` to equal the instance's own name, so a stray call
  /// cannot destroy a tenant.
  deleteInstance(id, confirm) {
    return rest("DELETE", "/v1/instances/" + seg(id), { confirm });
  },
  listDomains() {
    return rest("GET", "/v1/domains");
  },
  assignDomain(host, instance_id) {
    return rest("PUT", "/v1/domains/" + seg(host), { instance_id });
  },

  // ── Instance data export (rove#340) ───────────────────────────────
  // The artifact is a set of content-addressed parts (KV as JSONL, plus
  // the deployed code bundle's manifest); links are presigned and
  // TTL-bounded — re-request to re-mint.
  startExport(id) {
    return rest("POST", "/v1/instances/" + seg(id) + "/export");
  },
  listExports(id) {
    return rest("GET", "/v1/instances/" + seg(id) + "/export");
  },
  getExport(id, eid) {
    return rest("GET", "/v1/instances/" + seg(id) + "/export/" + seg(eid));
  },
  getExportLinks(id, eid) {
    return rest("GET", "/v1/instances/" + seg(id) + "/export/" + seg(eid) + "/links");
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
  // ── Billing (rove#310) ─────────────────────────────────────────────
  async billingConfig() { return rest("GET", "/v1/billing/config"); },
  async getBilling(aid) { return rest("GET", "/v1/accounts/" + seg(aid) + "/billing"); },
  async subscribeBilling(aid, tier) {
    return rest("POST", "/v1/accounts/" + seg(aid) + "/billing/subscribe", { tier });
  },
  async changeBilling(aid, tier) {
    return rest("POST", "/v1/accounts/" + seg(aid) + "/billing/change", { tier });
  },
  async cancelBilling(aid) {
    return rest("POST", "/v1/accounts/" + seg(aid) + "/billing/cancel", {});
  },

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
  // Optional filters ride the query string; the log server ANDs them
  // onto the tenant/time window server-side (so paging + filters
  // compose): `status` is `NNN` or `Nxx`, `failures` selects
  // outcome != ok, `method`/`activation` match exactly, `path` is a
  // case-sensitive substring (URLSearchParams percent-encodes it; the
  // server decodes).
  async listLogs(instance_id, {
    limit = 100, after = null,
    status = null, failures = false, method = null, activation = null, path = null,
  } = {}) {
    const params = { limit: String(limit) };
    if (after) {
      params.after_received_ns = String(after.received_ns);
      params.after_request_id = String(after.request_id);
    }
    if (status) params.status = status;
    if (failures) params.failures = "1";
    if (method) params.method = method;
    if (activation) params.activation = activation;
    if (path) params.path = path;
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

  // ── Saga viewer reads (the saga window / tape surfaces) ──────────
  //
  // Every exec_seq travels as a DECIMAL STRING — stamps exceed 2^53
  // and a bare JSON number silently rounds; keep them strings
  // end-to-end (compare with === / BigInt, never Number).

  // One saga as the viewer consumes it: {saga, hops, gaps, unplaced,
  // unplaced_truncated, next_cursor}. `after_seq` is the hop keyset
  // cursor (a decimal-string exec_seq).
  async getSaga(instance_id, saga_id, { after_seq = null, limit = null } = {}) {
    const params = {};
    if (after_seq) params.after_seq = String(after_seq);
    if (limit) params.limit = String(limit);
    const qs = new URLSearchParams(params).toString();
    const res = await logFetch(
      `/v1/${encodeURIComponent(instance_id)}/saga/${encodeURIComponent(String(saga_id))}` +
      (qs ? `?${qs}` : ""));
    if (res.status === 404) return null;
    return res.json();
  },

  // The tenant's execution tape, ascending by exec_seq:
  // {records, next_cursor:{exec_seq}}.
  async getWindow(instance_id, { seq_from = null, seq_to = null, after_seq = null, limit = null } = {}) {
    const params = {};
    if (seq_from) params.seq_from = String(seq_from);
    if (seq_to) params.seq_to = String(seq_to);
    if (after_seq) params.after_seq = String(after_seq);
    if (limit) params.limit = String(limit);
    const qs = new URLSearchParams(params).toString();
    const res = await logFetch(
      `/v1/${encodeURIComponent(instance_id)}/window` + (qs ? `?${qs}` : ""));
    return res.json();
  },

  // The interference scan for ONE seam (the open interval between two
  // hop stamps): {probe, scanned, scan_truncated, skipped_no_tape,
  // interacting:[{...row, wrote, read, keys_truncated}]}. after_seq=0
  // means the seam before the saga's first hop.
  async getSeam(instance_id, after_seq, before_seq, { limit = null } = {}) {
    const params = {
      after_seq: String(after_seq ?? "0"),
      before_seq: String(before_seq),
    };
    if (limit) params.limit = String(limit);
    const qs = new URLSearchParams(params).toString();
    const res = await logFetch(
      `/v1/${encodeURIComponent(instance_id)}/seam?${qs}`);
    return res.json();
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
    // Package resolution for the shell's import rewrite: the live engine
    // normalizes `@scope/pkg` to `/pkg/<pkg_hash>/index.mjs` and the module
    // tape records that virtual name, so the shell must rewrite specifiers
    // identically before eval. `app_imports` maps the app modules'
    // specifiers; each package's `imports` maps its own.
    let appImports = {};
    let packages = [];
    try {
      // record.deployment_id is the opaque `dep_<16hex>` token (§7.5);
      // the read door is keyed by the bare hex, so strip the prefix.
      const depHex = String(record.deployment_id ?? "").replace(/^dep_/, "");
      const sr = await this.readSources(instance_id, depHex);
      const handlers = (sr.entries || [])
        .filter((e) => e.kind === "handler" && e.source != null);
      modules = handlers.map((e) => ({ path: e.path, hash: e.source_hex, source: e.source }));
      // Package files join the module set under their VIRTUAL keys — the
      // names the module tape recorded — so the WASM host can serve them
      // and the modules rail can show them.
      appImports = sr.app_imports || {};
      packages = (sr.packages || []).map((p) => ({
        spec: p.spec, pkg_hash: p.pkg_hash, imports: p.imports || {},
      }));
      for (const p of sr.packages || []) {
        for (const f of p.files || []) {
          if (f.source != null) {
            modules.push({ path: f.virtual, hash: f.source_hex, source: f.source });
          }
        }
      }
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
    // u64 fields stay as the record's decimal STRINGS — the shell converts
    // with BigInt() at its use site (which accepts strings losslessly). A
    // BigInt here would survive the postMessage clone but poison the
    // shell's sessionStorage bundle cache: JSON.stringify throws on
    // BigInt, so every refresh of the popup would lose its state.
    const seed = tapesField.seed != null ? String(tapesField.seed) : "0";
    const timestamp_ns = tapesField.timestamp_ns != null
      ? String(tapesField.timestamp_ns) : "0";
    // The JS engine version that ran the captured request
    // (format-versioning-audit.md §4). The replay driver will use this to
    // fetch the matching engine WASM once we ship more than one engine; a
    // no-op today (one engine), but threaded now so old captures stay
    // attributable. 0 = unknown (pre-stamp / non-handler record).
    const js_engine_version = tapesField.js_engine_version ?? 0;
    const bodyBytes = decodeB64(tapesField.request_body_b64);
    // Out-of-line payloads, resolved through the body door and keyed by
    // tape address. Best-effort as a WHOLE (a door outage must not stop a
    // replay from opening) but never per-entry: each address that was
    // asked for is present, carrying either bytes or the door's refusal,
    // so the shell can tell "not asked" from "asked and unresolvable".
    let resolvedBodies = {};
    try {
      resolvedBodies = await resolveRecordBodies(instance_id, record, tapesField);
    } catch (_) {
      resolvedBodies = {};
    }

    return {
      request_id: record.request_id,
      deployment_id: record.deployment_id,
      // Identity prod pins on every activation (request.tenant /
      // request.sagaId) — recorded per row, so forward it.
      tenant_id: record.tenant_id,
      saga_id: record.saga_id,
      // The digest the worker recorded for this run. The shell recomputes it
      // during replay and compares — null means the capture predates digests,
      // which the shell must report as unverified rather than as agreement.
      interaction_digest: tapesField.interaction_digest ?? null,
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
      app_imports: appImports,
      packages,
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
      // `{channel}/{index}` → {status:200, source, len, bytes} for a
      // resolved payload, or {status, error} for one the door refused.
      // The `bytes` Uint8Arrays survive the shell's sessionStorage bundle
      // cache (its replacer/reviver round-trips typed arrays at any depth);
      // nothing here is a BigInt, which that cache flattens to a string.
      resolved_bodies: resolvedBodies,
      sources_unavailable: sourcesUnavailable,
      historical_manifest_missing: sourcesUnavailable,
    };
  },

  /// Open the replay shell in a new tab and send it the bundle via
  /// postMessage. The shell is at `replay.<suffix>` — derived from the
  /// dashboard's own origin by replacing the `app.` label.
  ///
  /// The URL fragment carries the record's identity
  /// (#/{instance}/{request_id}): the shell caches the posted bundle in
  /// sessionStorage under it, so a refresh of the popup reloads the
  /// same record without this handshake, and a state-less tab can point
  /// the user back at the right dashboard page.
  /// The viewer's unit of playback is the SAGA, so the popup asks for
  /// a specific record (`replay:ready` carries the request_id from its
  /// own fragment) and we answer with that record's bundle plus the
  /// saga window its tape rail draws. Walking to another hop is a
  /// navigation in the popup, which re-handshakes — so this listener
  /// lives as long as the popup does, not for one exchange.
  ///
  /// The popup can also ask us to OPEN another activation
  /// (`replay:open`) — a seam mark on its scrubber names an activation
  /// of a different saga, and following one is a new viewer window,
  /// composed here for the same reason: the session lives HERE, never
  /// in the replay origin. Every compose and every log read goes
  /// through this window.
  replayOpen(bundle, instance_id, request_id) {
    const replayOrigin = window.location.origin.replace("://app.", "://replay.");
    const frag = (instance_id && request_id)
      ? `#/${encodeURIComponent(instance_id)}/${encodeURIComponent(request_id)}`
      : "";
    const popup = window.open(replayOrigin + "/" + frag, "_blank");
    if (!popup) {
      throw new Error("popup blocked — allow popups for the dashboard");
    }
    async function onMsg(e) {
      if (e.origin !== replayOrigin) return;
      if (e.source !== popup) return;

      // Following a seam mark: open a SECOND viewer, anchored at that
      // activation. It gets its own popup and its own listener, so the
      // window that asked keeps its anchor and its playhead.
      if (e.data?.kind === "replay:open") {
        const rid = e.data.request_id;
        if (!rid) return;
        try {
          const b = await api.composeReplayBundle(instance_id, rid);
          api.replayOpen(b, instance_id, rid);
        } catch (err) {
          // The asking window is mid-replay and fine; a failed jump is
          // not its problem to render.
          console.warn("replay: could not open " + rid + ":", err);
        }
        return;
      }

      // Extending the window: the viewer holds a PREFIX of the saga and
      // wants what comes after it — because more hops have landed since
      // it opened, or because the window API paged at 100 and the rest
      // was never fetched. Both are the same query. It asks; nothing
      // here polls (rove#589, "the window extends only when the reader
      // asks").
      if (e.data?.kind === "replay:tail") {
        const sagaId = e.data.saga_id;
        if (!sagaId) return;
        try {
          const saga = await api.getSaga(instance_id, sagaId,
            { after_seq: e.data.after_seq ?? "0" });
          // A saga the index no longer has answers 404 → null. Say so,
          // rather than reporting an empty page, which the viewer would
          // render as "no new hops".
          if (!saga) throw new Error("this saga is no longer in the log window");
          const seams = await scanSeams(instance_id, saga);
          popup.postMessage({ kind: "replay:tail:result", saga, seams }, replayOrigin);
        } catch (err) {
          popup.postMessage({
            kind: "replay:tail:result",
            error: String(err?.message || err),
          }, replayOrigin);
        }
        return;
      }

      if (e.data?.kind !== "replay:ready") return;
      const want = e.data.request_id || request_id;
      try {
        // The record we opened with is already composed; any other hop
        // of the saga is composed on demand.
        const b = (want && want !== request_id)
          ? await api.composeReplayBundle(instance_id, want)
          : bundle;
        // The saga window is best-effort: a viewer with no rail still
        // replays the hop, and a hard failure here would turn a
        // rail-shaped problem into "replay is broken".
        let saga = null;
        if (b?.saga_id) {
          try { saga = await api.getSaga(instance_id, b.saga_id); } catch (_) { saga = null; }
        }
        const seams = await scanSeams(instance_id, saga);
        popup.postMessage({ kind: "replay:bundle", bundle: b, saga, seams }, replayOrigin);
      } catch (err) {
        popup.postMessage({
          kind: "replay:error",
          message: String(err?.message || err),
        }, replayOrigin);
      }
    }
    window.addEventListener("message", onMsg);
    // Reap the listener once the popup is gone (a hop switch reloads
    // the popup, so a fixed timeout would silently break walking a
    // saga after 30s).
    const reap = setInterval(() => {
      if (popup.closed) {
        window.removeEventListener("message", onMsg);
        clearInterval(reap);
      }
    }, 5_000);
    return popup;
  },
};
