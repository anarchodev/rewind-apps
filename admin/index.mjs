function validId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// Operator sees every tenant; a customer sees only the tenants of the accounts
// they belong to (was: ALL tenants leaked to any authenticated session).
export function listInstance() {
    const a = request.auth || {};
    if (a.is_root) {
        const entries = platform.root.prefix("instance/", "", 1000);
        return { instances: entries.map((e) => ({ id: e.key.slice("instance/".length) })) };
    }
    if (!a.sub) { response.status = 401; return { error: "unauthenticated" }; }
    return { instances: accessibleInstances(accountHashFor(a.sub)).map((id) => ({ id })) };
}

export function getInstance(id) {
    if (!validId(id)) { response.status = 400; return { error: "invalid id" }; }
    const v = platform.root.get("instance/" + id);
    if (v === null) { response.status = 404; return { error: "not found" }; }
    return { id: id };
}

export function createInstance(id) {
    if (!validId(id)) { response.status = 400; return { error: "invalid id" }; }
    platform.root.set("instance/" + id, "");
    response.status = 201;
    return { id: id };
}

export function deleteInstance(id) {
    if (!validId(id)) { response.status = 400; return { error: "invalid id" }; }
    // Clean up the ownership overlay before dropping the routing row, so we don't
    // orphan the account marker / reverse pointer (a pre-teams leak too).
    const aid = kv.get("instance/" + id + "/owner");
    if (aid !== null) {
        kv.delete("account/" + aid + "/instances/" + id);
        kv.delete("instance/" + id + "/owner");
    }
    platform.root.delete("instance/" + id);
    const doms = platform.root.prefix("domain/", "", 1000);
    for (let i = 0; i < doms.length; i++) {
        if (doms[i].value === id) platform.root.delete(doms[i].key);
    }
    response.status = 204;
    return null;
}

export function listDomain() {
    const entries = platform.root.prefix("domain/", "", 1000);
    return {
        domains: entries.map((e) => ({
            host: e.key.slice("domain/".length),
            instance_id: e.value,
        })),
    };
}

export function assignDomain(host, instance_id) {
    if (!host || !instance_id) {
        response.status = 400;
        return { error: "host and instance_id required" };
    }
    const exists = platform.root.get("instance/" + instance_id);
    if (exists === null) {
        response.status = 404;
        return { error: "instance not found" };
    }
    platform.root.set("domain/" + host, instance_id);
    response.status = 201;
    return { host: host, instance_id: instance_id };
}

// Per-tenant KV browse. The instance id comes from the route
// (`/v1/instances/:id/kv`) — `kv` (the global) is ALWAYS __admin__-home, so a
// scoped browse reaches the target explicitly via `platform.scope(id).kv`.
// __admin__'s own kv is reached by id `__admin__` (operator-gated via canAccess,
// is_root bypass). Returns the store, or null after stamping a 404.
function kvStoreFor(id) {
    try {
        return platform.scope(id).kv;
    } catch (e) {
        if (e && e.code === "InstanceNotFound") {
            response.status = 404;
            return null;
        }
        throw e;
    }
}

// GET /v1/instances/:id/kv — `?key=` for a single value, else a prefix list
// (`?prefix=&cursor=&limit=`).
function kvRead(id, q) {
    const store = kvStoreFor(id);
    if (store === null) return { error: "unknown instance" };
    if (q.key) {
        const v = store.get(q.key);
        if (v === null) { response.status = 404; return { error: "not found" }; }
        return v;
    }
    const p = q.prefix || "";
    const c = q.cursor || "";
    const l = Math.max(1, Math.min(parseInt(q.limit ?? 100, 10) || 100, 1000));
    const entries = store.prefix(p, c, l);
    const body = { entries: entries.map((e) => ({ key: e.key, value: e.value })) };
    if (entries.length === l && entries.length > 0) {
        body.next_cursor = entries[entries.length - 1].key;
    }
    return body;
}

// PUT /v1/instances/:id/kv  {key, value}
function kvSet(id, key, value) {
    if (!key) { response.status = 400; return { error: "missing key" }; }
    if (typeof value !== "string") {
        response.status = 400; return { error: "value must be a string" };
    }
    const store = kvStoreFor(id);
    if (store === null) return { error: "unknown instance" };
    store.set(key, value);
    return { key: key };
}

// DELETE /v1/instances/:id/kv?key=
function kvDelete(id, key) {
    if (!key) { response.status = 400; return { error: "missing key" }; }
    const store = kvStoreFor(id);
    if (store === null) return { error: "unknown instance" };
    store.delete(key);
    response.status = 204;
    return null;
}

// Publish a release for `instance_id` at `dep_id`. Stamps
// `_deploy/current = dep_id` on the target tenant + proposes
// through raft + enqueues the deployment loader. Fire-and-forget
// — the response returns once the local commit + raft queue
// insert + loader enqueue are done (typically sub-millisecond).
// Raft consensus settles in the background; bytecode load
// happens on the loader thread.
//
// Replaces the old `/_system/release` system route. Customer flow: stage a
// bundle (→ dep_id), then call this with that dep_id.
//
// Authz (step3-auth-plan.md B5): an operator (is_root) may release any tenant;
// a non-operator may release ONLY a tenant they own (`account/{hash}/instances/
// {id}` via `ownedInstances`). Previously this checked nothing — any
// authenticated session could release any tenant.
export function publishRelease(instance_id, dep_id) {
    if (!validId(instance_id)) {
        response.status = 400;
        return { error: "invalid instance_id" };
    }
    // dep_id MUST be a HEX STRING (the form `deploy`/cut returns) — sha256-derived
    // dep_ids exceed 2^53, so a JSON number silently loses precision (JSON.parse →
    // f64) and would release the WRONG (rounded) manifest. Reject a number
    // outright rather than coerce it lossily; the earlier back-compat number path
    // was the source of the "must be a positive integer" 400 (a coerced/NaN id).
    if (typeof dep_id !== "string") {
        response.status = 400;
        return { error: "dep_id must be a hex string (u64); a JSON number loses precision above 2^53 — pass the hex id `deploy`/cut returned" };
    }
    if (!/^[0-9a-fA-F]{1,16}$/.test(dep_id)) {
        response.status = 400;
        return { error: "dep_id must be a hex u64 (1–16 hex digits)" };
    }
    const dep = dep_id;
    const auth = request.auth || {};
    if (!auth.sub) return jsonError(401, "unauthenticated");
    if (!auth.is_root && !canAccess(accountHashFor(auth.sub), instance_id)) {
        return jsonError(403, "not your instance");
    }
    try {
        platform.releases.publish(instance_id, dep);
    } catch (e) {
        if (e && e.code === "InstanceNotFound") {
            response.status = 404;
            return { error: "instance not found" };
        }
        throw e;
    }
    response.status = 202;
    return { instance_id: instance_id, dep_id: dep, status: "queued" };
}

// ── OIDC relying-party surface (auth-domain-plan §4.7 "3-6 part 2")
//
// admin is a pure OIDC relying party. Authentication lives in the
// __auth__ IdP; `_middlewares/index.mjs` resolves the RP session and
// sets `request.auth = { sub, is_root }` (or 401s). The named
// exports above are the dashboard's ?fn RPC surface (now trusting
// request.auth); the default export below owns the path-routed
// `/_rp/*` handshake + `/v1/{session,logout}`. There is no
// rove_session cookie, no magic-link, and no root-token human path
// — those were deleted with Fork B. `/_system/*` keeps its own
// independent root-token M2M gate (unaffected).

// Same RESERVED_INSTANCE_NAMES as worker.zig — admin's JS owns the
// list so operators can adjust without a Zig recompile.
const RESERVED_NAMES = [
    "__admin__","admin","api","app","www",
    "auth","login","signup","logout","dashboard",
    "static","system","public","root","mail",
    "__replay__","replay",
];

function isReserved(name) {
    const lower = name.toLowerCase();
    for (let i = 0; i < RESERVED_NAMES.length; i++) {
        if (RESERVED_NAMES[i] === lower) return true;
    }
    return false;
}

function jsonError(status, message) {
    response.status = status;
    return { error: message };
}

// ── Account model ───────────────────────────────────────────────────
// The OIDC-verified id_token `sub` (email) is the account identity.
// account/{sha256(sub)}/plan stores the tier;
// account/{hash}/instances/{instance_id} marks ownership. v1
// hardcodes a single "free" tier with max_instances=1 — Phase 10
// will branch on plan values (rate caps, DLQ retention, blob caps,
// custom-domain counts, Stripe linkage). Seed-manifest tenants stay
// outside the account model entirely (no account/* rows, no count
// toward any limit). All these rows live in __admin__-home kv.

const PLAN_LIMITS = {
    free: { max_instances: 1 },
};

// Non-personal (team) accounts a single user may OWN. Pre-billing abuse guard:
// each free account carries its own free instance, so uncapped team creation
// would void the per-account limit. Phase 10 billing replaces this with a
// plan-gated allowance. Operators (is_root) are exempt.
const MAX_TEAM_ACCOUNTS = 2;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The account/user hash. ONE normalization point: the IdP lowercases+trims
// email before it becomes `sub` (auth/index.mjs), so an invite that hashes a
// user-typed address MUST normalize identically or accept would silently miss.
// For an already-normalized `sub` this is a no-op (same bytes → same hash), so
// existing account/{hash}/* rows are unaffected.
function userHashFor(email) { return crypto.sha256(String(email).trim().toLowerCase()); }
function accountHashFor(email) { return userHashFor(email); }

function planLimitsFor(accountHash) {
    const plan = kv.get("account/" + accountHash + "/plan") || "free";
    return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

// Owned-instance count for an account. Works for ANY account id (personal or
// team): reads `account/{aid}/instances/`. The old "pending reservation" half
// is gone: provisioning is synchronous behind a proven OIDC session.
function ownedInstances(accountHash) {
    return kv.prefix("account/" + accountHash + "/instances/", "", 1000)
        .map((e) => e.key.slice(("account/" + accountHash + "/instances/").length));
}

// ── Team account model (membership overlay) ─────────────────────────
// An "account" is the team / billing entity. A user is a MEMBER of one or more
// accounts; every user has a permanent personal account whose id IS their own
// hash (`aid === userHash`). Roles: "owner" | "member". All rows are
// __admin__-home kv. See the teams plan for the full schema.

// THE authz primitive — is `userHash` an active member of the account that owns
// `tenant`? O(1): at most two kv.get on one store, no scans.
function canAccess(userHash, tenant) {
    const aid = kv.get("instance/" + tenant + "/owner");
    if (aid !== null) {
        const role = kv.get("account/" + aid + "/members/" + userHash);
        return role === "owner" || role === "member"; // NOT "invited:*"
    }
    // LEGACY FALLBACK until the reverse pointer is backfilled: only the legacy
    // owner's own marker exists, so this grants exactly the pre-teams set (owner
    // only) — membership can't leak here (it needs instance/{id}/owner set).
    return kv.get("account/" + userHash + "/instances/" + tenant) !== null;
}

function roleInAccount(aid, userHash) {
    return kv.get("account/" + aid + "/members/" + userHash); // "owner"|"member"|"invited:member"|null
}
function isActiveMember(aid, userHash) {
    const r = roleInAccount(aid, userHash);
    return r === "owner" || r === "member";
}

// The account ids a user actively belongs to (reverse index), personal always
// included even pre-backfill.
function accountsForUser(userHash) {
    const accts = kv.prefix("user/" + userHash + "/accounts/", "", 1000)
        .map((e) => e.key.slice(("user/" + userHash + "/accounts/").length));
    if (accts.indexOf(userHash) === -1) accts.push(userHash);
    return accts;
}

// Union of instances across every account the user can reach (dedup).
function accessibleInstances(userHash) {
    const seen = {}, out = [];
    for (const aid of accountsForUser(userHash))
        for (const id of ownedInstances(aid))
            if (!seen[id]) { seen[id] = 1; out.push(id); }
    return out;
}

// Idempotent lazy migration: materialize this user's personal account + backfill
// instance→owner pointers for tenants they already own. Set-if-absent, so it's a
// no-op after the first call. Called from handleSession + provisionInstance.
function backfillSelf(userHash, email) {
    if (kv.get("account/" + userHash + "/members/" + userHash) === null) {
        kv.set("account/" + userHash + "/members/" + userHash, "owner");
        kv.set("user/" + userHash + "/accounts/" + userHash, "owner");
        if (email) kv.set("account/" + userHash + "/email/" + userHash, email);
    }
    for (const id of ownedInstances(userHash))
        if (kv.get("instance/" + id + "/owner") === null)
            kv.set("instance/" + id + "/owner", userHash);
}

// Active owners of an account (drives the last-owner guard).
function ownerCount(aid) {
    return kv.prefix("account/" + aid + "/members/", "", 1000)
        .filter((e) => e.value === "owner").length;
}

// A personal account's id IS its owner's hash, so it has a member row keyed by
// the aid itself; a team account (aid = sha256(uuid)) never does.
function isPersonalAccount(aid) { return roleInAccount(aid, aid) === "owner"; }

// Backfill instance→owner pointers for an account so a freshly-added member can
// reach existing tenants even if the owner hasn't logged in since teams shipped.
function backfillAccountInstances(aid) {
    for (const id of ownedInstances(aid))
        if (kv.get("instance/" + id + "/owner") === null)
            kv.set("instance/" + id + "/owner", aid);
}

// Team (non-personal) accounts this user owns — counted against MAX_TEAM_ACCOUNTS.
function ownedTeamAccountCount(userHash) {
    return accountsForUser(userHash)
        .filter((aid) => aid !== userHash && roleInAccount(aid, userHash) === "owner").length;
}

function accountName(aid) {
    const meta = kv.get("account/" + aid + "/meta");
    if (meta) { try { return JSON.parse(meta).name || null; } catch (_) {} }
    return null;
}

// ── Team account endpoints ──────────────────────────────────────────
// Routed by the ROUTES table (below) + gated by routeAuthz before invocation:
// createAccount/acceptInvite/leaveAccount are "authed" (own checks inside);
// invite/remove/revoke/setRole are "accountOwner"; listMembers is
// "accountMember". `caller` is the OIDC sub's hash. See the teams plan for the
// schema.

// Create a new team (billing) account; caller becomes its owner. Capped per user.
export function createAccount(name) {
    const a = request.auth || {};
    if (!a.sub) return jsonError(401, "unauthenticated");
    const nm = String(name == null ? "" : name).trim();
    if (nm.length === 0 || nm.length > 64) return jsonError(400, "invalid name");
    const caller = accountHashFor(a.sub);
    backfillSelf(caller, a.sub);
    if (!a.is_root && ownedTeamAccountCount(caller) >= MAX_TEAM_ACCOUNTS) {
        response.status = 403;
        return { error: "team_limit_reached", limit: MAX_TEAM_ACCOUNTS };
    }
    const aid = crypto.sha256(crypto.randomUUID()); // unguessable + replay-safe
    kv.set("account/" + aid + "/members/" + caller, "owner");
    kv.set("user/" + caller + "/accounts/" + aid, "owner");
    kv.set("account/" + aid + "/email/" + caller, a.sub);
    kv.set("account/" + aid + "/plan", "free");
    kv.set("account/" + aid + "/meta", JSON.stringify({ name: nm, created_ms: Date.now() }));
    response.status = 201;
    return { ok: true, aid: aid, name: nm };
}

// Promote/demote a member (ownership transfer). Owner-only; last-owner-guarded.
export function setMemberRole(aid, memberHash, role) {
    if (role !== "owner" && role !== "member") return jsonError(400, "invalid role");
    if (isPersonalAccount(aid)) return jsonError(400, "cannot change roles on a personal account");
    const cur = roleInAccount(aid, memberHash);
    if (cur !== "owner" && cur !== "member") return jsonError(404, "not a member");
    if (cur === "owner" && role === "member" && ownerCount(aid) <= 1)
        return jsonError(409, "last_owner");
    kv.set("account/" + aid + "/members/" + memberHash, role);
    kv.set("user/" + memberHash + "/accounts/" + aid, role);
    response.status = 200;
    return { ok: true, aid: aid, member: memberHash, role: role };
}

// Invite by email (tokened magic-link). `addr` is NOT named `email` on purpose —
// a local `email` would shadow the global `email` API and break `email.send`.
export function inviteMember(aid, addr) {
    const a = request.auth || {};
    const caller = accountHashFor(a.sub);
    const to = String(addr == null ? "" : addr).trim().toLowerCase();
    if (!to || to.indexOf("@") < 1) return jsonError(400, "invalid email");
    const h = userHashFor(to);
    if (isActiveMember(aid, h)) return jsonError(409, "already_member");
    // Re-invite: drop any prior pending token for this email, then mint fresh.
    const prev = kv.get("account/" + aid + "/pending/" + h);
    if (prev) { try { kv.delete("invite/" + JSON.parse(prev).tokenHash); } catch (_) {} }
    const rawToken = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = crypto.sha256(rawToken); // sha256-at-rest: leaked kv ≠ live tokens
    const exp_ms = Date.now() + INVITE_TTL_MS;
    kv.set("invite/" + tokenHash, JSON.stringify({
        aid: aid, emailHash: h, email: to, role: "member", exp_ms: exp_ms, invited_by: caller }));
    kv.set("account/" + aid + "/pending/" + h, JSON.stringify({
        email: to, tokenHash: tokenHash, role: "member", invited_by: caller,
        invited_ms: Date.now(), exp_ms: exp_ms }));
    backfillAccountInstances(aid);
    // The rows above are the source of truth; the email is a re-sendable nudge.
    const acceptUrl = "https://" + request.host + "/#/invite/" + rawToken;
    const resendKey = kv.get("resend_key");
    if (resendKey) {
        email.send({
            key: resendKey,
            from: kv.get("platform_email_from") || "team@" + request.host,
            to: to,
            subject: (accountName(aid) || "A rewind team") + " invited you",
            text: "You've been invited to a team on rewind.\n\nSign in with this "
                + "email, then accept:\n" + acceptUrl + "\n\nThis invite expires in 7 days.",
        });
        response.status = 200;
        return { ok: true, email: to };
    }
    response.status = 200;
    return { ok: true, email: to, accept_url: acceptUrl }; // dev/test seam (no Resend key)
}

// Accept an invite. The token finds the invite; acceptance is BOUND to the
// invited email — the logged-in sub must hash to the invited address.
export function acceptInvite(token) {
    const a = request.auth || {};
    if (!a.sub) return jsonError(401, "unauthenticated");
    if (typeof token !== "string" || !token) return jsonError(400, "missing token");
    const tokenHash = crypto.sha256(token);
    const raw = kv.get("invite/" + tokenHash);
    if (!raw) return jsonError(404, "invite not found");
    let inv; try { inv = JSON.parse(raw); } catch (_) { return jsonError(500, "bad invite"); }
    const caller = accountHashFor(a.sub);
    if (caller !== inv.emailHash)
        return jsonError(403, "sign in with the invited email address");
    if (Date.now() > inv.exp_ms) return jsonError(410, "invite expired"); // owner can re-send
    kv.set("account/" + inv.aid + "/members/" + caller, "member");
    kv.set("user/" + caller + "/accounts/" + inv.aid, "member");
    kv.set("account/" + inv.aid + "/email/" + caller, a.sub);
    kv.delete("invite/" + tokenHash);                          // single-use
    kv.delete("account/" + inv.aid + "/pending/" + inv.emailHash);
    response.status = 200;
    return { ok: true, aid: inv.aid, name: accountName(inv.aid) };
}

// List active members + pending invites of an account (member-visible).
export function listMembers(aid) {
    const mpre = "account/" + aid + "/members/";
    const members = kv.prefix(mpre, "", 1000).map((e) => {
        const h = e.key.slice(mpre.length);
        return { hash: h, role: e.value, email: kv.get("account/" + aid + "/email/" + h) || null };
    });
    const ppre = "account/" + aid + "/pending/";
    const pending = kv.prefix(ppre, "", 1000).map((e) => {
        let p = {}; try { p = JSON.parse(e.value); } catch (_) {}
        return { hash: e.key.slice(ppre.length), email: p.email || null,
                 role: p.role || "member", invited_ms: p.invited_ms || null,
                 exp_ms: p.exp_ms || null, status: "invited" };
    });
    return { aid: aid, name: accountName(aid), members: members, pending: pending };
}

// Remove an active member (owner-only; can't strand the last owner).
export function removeMember(aid, memberHash) {
    const cur = roleInAccount(aid, memberHash);
    if (cur !== "owner" && cur !== "member") return jsonError(404, "not a member");
    if (cur === "owner" && ownerCount(aid) <= 1) return jsonError(409, "last_owner");
    kv.delete("account/" + aid + "/members/" + memberHash);
    kv.delete("account/" + aid + "/email/" + memberHash);
    kv.delete("user/" + memberHash + "/accounts/" + aid);
    response.status = 204;
    return null;
}

// Cancel a pending invite (owner-only). Keyed by the invitee's email hash.
export function revokeInvite(aid, emailHash) {
    const raw = kv.get("account/" + aid + "/pending/" + emailHash);
    if (!raw) return jsonError(404, "no pending invite");
    try { kv.delete("invite/" + JSON.parse(raw).tokenHash); } catch (_) {}
    kv.delete("account/" + aid + "/pending/" + emailHash);
    response.status = 204;
    return null;
}

// Leave a team account. Personal accounts are permanent; an owner must transfer
// ownership (setMemberRole) before leaving so the account never goes ownerless.
export function leaveAccount(aid) {
    const a = request.auth || {};
    if (!a.sub) return jsonError(401, "unauthenticated");
    const caller = accountHashFor(a.sub);
    if (aid === caller) return jsonError(400, "cannot leave your personal account");
    const cur = roleInAccount(aid, caller);
    if (cur !== "owner" && cur !== "member") return jsonError(404, "not a member");
    if (cur === "owner" && ownerCount(aid) <= 1)
        return jsonError(409, "last_owner");
    kv.delete("account/" + aid + "/members/" + caller);
    kv.delete("account/" + aid + "/email/" + caller);
    kv.delete("user/" + caller + "/accounts/" + aid);
    response.status = 204;
    return null;
}

// POST ?fn=provisionInstance, args [name, account?]. Identity is the
// OIDC-verified id_token `sub` the RP guard put on request.auth — NOT a
// client-supplied field (closes the old signup trust-the-body gap). Creates the
// tenant under `account` (defaults to the caller's personal account); any active
// member of that account may provision, counting against THAT account's plan.
// All account/* rows are __admin__-home kv.
export function provisionInstance(name, account) {
    const auth = request.auth;
    const sub = auth && auth.sub;
    if (!sub) return jsonError(401, "unauthenticated");
    if (!validId(name))   return jsonError(400, "invalid name");
    if (isReserved(name)) return jsonError(409, "name unavailable");
    if (platform.root.get("instance/" + name) !== null) {
        return jsonError(409, "name unavailable");
    }

    const caller = accountHashFor(sub);
    backfillSelf(caller, sub);
    const aid = (typeof account === "string" && account) ? account : caller;
    if (!isActiveMember(aid, caller)) {
        return jsonError(403, "not a member of that account");
    }
    const limits = planLimitsFor(aid);
    const owned = ownedInstances(aid);
    if (owned.length >= limits.max_instances) {
        response.status = 403;
        return {
            error: "account_limit_reached",
            limit: limits.max_instances,
            owned: owned.length,
        };
    }
    if (kv.get("account/" + aid + "/plan") === null) {
        kv.set("account/" + aid + "/plan", "free");
    }

    // platform.instances.create is idempotent (retry-safe).
    try { platform.instances.create(name); }
    catch (e) {
        response.status = 500;
        return { error: "create failed: " + (e && e.message) };
    }
    // Starter content best-effort — the account is usable without it
    // and the customer can push their own code via the files API.
    try { platform.instances.deployStarter(name); } catch (_) {}

    kv.set("account/" + aid + "/instances/" + name, "");
    kv.set("instance/" + name + "/owner", aid); // reverse pointer for canAccess
    response.status = 201;
    return { ok: true, name: name, account: aid };
}

// GET /v1/session — whoami. request.auth = {sub,is_root} (set by the RP guard in
// _middlewares). Returns the caller's accounts (personal + teams) with role +
// instances; `active_account` is a UI default (the personal account). `owned` is
// kept (personal-account instances) for back-compat with older SPA builds.
function handleSession() {
    const a = request.auth || {};
    if (!a.sub) return { is_root: !!a.is_root, sub: null, accounts: [], active_account: null, owned: [] };
    const h = accountHashFor(a.sub);
    backfillSelf(h, a.sub);
    const pre = "user/" + h + "/accounts/";
    const accounts = kv.prefix(pre, "", 1000).map((e) => {
        const aid = e.key.slice(pre.length);
        return { aid: aid, role: e.value, is_personal: aid === h,
                 name: accountName(aid), instances: ownedInstances(aid) };
    });
    const personal = accounts.find((x) => x.is_personal) || accounts[0] || null;
    return {
        is_root: !!a.is_root, sub: a.sub,
        accounts: accounts,
        active_account: personal ? personal.aid : h,
        owned: personal ? personal.instances : [],
    };
}

// ── Log query chokepoint (step3-auth-plan.md A5) ────────────────────
//
// The dashboard reads a tenant's request logs THROUGH the admin app, not
// by holding a services token in the browser. The admin issues a buffered
// `on.fetch` at the privileged `rewind-logs.internal` door: the worker
// (only for `__admin__`) mints a tenant-scoped `logs-read` capability and
// the log-server verifies cap+tenant (`standalone.zig`, A4). So the token
// never enters JS/the browser, and the read is confined to one tenant.
//
// Cross-tenant read is operator-only for now (is_root); per-owner scoping
// (a customer reading their own instance's logs) is a follow-up that reuses
// `ownedInstances`. The result comes back in `onFetchResult` (the buffered
// on.fetch convention) and is relayed verbatim.
const LOG_DOOR = "http://rewind-logs.internal/v1/";

function handleLogQuery(path, qs) {
    const auth = request.auth || {};
    if (!auth.sub) return jsonError(401, "unauthenticated");
    if (!auth.is_root) return jsonError(403, "operator only");
    // path = /v1/logs/{tenant}/{list|count|show/{id}}
    const rest = path.slice("/v1/logs/".length);
    const slash = rest.indexOf("/");
    if (slash < 1) return jsonError(400, "bad log path");
    const tenant = rest.slice(0, slash);
    const sub = rest.slice(slash + 1);
    if (!validId(tenant)) return jsonError(400, "invalid tenant");
    if (sub !== "list" && sub !== "count" && !sub.startsWith("show/")) {
        return jsonError(404, "no such log route");
    }
    on.fetch(LOG_DOOR + tenant + "/" + sub + (qs ? "?" + qs : ""));
    return next();
}

// ── Control-plane chokepoint (step3-auth-plan.md B4) ────────────────
//
// Operators drive CP control ops — provision / move / host / plan —
// through the dashboard, NOT by holding the move-secret on a shell. The
// admin issues a buffered `on.fetch` at the privileged `rewind-cp.internal`
// door; the worker (only for `__admin__`) attaches the move-secret and
// rewrites to the CP. So no CP secret enters the browser/operator shell.
// Operator-only (is_root). The result rides `onFetchResult` (shared with the
// log chokepoint — both just relay the upstream verbatim).
const CP_DOOR = "http://rewind-cp.internal/_control/";
// CP read surface (GET _cp/route?host= / _cp/plan?tenant=) — the cluster page
// reads placement + plan through the same door (the worker attaches the
// move-secret). Operator-only, like the control ops.
const CP_READ = "http://rewind-cp.internal/_cp/";

function handleCpOp(cpPath, body) {
    const auth = request.auth || {};
    if (!auth.sub) return jsonError(401, "unauthenticated");
    if (!auth.is_root) return jsonError(403, "operator only");
    on.fetch(CP_DOOR + cpPath, {
        method: "POST",
        body: body,
        headers: { "content-type": "application/json" },
    });
    return next();
}

// GET cluster-status reads (operator-only): /v1/cp/route?host=H and
// /v1/cp/plan?tenant=T → the CP _cp/* read surface via the door. Powers the
// #/cluster operator page's placement/plan lookups (the GUI twin of
// `rewind-ops status`).
function handleCpRead(cpSub, qs) {
    const auth = request.auth || {};
    if (!auth.sub) return jsonError(401, "unauthenticated");
    if (!auth.is_root) return jsonError(403, "operator only");
    on.fetch(CP_READ + cpSub + (qs ? "?" + qs : ""));
    return next();
}

// Buffered on.fetch result for the log + CP chokepoints — relay the upstream
// status + body back to the dashboard. A door/upstream failure (e.g. an expired
// cap, or the CP unreachable) surfaces as 502.
export function onFetchResult() {
    response.headers = { "content-type": "application/json" };
    if (request.ok) {
        response.status = request.status;
        return new TextDecoder().decode(request.body || new Uint8Array());
    }
    // Relay the real upstream status when the door returned one — a CP 409
    // (provision: already placed, idempotent) or 421/503 (leader transient)
    // must reach the CLI so it can act on it (continue / retry) instead of
    // being flattened. Only a genuine door/transport failure (no upstream
    // status) becomes 502. The dashboard already treats any non-2xx as an
    // error (api.js throws ApiError on res.status), so this is strictly more
    // informative for both callers.
    if (request.status && request.status >= 400) {
        response.status = request.status;
        return new TextDecoder().decode(request.body || new Uint8Array());
    }
    response.status = 502;
    return JSON.stringify({ error: "internal door fetch failed",
                            status: request.status || 0 });
}

// ── Deploy surface — per-file WORKSPACE deploy ──────────────────────
//
// Files are uploaded ONE AT A TIME into a durable per-tenant workspace
// (`scope(t).kv` `_workspace/{path}` → the staged entry; bytes are
// content-addressed in S3 via blob.put/compile), then a release is CUT from
// whatever's in the workspace (stampManifest). This replaces the old single
// mega-POST, which base64-buffered the whole bundle in the JS heap and hit
// QuickJS's per-context memory limit (InternalError: out of memory) on any
// real static-bearing bundle. Per-file keeps each request small.
//
// Authz (each op): an operator (is_root — root token via _middlewares M2M, or
// an operator OIDC session) may deploy any tenant; a customer session may
// deploy ONLY a tenant they own. Does NOT activate — that's publishRelease.
//
// Wire (POST):
//   /v1/deploy/reset {tenant}                             → clear workspace
//   /v1/deploy/file  {tenant, path, kind, source | b64,
//                     content_type?}                      → stage one file
//   /v1/deploy/cut   {tenant}                             → {ok, dep_id}
const WS = "_workspace/";

// Parse + ownership-gate a deploy op. Returns the body on success, or null
// after stamping the error response.
function deployGate(body) {
    const auth = request.auth || {};
    let b;
    try { b = JSON.parse(body); } catch (e) { jsonError(400, "expected JSON body"); return null; }
    if (!validId(b.tenant)) { jsonError(400, "invalid tenant"); return null; }
    if (!auth.is_root) {
        if (!auth.sub) { jsonError(401, "unauthenticated"); return null; }
        if (!canAccess(accountHashFor(auth.sub), b.tenant)) {
            jsonError(403, "not your instance"); return null;
        }
    }
    return b;
}

function handleWsReset(body) {
    const b = deployGate(body); if (!b) return null;
    const sk = platform.scope(b.tenant).kv;
    const rows = sk.prefix(WS, "", 1000);
    for (let i = 0; i < rows.length; i++) sk.delete(rows[i].key);
    return { ok: true, cleared: rows.length };
}

function handleWsFile(body) {
    const b = deployGate(body); if (!b) return null;
    if (!b.path) return jsonError(400, "path required");
    // Statics stream straight to S3 via PUT /v1/upload (scope(t).blob.receive),
    // which records their own workspace entry — only handlers come through here.
    if (b.kind !== "handler")
        return jsonError(400, "kind must be 'handler' (statics stream via PUT /v1/upload)");
    platform.compile([{ path: b.path, source: b.source || "" }], {
        scope: b.tenant, name: "onFileStaged",
        ctx: { target: b.tenant, path: b.path, content_type: b.content_type || "" },
    });
    return next();
}

// compile bound-resume (continuation — skips _middlewares) → record the entry.
export function onFileStaged() {
    const ctx = request.ctx;
    if (!ctx || !ctx.ok) {
        response.status = 500;
        return JSON.stringify({ stage: "compile", ctx: ctx || null });
    }
    const app = ctx.app || {};
    const r = ctx.results[0];
    platform.scope(app.target).kv.set(WS + app.path, JSON.stringify({
        kind: "handler", content_type: app.content_type || "",
        source_hex: r.source_hex, bytecode_hex: r.bytecode_hex }));
    response.status = 200;
    return JSON.stringify({ ok: true, path: app.path, hash: r.source_hex });
}

function handleWsCut(body) {
    const b = deployGate(body); if (!b) return null;
    const rows = platform.scope(b.tenant).kv.prefix(WS, "", 1000);
    if (rows.length === 0) return jsonError(400, "workspace empty — nothing to cut");
    const entries = rows.map(function (row) {
        const e = JSON.parse(row.value);
        return { path: row.key.slice(WS.length), kind: e.kind,
                 content_type: e.content_type || "",
                 source_hex: e.source_hex, bytecode_hex: e.bytecode_hex || "" };
    });
    platform.scope(b.tenant).deploy.stampManifest(entries, { name: "onCut" });
    return next();
}

// stampManifest barrier resume — the cut deployment is durable here.
export function onCut() {
    response.status = 200;
    response.headers = { "content-type": "application/json" };
    return JSON.stringify(request.ctx); // { ok, dep_id }
}

// ── Source read (cross-tenant read door) ────────────────────────────
//
// Composes a deployment's handler sources from the general cross-tenant read
// primitives (`platform.scope(t).deploy.readManifest` + `scope(t).blob.get`) —
// the engine just signs the S3 reads; the assembly is JS. Powers the Code
// tab's edit-existing flow + the replay bundle's module sources. Because rove
// has no suspended await, the per-handler source reads are threaded
// sequentially through the fetch `ctx` across re-entries (manifest → source 0
// → source 1 → … → respond). Handler count is small (a deployment's .mjs
// files), so the O(N) round trips are cheap.
//
// GET /v1/sources/{tenant}/{dep_hex|current}. Authz mirrors deploy/release:
// operator (is_root) any tenant; a customer only their own.
function handleReadSources(tenant, depArg) {
    const auth = request.auth || {};
    if (!auth.is_root && !auth.sub) return jsonError(401, "unauthenticated");
    if (!validId(tenant)) return jsonError(400, "invalid tenant");
    if (!auth.is_root && !canAccess(accountHashFor(auth.sub), tenant)) {
        return jsonError(403, "not your instance");
    }
    let dep = depArg;
    if (dep === "current") {
        let cur;
        try { cur = platform.scope(tenant).kv.get("_deploy/current"); }
        catch (e) { return jsonError(404, "instance not found"); }
        if (!cur) return jsonError(404, "no current deployment");
        dep = cur; // stored as hex
    }
    if (!/^[0-9a-fA-F]{1,16}$/.test(dep)) return jsonError(400, "bad dep_id");
    platform.scope(tenant).deploy.readManifest(dep,
        { name: "onManifest", ctx: { tenant: tenant, dep: dep } });
    return next();
}

// Read-door continuation: the manifest JSON arrives on request.body. Parse it,
// then kick off the sequential handler-source reads (or finish if there are
// none).
export function onManifest() {
    const ctx = request.ctx || {};
    if (!request.ok) {
        response.headers = { "content-type": "application/json" };
        response.status = request.status === 404 ? 404 : 502;
        return JSON.stringify({ error: "manifest read failed", status: request.status || 0 });
    }
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(request.body || new Uint8Array())); }
    catch (e) { response.status = 502; return JSON.stringify({ error: "manifest parse failed" }); }
    // manifest_json stores the source/content hash under "hash".
    const entries = (manifest.entries || []).map((e) => ({
        path: e.path, kind: e.kind, content_type: e.content_type, hash: e.hash,
    }));
    const handlers = entries.filter((e) => e.kind === "handler");
    if (handlers.length === 0) return finishSources(ctx.dep, entries, []);
    platform.scope(ctx.tenant).blob.get(handlers[0].hash, {
        name: "onModuleSource",
        ctx: { tenant: ctx.tenant, dep: ctx.dep, entries: entries, idx: 0, acc: [] },
    });
    return next();
}

// Read-door continuation: one handler's source bytes arrive on request.body.
// Accumulate, then either read the next handler or assemble the response.
export function onModuleSource() {
    const ctx = request.ctx || {};
    const handlers = (ctx.entries || []).filter((e) => e.kind === "handler");
    const src = request.ok
        ? new TextDecoder().decode(request.body || new Uint8Array()) : null;
    const acc = ctx.acc.concat([{
        path: handlers[ctx.idx].path, source: src, missing: !request.ok,
    }]);
    const nextIdx = ctx.idx + 1;
    if (nextIdx < handlers.length) {
        platform.scope(ctx.tenant).blob.get(handlers[nextIdx].hash, {
            name: "onModuleSource",
            ctx: { tenant: ctx.tenant, dep: ctx.dep, entries: ctx.entries, idx: nextIdx, acc: acc },
        });
        return next();
    }
    return finishSources(ctx.dep, ctx.entries, acc);
}

// Merge handler sources into the manifest entries + respond (releases the held
// chain). Handlers carry `source` (or `missing:true` if the blob read failed);
// statics carry metadata only.
function finishSources(dep, entries, sources) {
    const srcByPath = {};
    for (const s of sources) srcByPath[s.path] = s;
    const out = entries.map((e) => {
        const r = { path: e.path, kind: e.kind, content_type: e.content_type, source_hex: e.hash };
        if (e.kind === "handler") {
            const s = srcByPath[e.path];
            if (s && s.source != null) r.source = s.source; else r.missing = true;
        }
        return r;
    });
    response.status = 200;
    response.headers = { "content-type": "application/json" };
    return JSON.stringify({ ok: true, dep_id: dep, entries: out });
}

// ── Deployment history (deployments list + rollback support) ────────
//
// Lists a tenant's release history from the per-tenant `_release/{ts_ms:020}` →
// `{dep_id:016x}` log (worker_dispatch stamps one on every release) plus the
// live pointer `_deploy/current`. Composable — reads via `platform.scope(t).kv`,
// no engine change (rewind-cli-plan §2 "deployments/rollback were blocked: no
// read endpoint"). Powers `rewind deployments <t>`; `rewind rollback` is just a
// publishRelease at an older dep_id. Authz mirrors deploy/release: operator
// (is_root) any tenant; a customer only their own.
function handleHistory(tenant) {
    const auth = request.auth || {};
    if (!auth.sub) return jsonError(401, "unauthenticated");
    if (!validId(tenant)) return jsonError(400, "invalid tenant");
    if (!auth.is_root &&
        ownedInstances(accountHashFor(auth.sub)).indexOf(tenant) === -1) {
        return jsonError(403, "not your instance");
    }
    const sk = platform.scope(tenant).kv;
    let curHex;
    try { curHex = sk.get("_deploy/current"); }
    catch (e) { return jsonError(404, "instance not found"); }
    // `_release/{ts_ms:020}` keys are lex-ascending by timestamp; reverse for
    // newest-first. Release cadence is low, so a 1000-row cap is generous.
    const rows = sk.prefix("_release/", "", 1000);
    const releases = rows.map(function (row) {
        const depHex = row.value;
        return {
            ts_ms: parseInt(row.key.slice("_release/".length), 10),
            dep_id: parseInt(depHex, 16),
            dep_hex: depHex,
            live: !!curHex && depHex === curHex,
        };
    }).reverse();
    return {
        tenant: tenant,
        current: curHex ? parseInt(curHex, 16) : null,
        current_hex: curHex || null,
        releases: releases,
    };
}

// ── REST router ─────────────────────────────────────────────────────
//
// One declarative table IS the whole admin surface: METHOD + path pattern →
// authz class → a thunk that pulls args from the matched params/query/body and
// calls the (unchanged) handler. This replaces the old fn-RPC dispatch AND the
// path if-ladder, so there is a single router and a single fail-closed gate.
//
// Patterns: `:name` captures one segment; a trailing `*` captures the rest (the
// handler re-parses, e.g. the logs path). Authz classes (is_root bypasses all;
// `_middlewares` runs its OIDC guard first, so anything but `open`/M2M already
// carries request.auth):
//   open          no extra gate — pre-auth/self-gating (session, logout, /_rp/*)
//   authed        any logged-in session
//   root          operator-only
//   tenant/Read/Write  params.id is an instance → canAccess(caller, id)
//   accountOwner  params.aid → caller is its owner
//   accountMember params.aid → caller is an active member
//   self          the handler gates internally (deploy/logs/cp/sources)
const ROUTES = [
    // session / auth handshake
    ["GET",    "/v1/session",                   "open",          (c) => handleSession()],
    ["POST",   "/v1/logout",                    "open",          (c) => oidc.rp("default").logout()],
    ["POST",   "/v1/cli/exchange",              "open",          (c) => oidc.rp("default").exchangeToken(c.body.id_token)],
    ["GET",    "/_rp/login",                    "open",          (c) => oidc.rp("default").beginLogin()],
    ["GET",    "/_rp/callback",                 "open",          (c) => oidc.rp("default").handleCallback()],
    ["GET",    "/_rp/poll",                     "open",          (c) => oidc.rp("default").pollStatus()],
    ["GET",    "/_rp/logout",                   "open",          (c) => oidc.rp("default").logoutRedirect()],
    // instances
    ["GET",    "/v1/instances",                 "authed",        (c) => listInstance()],
    ["POST",   "/v1/instances",                 "authed",        (c) => provisionInstance(c.body.name, c.body.account)],
    ["PUT",    "/v1/instances/:id",             "root",          (c) => createInstance(c.params.id)],  // operator raw
    ["GET",    "/v1/instances/:id",             "tenant",        (c) => getInstance(c.params.id)],
    ["DELETE", "/v1/instances/:id",             "tenant",        (c) => deleteInstance(c.params.id)],
    ["POST",   "/v1/instances/:id/release",     "tenant",        (c) => publishRelease(c.params.id, c.body.dep_id)],
    ["GET",    "/v1/instances/:id/kv",          "tenantRead",    (c) => kvRead(c.params.id, c.query)],
    ["PUT",    "/v1/instances/:id/kv",          "tenantWrite",   (c) => kvSet(c.params.id, c.body.key, c.body.value)],
    ["DELETE", "/v1/instances/:id/kv",          "tenantWrite",   (c) => kvDelete(c.params.id, c.query.key)],
    // domains (operator)
    ["GET",    "/v1/domains",                   "root",          (c) => listDomain()],
    ["PUT",    "/v1/domains/:host",             "root",          (c) => assignDomain(c.params.host, c.body.instance_id)],
    // accounts / teams
    ["POST",   "/v1/accounts",                  "authed",        (c) => createAccount(c.body.name)],
    ["GET",    "/v1/accounts/:aid/members",     "accountMember", (c) => listMembers(c.params.aid)],
    ["POST",   "/v1/accounts/:aid/invites",     "accountOwner",  (c) => inviteMember(c.params.aid, c.body.email)],
    ["DELETE", "/v1/accounts/:aid/invites/:eh", "accountOwner",  (c) => revokeInvite(c.params.aid, c.params.eh)],
    ["PUT",    "/v1/accounts/:aid/members/:h",  "accountOwner",  (c) => setMemberRole(c.params.aid, c.params.h, c.body.role)],
    ["DELETE", "/v1/accounts/:aid/members/:h",  "accountOwner",  (c) => removeMember(c.params.aid, c.params.h)],
    ["POST",   "/v1/accounts/:aid/leave",       "authed",        (c) => leaveAccount(c.params.aid)],
    ["POST",   "/v1/invites/accept",            "authed",        (c) => acceptInvite(c.body.token)],
    // deploy chokepoint (root-token M2M or session-ownership; deployGate self-gates)
    ["POST",   "/v1/deploy/reset",              "open",          (c) => handleWsReset(c.rawBody || "{}")],
    ["POST",   "/v1/deploy/file",               "open",          (c) => handleWsFile(c.rawBody || "{}")],
    ["POST",   "/v1/deploy/cut",                "open",          (c) => handleWsCut(c.rawBody || "{}")],
    // deployment history (handler enforces ownership) — /v1/history/{tenant}
    ["GET",    "/v1/history/:id",               "self",          (c) => handleHistory(c.params.id)],
    // log query door (handler enforces is_root) — /v1/logs/{tenant}/{list|count|show/{id}}
    ["GET",    "/v1/logs/*",                    "self",          (c) => handleLogQuery(c.path, c.qs)],
    // source read door (handler enforces canAccess) — /v1/sources/{tenant}/{dep}
    ["GET",    "/v1/sources/*",                 "self",          (c) => handleSourcesPath(c.path)],
    // CP control + read doors (handlers enforce is_root)
    ["POST",   "/v1/cp/:op",                    "self",          (c) => handleCpPost(c.params.op, c.rawBody)],
    ["GET",    "/v1/cp/:op",                    "self",          (c) => handleCpRead(c.params.op, c.qs)],
];

function parseQuery(qs) {
    const out = {};
    for (const part of (qs || "").split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const k = eq === -1 ? part : part.slice(0, eq);
        out[k] = eq === -1 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, "%20"));
    }
    return out;
}

function parseBody() {
    try { return JSON.parse(request.body || "{}") || {}; } catch (_) { return {}; }
}

// Match METHOD+path against ROUTES → {authz, thunk, params} or null. `:x`
// captures a segment; a trailing `*` matches the rest. Exact segment count
// otherwise. Specific routes precede wildcards in the table.
function matchRoute(method, path) {
    const segs = path.split("/");
    for (const route of ROUTES) {
        if (route[0] !== method) continue;
        const pat = route[1].split("/");
        const params = {};
        let ok = true, wild = false;
        for (let i = 0; i < pat.length; i++) {
            if (pat[i] === "*") { wild = true; break; }
            if (i >= segs.length) { ok = false; break; }
            if (pat[i].charCodeAt(0) === 58 /* ':' */) params[pat[i].slice(1)] = decodeURIComponent(segs[i]);
            else if (pat[i] !== segs[i]) { ok = false; break; }
        }
        if (!ok) continue;
        if (!wild && pat.length !== segs.length) continue;
        return { authz: route[2], thunk: route[3], params: params };
    }
    return null;
}

// The single fail-closed gate, keyed on the route's class + matched path params.
function routeAuthz(cls, params) {
    const a = request.auth || {};
    if (a.is_root) return null;
    if (cls === "open" || cls === "self") return null;
    if (cls === "root") return jsonError(403, "operator only");
    if (!a.sub) return jsonError(401, "unauthenticated");
    if (cls === "authed") return null;
    const caller = accountHashFor(a.sub);
    if (cls === "tenant" || cls === "tenantRead" || cls === "tenantWrite") {
        if (!validId(params.id)) return jsonError(400, "invalid id");
        return canAccess(caller, params.id) ? null : jsonError(403, "not your instance");
    }
    if (cls === "accountOwner") {
        return roleInAccount(params.aid, caller) === "owner" ? null : jsonError(403, "not an owner");
    }
    if (cls === "accountMember") {
        return isActiveMember(params.aid, caller) ? null : jsonError(403, "not a member");
    }
    return jsonError(403, "forbidden");
}

// `move` picks move-live when body.live; other CP ops forward the body verbatim
// through the rewind-cp.internal door (handleCpOp enforces is_root).
function handleCpPost(op, rawBody) {
    if (op === "move") {
        let live = false;
        try { live = !!JSON.parse(rawBody || "{}").live; } catch (_) {}
        return handleCpOp(live ? "move-live" : "move", rawBody || "{}");
    }
    return handleCpOp(op, rawBody || "{}");
}

// /v1/sources/{tenant}/{dep|current} — split the wildcard tail for the read door.
function handleSourcesPath(path) {
    const rest = path.slice("/v1/sources/".length);
    const slash = rest.indexOf("/");
    if (slash < 1) return jsonError(400, "bad sources path");
    return handleReadSources(rest.slice(0, slash), rest.slice(slash + 1));
}

// ── Single entry point (default export) ─────────────────────────────
// `_middlewares` runs its OIDC guard before this and sets request.auth (or 401s
// for non-pre-auth paths). The async completion modules (`_rp/complete.mjs`,
// `_rp/jwks.mjs`), the streamed `v1/upload` module, and the `on*` continuation
// exports above are invoked by callback dispatch — NOT routed here.
export default function() {
    const fullPath = request.path;
    const qi = fullPath.indexOf("?");
    const path = qi === -1 ? fullPath : fullPath.slice(0, qi);
    const qs = qi === -1 ? "" : fullPath.slice(qi + 1);
    const m = matchRoute(request.method, path);
    if (!m) { response.status = 404; return { error: "not found" }; }
    const denied = routeAuthz(m.authz, m.params);
    if (denied) return denied;
    return m.thunk({
        params: m.params, query: parseQuery(qs), qs: qs,
        body: parseBody(), rawBody: request.body || "", path: path,
    });
}
