// oidc/email are first-party @rewind packages (declared in manifest.json).
import oidc from "@rewind/oidc";
import email from "@rewind/email";
import stripe from "@rewind/stripe";
import schedule from "@rewind/schedule";
import exportLib from "@rewind/export";

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
    // `host` is what the control plane reported when the instance was placed
    // (recorded at provision time). Null for an instance provisioned before
    // that was recorded, or one the platform has no wildcard zone for — the UI
    // then shows no link rather than guessing a URL that may 404.
    return { id: id, host: kv.get("instance/" + id + "/host") };
}

export function createInstance(id) {
    if (!validId(id)) { response.status = 400; return { error: "invalid id" }; }
    platform.root.set("instance/" + id, "");
    response.status = 201;
    return { id: id };
}

// Deprovision an instance (rove#294). Authz is the route's `tenant` class:
// an operator, or an active member of the owning account (canAccess).
//
// Like provisioning, this goes through the CONTROL PLANE — the same reasoning
// as rove#291, in reverse. The old body did node-local bookkeeping only: it
// dropped this node's root marker and domain rows while the placement and the
// raft group survived on every node, so the tenant stayed routable and its name
// stayed taken. The CP owns existence; this handler owns authz and the
// account-level bookkeeping.
//
// DESTRUCTIVE and not undoable — the caller must confirm by sending the
// instance's own name (`confirm`), so a stray DELETE cannot destroy a tenant.
export function deleteInstance(id, confirm) {
    if (!validId(id)) { response.status = 400; return { error: "invalid id" }; }
    if (isPlatformInstance(id)) return jsonError(403, "that instance is part of the platform");
    // Type-the-name: the one guard between a mis-click and a destroyed tenant.
    if (confirm !== id) {
        return jsonError(400, "to delete this instance, confirm with its name");
    }
    after.fetch(CP_DOOR + "delete", {
        method: "POST",
        body: JSON.stringify({ tenant: id }),
        headers: { "content-type": "application/json" },
        on: "onDeprovisioned",
        ctx: { name: id },
    });
    return next();
}

// The CP's answer to `deleteInstance`. Ownership rows are cleared HERE — only
// once the tenant is actually gone — so a refused delete leaves the account
// exactly as it was.
export function onDeprovisioned() {
    const ctx = request.ctx || {};
    const id = ctx.name;
    if (!id) return jsonError(500, "delete continuation lost its context");

    // 204 = gone. 502 = unroutable but not fully torn down: the CP wants a
    // retry, and the tenant is already unreachable, so the account rows would
    // be wrong to keep — but they are also what a retry needs to re-authorize.
    // Keep them and report, so the customer can retry rather than owning an
    // instance they can no longer see.
    if (request.status !== 204) {
        let reason = "delete failed";
        try {
            const body = request.json;
            if (body && typeof body.error === "string") reason = body.error;
        } catch (_) { /* not JSON — keep the generic reason */ }
        response.status = (request.status >= 400 && request.status < 500)
            ? request.status : 502;
        return { error: reason };
    }

    // Free the plan slot + the ownership pointers. Idempotent: a retried
    // delete after a partial failure converges instead of 500ing.
    const aid = kv.get("instance/" + id + "/owner");
    if (aid !== null) {
        kv.delete("account/" + aid + "/instances/" + id);
        kv.delete("instance/" + id + "/owner");
    }
    kv.delete("instance/" + id + "/host");
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

// Instance-name rules (DNS-label spec + reserved platform labels) are NOT
// duplicated here. They live in the engine's `rove-instance-id` and are
// enforced by the CP at provisioning time, because a name must be one the
// worker's `{name}.{suffix}` wildcard can resolve — a copy in this file would
// drift from the thing that actually routes, and did.

// The platform's own singleton tenants. The CP refuses to delete these too
// (it is the authority); this is the local check so the dashboard can say why
// without a round trip, and so a UI never offers the button.
function isPlatformInstance(id) {
    return id === "__admin__" || id === "__auth__" || id === "__replay__";
}

function jsonError(status, message) {
    response.status = status;
    return { error: message };
}

// ── Account model ───────────────────────────────────────────────────
// The OIDC-verified id_token `sub` (email) is the account identity.
// account/{sha256(sub)}/plan stores the tier (written by the Stripe
// webhook, rove#311); account/{hash}/instances/{instance_id} marks
// ownership. Seed-manifest tenants stay outside the account model
// entirely (no account/* rows, no count toward any limit). All these
// rows live in __admin__-home kv.
//
// These are ACCOUNT-level allowances — how many tenants an account may
// create, how many team accounts a user may own — distinct from the
// per-tenant limits the CP plan blob carries (rate caps, kv/storage
// bytes, retention: src/plan/root.zig, pushed per tenant by rove#311).
// The two-plane split is deliberate (platform-accounts-model.md fork 2:
// per-tenant limits, never pooled account quotas) — do not collapse it.
//
// DOWNGRADE is creation-gated, never destructive: an account holding
// more instances than its (new, lower) tier allows keeps every one of
// them — the gate below only refuses NEW creation until it is back
// under the allowance. Anything stronger (suspension, reclaim) is the
// dunning policy, rove#313, not an allowance check. Pro/enterprise
// figures are placeholders until rove#314 sets the real ones.

const PLAN_LIMITS = {
    free:       { max_instances: 1,  max_team_accounts: 2 },
    pro:        { max_instances: 5,  max_team_accounts: 5 },
    enterprise: { max_instances: 25, max_team_accounts: 20 },
};
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
    // The deletion tombstone (rove#340): while a deletion is running or
    // frozen-failed, the lazy materialization below would RESURRECT the
    // half-erased account on the caller's next session read. Terminal
    // `done` falls through — that is the re-signup path.
    if (isDeleting(userHash)) return;
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

// Team (non-personal) accounts this user owns — counted against the caller's
// plan-gated max_team_accounts allowance.
function ownedTeamAccountCount(userHash) {
    return accountsForUser(userHash)
        .filter((aid) => aid !== userHash && roleInAccount(aid, userHash) === "owner").length;
}

function accountName(aid) {
    const meta = kv.get("account/" + aid + "/meta");
    if (meta) { try { return JSON.parse(meta).name || null; } catch (_) {} }
    return null;
}

// ── Account deletion (rove#340) ─────────────────────────────────────
// Deletion is a DURABLE JOB in __admin__'s own kv, the `__system/export_run`
// discipline: the marker IS the job, every activation re-arms a watchdog
// before doing work, and every step is idempotent under at-least-once
// firing. Rows:
//
//   acctdel/{aid}          → {state: "running"|"failed"|"done",
//                             phase: "billing"|"instances"|"rows"|"idp",
//                             is_team, email, requested_by, started_ms,
//                             updated_ms, finished_ms?, error?,
//                             cursor?, idp_step?, idp_cursor?}
//   acctdel/{aid}/inst/{t} → "pending" | "gone" | "failed:{status}"
//
// Phases: billing (Stripe cancel-NOW) → instances (one durable CP delete
// per owned tenant) → rows (page-erase account/{aid}/* + every reverse
// index) → idp (personal only: sweep the caller's identity rows out of
// __auth__ and their sessions out of _rp/sess/) → done.
//
// The marker doubles as the TOMBSTONE. Non-terminal blocks backfillSelf —
// the lazy personal-account materialization would otherwise resurrect a
// half-erased account on the caller's next GET /v1/session — plus session
// materialization, provisioning, team creation, invite acceptance and
// deploys. Terminal `done` blocks nothing: a returning user's next login
// materializes a fresh, empty personal account under the same hash, which
// IS the re-signup path. `failed` keeps the account frozen until an
// operator retries (GET /v1/deletions + POST /v1/deletions/{aid}/retry) —
// half-erased state must never be user-visible or user-mutable.
//
// Plain `acctdel/` (no leading underscore): `_`-prefixes are reserved to
// platform shims (rove-reserved's blanket rule refuses them at kv.set) and
// this is the admin APP's own schema, like `account/` and `instance/`.

const ACCTDEL = "acctdel/";
const ACCTDEL_WATCHDOG_S = 60;

function acctdelMarker(aid) {
    const raw = kv.get(ACCTDEL + aid);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

// Non-terminal marker = the tombstone. `done` deliberately does not block.
function isDeleting(aid) {
    const m = acctdelMarker(aid);
    return m !== null && m.state !== "done";
}

function acctdelWrite(aid, m) {
    m.updated_ms = Date.now();
    kv.set(ACCTDEL + aid, JSON.stringify(m));
}

// Keyed on the marker, so a re-arm MOVES the one watchdog entry rather
// than accumulating one per attempt (the webhook_fire discipline).
function acctdelArm(aid, inSpec) {
    schedule({ in: inSpec }, "index.mjs.acctdelWake", { aid: aid },
             { key: ACCTDEL + aid });
}

function acctdelCancelWatchdog(aid) {
    // A keyed schedule's id is derived from the key (the schedule
    // contract), so the cancel needs no stored id.
    schedule.cancel(crypto.sha256b64url(ACCTDEL + aid));
}

// Teams the caller is the SOLE owner of — the set that blocks personal
// deletion. Cascade-deleting a team destroys other members' instances,
// which a personal typed-confirm cannot authorize; the established
// `last_owner` guard semantics (leaveAccount) applied to deletion.
function soleOwnerTeams(caller) {
    const out = [];
    for (const aid of accountsForUser(caller)) {
        if (aid === caller) continue;
        if (roleInAccount(aid, caller) === "owner" && ownerCount(aid) <= 1)
            out.push({ aid: aid, name: accountName(aid) });
    }
    return out;
}

// ── Billing state (rove#308) ────────────────────────────────────────
// The subscription graph lives HERE, in the dashboard tenant's own kv,
// hanging off the account rows — not in Stripe. Stripe is the payment
// rail; the account graph is ours, which is what kills webhook-sync
// drift (docs/strategy/platform-accounts-model.md; src/plan/root.zig:
// "rove only ENFORCES tiers — setting one is the product layer's job").
//
// Rows (all __admin__-home kv):
//   account/{aid}/billing/customer      Stripe customer id (cus_…)
//   account/{aid}/billing/subscription  subscription id (sub_…)
//   account/{aid}/billing/status        Stripe subscription status VERBATIM
//                                       (active/past_due/canceled/…) — no
//                                       local vocabulary to drift from theirs
//   account/{aid}/billing/period_end    current_period_end, ms epoch
//   billing/customer/{cus_id} → aid     reverse index, so a webhook resolves
//                                       the account in O(1), never by scan
//
// The org/billing-account fork is already decided: one Account entity is
// both (splittable later). Nothing here introduces a second entity.

function billingFor(aid) {
    const g = (k) => kv.get("account/" + aid + "/billing/" + k);
    const pe = g("period_end");
    return {
        customer: g("customer"),
        subscription: g("subscription"),
        status: g("status"),
        period_end: pe === null ? null : Number(pe),
        cancel_at_period_end: g("cancel_at_period_end") === "1",
        plan: kv.get("account/" + aid + "/plan") || "free",
    };
}

// GET /v1/accounts/:aid/billing — accountMember (any active member may SEE
// billing state; mutating it is owner-only and arrives with the checkout
// flow). No Stripe call: this is a pure read of our own rows.
function getBilling(aid) {
    return billingFor(aid);
}

// GET /v1/accounts/:aid/export — the account-rows slice of the data export
// (rove#340): members, roles, pending invites, instances, billing meta, as
// one synchronous JSON attachment. Per-INSTANCE data (kv + code) has its own
// job-shaped export; account rows are small enough to hand over inline.
// Redactions are deliberate: invite tokenHashes never leave (a live invite
// token's hash is a credential-shaped secret), and the Stripe `item` si_ id +
// `last_event_ts` are internal plumbing — while customer/subscription ids
// appear on the customer's own Stripe receipts.
function accountExport(aid) {
    const members = kv.prefix("account/" + aid + "/members/", "", 1000).map((e) => ({
        email: kv.get("account/" + aid + "/email/" + e.key.slice(("account/" + aid + "/members/").length)),
        role: e.value,
    }));
    const pending = kv.prefix("account/" + aid + "/pending/", "", 1000).map((e) => {
        let p = {}; try { p = JSON.parse(e.value); } catch (_) {}
        return { email: p.email || null, role: p.role || "member",
                 invited_ms: p.invited_ms || null, exp_ms: p.exp_ms || null };
    });
    const instances = ownedInstances(aid).map((id) => ({
        id: id, host: kv.get("instance/" + id + "/host"),
    }));
    const b = billingFor(aid);
    let meta = null;
    const rawMeta = kv.get("account/" + aid + "/meta");
    if (rawMeta) { try { meta = JSON.parse(rawMeta); } catch (_) {} }
    response.headers = {
        "content-type": "application/json",
        "content-disposition": "attachment; filename=\"rewind-account-" +
            aid.slice(0, 8) + ".json\"",
    };
    return {
        aid: aid,
        name: accountName(aid),
        meta: meta,
        plan: b.plan,
        members: members,
        pending_invites: pending,
        instances: instances,
        billing: {
            customer: b.customer,
            subscription: b.subscription,
            status: b.status,
            period_end: b.period_end,
            cancel_at_period_end: b.cancel_at_period_end,
        },
        exported_at_ms: Date.now(),
    };
}

// ── Billing flow (rove#310) — subscribe / change / cancel ───────────
// The Elements flow, embedded: the browser mounts Stripe's Payment
// Element with a client_secret we relay and confirms DIRECTLY against
// Stripe — card data never reaches a request body here, so it can
// never reach a tape or a replay log. What DOES transit our response
// is the client_secret; that exposure is accepted deliberately
// (rove#307 option 1: one short-lived single-intent capability, in
// __admin__'s operator-only records; rove#559 is the durable fix).
//
// Subscribe is a HELD chain (the browser needs the secret in this
// response): customer-create hop → createIncomplete hop → respond.
// The customer→account link rows are written ONLY in the terminal
// hop — a kv write in a resume hop that issues another platform call
// drops that call (rove#344), so every intermediate hop carries its
// state in ctx and writes nothing.
//
// Change and cancel are DURABLE (webhook.send via the package): the
// caller needs no secret back, money-state must survive the response,
// and the plan itself only moves when Stripe's webhook lands (#311) —
// so the UI polls billing state rather than trusting the 200.
//
// Config comes seeded, never baked: stripe_key (sk_…), stripe_pk
// (publishable), stripe_price/{tier} (price ids), stripe_whsec.
// Missing config is a loud 503.

const BILLING_ACTIVE_STATUSES = { active: true, trialing: true, past_due: true, incomplete: true };

function billingConfigPk() {
    const pk = kv.get("stripe_pk");
    if (!pk) return jsonError(503, "billing not configured");
    return { publishable_key: pk };
}

function subscribeBilling(aid, tier) {
    if (typeof tier !== "string" || !SELLABLE_TIERS[tier])
        return jsonError(400, "unknown tier");
    const price = kv.get("stripe_price/" + tier);
    const apiKey = kv.get("stripe_key");
    if (!price || !apiKey) return jsonError(503, "billing not configured");
    const b = billingFor(aid);
    if (b.status !== null && BILLING_ACTIVE_STATUSES[b.status])
        return jsonError(409, "already subscribed — change the plan instead");
    const sk = stripe.client({ apiKey: apiKey });
    // The idempotency key is scoped by the PRIOR subscription (or "first"):
    // it must change when a previous attempt dies, or Stripe's 24h idempotent
    // replay hands the next subscribe the dead attempt's response — old
    // subscription, canceled payment intent, stale client_secret ("This
    // PaymentIntent's payment_method could not be updated… status of
    // canceled"). Keying on the prior sub id keeps double-submits of the SAME
    // attempt idempotent (both read the same prior state) while a new attempt
    // after cancellation/expiry gets a fresh key.
    const ctx = { aid: aid, tier: tier, price: price, cus: b.customer, link: false,
                  prev: b.subscription || "first" };
    if (b.customer === null) {
        // No Stripe customer yet: create one, then chain to the incomplete
        // subscription. The link rows are written in the TERMINAL hop.
        ctx.link = true;
        sk.customers.create(
            { email: (request.auth && request.auth.sub) || "", metadata: { aid: aid } },
            { on: "onBillingCustomer", ctx: ctx });
        return next();
    }
    issueIncompleteSubscription(sk, ctx);
    return next();
}

function issueIncompleteSubscription(sk, ctx) {
    sk.subscriptions.createIncomplete(
        { customer: ctx.cus, items: [{ price: ctx.price }],
          metadata: { tier: ctx.tier, aid: ctx.aid } },
        { on: "onBillingSubscription", ctx: ctx,
          idempotencyKey: "subinc-" + ctx.aid + "-" + ctx.tier + "-" + ctx.prev });
}

function stripeHopFailed(label) {
    if (request.status >= 200 && request.status < 300) return null;
    let msg = label + " failed";
    try { const e = request.json; if (e && e.error && e.error.message) msg = e.error.message; } catch (_) {}
    response.status = 502;
    return { error: msg, upstream: request.status || 0 };
}

// Customer created → chain the incomplete subscription. NO kv writes here:
// a write in this hop would drop the platform call it issues (rove#344).
export function onBillingCustomer() {
    const failed = stripeHopFailed("stripe customer create");
    if (failed) return failed;
    const ctx = request.ctx || {};
    const cus = request.json && request.json.id;
    if (typeof cus !== "string" || !cus) { response.status = 502; return { error: "no customer id" }; }
    ctx.cus = cus;
    issueIncompleteSubscription(stripe.client({ apiKey: kv.get("stripe_key") }), ctx);
    return next();
}

// Terminal hop: the incomplete subscription exists. Write everything —
// the rove#308 link rows (only now, never earlier in the chain), the
// subscription rows — and hand the browser the payment intent secret.
export function onBillingSubscription() {
    const failed = stripeHopFailed("stripe subscription create");
    if (failed) return failed;
    const ctx = request.ctx || {};
    const sub = request.json || {};
    if (ctx.link && ctx.cus) {
        kv.set("account/" + ctx.aid + "/billing/customer", ctx.cus);
        kv.set("billing/customer/" + ctx.cus, ctx.aid);
    }
    recordSubscription(ctx.aid, sub, "");
    const pi = sub.latest_invoice && sub.latest_invoice.payment_intent;
    const secret = pi && pi.client_secret;
    if (typeof secret !== "string" || !secret) { response.status = 502; return { error: "no payment intent" }; }
    // The client_secret transits this recorded response — accepted, rove#307.
    return { subscription: sub.id || null, status: sub.status || "incomplete", client_secret: secret };
}

function changeBilling(aid, tier) {
    if (typeof tier !== "string" || !SELLABLE_TIERS[tier])
        return jsonError(400, "unknown tier");
    const price = kv.get("stripe_price/" + tier);
    const apiKey = kv.get("stripe_key");
    if (!price || !apiKey) return jsonError(503, "billing not configured");
    const b = billingFor(aid);
    if (b.subscription === null) return jsonError(409, "no subscription");
    const item = kv.get("account/" + aid + "/billing/item");
    if (item === null) return jsonError(409, "no subscription item on file");
    // Durable: the plan row moves when the webhook lands (#311); metadata.tier
    // must move WITH the price or the webhook would re-apply the old tier.
    stripe.client({ apiKey: apiKey }).subscriptions.update(b.subscription, {
        items: [{ id: item, price: price }],
        metadata: { tier: tier, aid: aid },
        proration_behavior: "create_prorations",
    }, { idempotencyKey: "subchg-" + aid + "-" + tier });
    return { ok: true, pending: tier };
}

function cancelBilling(aid) {
    const apiKey = kv.get("stripe_key");
    if (!apiKey) return jsonError(503, "billing not configured");
    const b = billingFor(aid);
    if (b.subscription === null) return jsonError(409, "no subscription");
    // Period-end cancellation (rove#313): the customer paid through the
    // period, so service runs to what they paid for. Stripe then sends
    // customer.subscription.deleted at the boundary and the webhook (#311)
    // walks the plan to free. Immediate cancellation is deliberately NOT a
    // customer surface — it stays a support/operator action via Stripe.
    stripe.client({ apiKey: apiKey }).subscriptions.update(b.subscription,
        { cancel_at_period_end: true },
        { idempotencyKey: "subcxl-" + aid + "-" + b.subscription });
    return { ok: true, cancels_at: b.period_end };
}

// ── Stripe webhook (rove#309) ───────────────────────────────────────
// The ONLY unauthenticated write surface on the dashboard. Stripe posts
// with no session, so the route is on the middleware's PRE_AUTH list and
// the signature IS the authentication: stripe.verifyWebhook (double-HMAC
// compare + timestamp tolerance) runs before any other work, over the
// RAW body — never a reparsed one.
//
// Idempotency and ordering, both required because Stripe retries and
// delivery order is not causal order:
//   - billing/event/{evt_id} dedupes exact redelivery. The marker and
//     every other write here commit atomically WITH the response, so a
//     crash mid-handler loses the marker too and the retry reprocesses
//     from scratch — dedupe-then-process ordering cannot go wrong.
//   - account/{aid}/billing/last_event_ts refuses events OLDER than the
//     last applied one, reconciling from the event's own `created` +
//     object state rather than assuming arrival order.
//
// This handler issues NO outbound call and returns terminally, so the
// continuation-skips-middleware seam (Activation.isContinuation) has no
// resume path to re-enter the bypass. The plan push (rove#311) rides the
// same atomic commit as these rows — never a held upstream call.

function handleStripeWebhook(rawBody) {
    const secret = kv.get("stripe_whsec");
    if (!secret) return jsonError(503, "billing not configured");
    let event;
    try {
        event = stripe.verifyWebhook({
            secret: secret,
            header: request.headers["stripe-signature"] || "",
            body: rawBody,
        });
    } catch (_) {
        return jsonError(400, "bad signature");
    }

    // Dedupe on the event id — Stripe retries until it sees a 2xx.
    if (typeof event.id !== "string" || event.id.length === 0)
        return jsonError(400, "event has no id");
    if (kv.get("billing/event/" + event.id) !== null)
        return { received: true, duplicate: true };
    kv.set("billing/event/" + event.id, String(event.created || 0));

    // Everything that is not a subscription lifecycle event is acknowledged
    // and ignored — a 4xx would make Stripe retry events we never consume.
    const type = String(event.type || "");
    if (type.indexOf("customer.subscription.") !== 0) return { received: true };

    const sub = (event.data && event.data.object) || {};
    const cus = typeof sub.customer === "string" ? sub.customer : null;
    const aid = cus === null ? null : kv.get("billing/customer/" + cus);
    // A customer we never linked (test events, deleted accounts): ack, don't
    // error — otherwise Stripe retries forever on principle.
    if (!aid) return { received: true, ignored: "unknown customer" };

    // Out-of-order: an event older than the last applied one must not win.
    const tsKey = "account/" + aid + "/billing/last_event_ts";
    const created = Number(event.created || 0);
    if (created < Number(kv.get(tsKey) || 0)) return { received: true, stale: true };
    kv.set(tsKey, String(created));

    recordSubscription(aid, sub, type);
    applyPlanFromSubscription(aid, sub, type);
    return { received: true };
}

// ── Webhook → enforcement (rove#311) ────────────────────────────────
// Where money becomes limits. The tier rides the subscription's own
// metadata (stamped at checkout, rove#310) — the event is self-
// describing, so no price-id table to drift. Status → target plan:
//
//   active / trialing            → metadata.tier (pro|enterprise only —
//                                  an unknown tier changes NOTHING, it
//                                  cannot be guessed)
//   canceled / unpaid /
//   incomplete_expired / deleted → free
//   past_due / incomplete /
//   paused                       → unchanged (the grace window; the
//                                  dunning POLICY is rove#313's call,
//                                  so nothing here forecloses it)
//
// The push is per-tenant and must be convergent, not one-shot: each
// tenant's push is a DURABLE send (webhook.send → the CP door; the
// worker attaches the move-secret for __admin__, so this never rides
// the is_root /v1/cp route and customers cannot reach the plan verb)
// keyed `planpush-{tenant}` — the same key maps to the same marker, so
// a NEWER push for a tenant overwrites an undelivered older one instead
// of racing it, and retries re-read the newest body. And because the
// plan row + every push marker + the webhook response commit
// atomically, there is no partial state: either Stripe sees 200 and
// every push is durably owed, or the retry replays the whole event.
const SELLABLE_TIERS = { pro: true, enterprise: true };
const PLAN_DOWN_STATUSES = { canceled: true, unpaid: true, incomplete_expired: true };

function applyPlanFromSubscription(aid, sub, type) {
    const status = String(sub.status || "");
    let target = null;
    if (status === "active" || status === "trialing") {
        const tier = sub.metadata && sub.metadata.tier;
        if (typeof tier === "string" && SELLABLE_TIERS[tier]) target = tier;
    } else if (PLAN_DOWN_STATUSES[status] || type === "customer.subscription.deleted") {
        target = "free";
    }
    if (target === null) return;                       // grace / unknown: no change
    if (kv.get("account/" + aid + "/plan") === target) return;  // convergent no-op
    kv.set("account/" + aid + "/plan", target);
    const owned = ownedInstances(aid);
    for (let i = 0; i < owned.length; i++) pushPlanToTenant(owned[i], target);
}

function pushPlanToTenant(tenant, plan) {
    webhook.send(CP_DOOR + "plan", {
        body: JSON.stringify({ tenant: tenant, plan: plan }),
        headers: { "content-type": "application/json" },
        key: "planpush-" + tenant,
        maxAttempts: 8,
    });
}

// The rove#308 subscription writer — state comes from the event's OBJECT,
// verbatim. `customer.subscription.deleted` carries status "canceled" on the
// object; the fallback covers a malformed one so the row never goes empty on
// a deletion we did accept.
function recordSubscription(aid, sub, type) {
    const p = "account/" + aid + "/billing/";
    if (typeof sub.id === "string" && sub.id) kv.set(p + "subscription", sub.id);
    const status = (typeof sub.status === "string" && sub.status)
        ? sub.status
        : (type === "customer.subscription.deleted" ? "canceled" : null);
    if (status !== null) kv.set(p + "status", status);
    if (typeof sub.current_period_end === "number")
        kv.set(p + "period_end", String(sub.current_period_end * 1000));
    if (typeof sub.cancel_at_period_end === "boolean")
        kv.set(p + "cancel_at_period_end", sub.cancel_at_period_end ? "1" : "0");
    // The subscription ITEM id (si_…): a plan change updates the item, not the
    // subscription, so without this row `change` has nothing to address.
    const item = sub.items && sub.items.data && sub.items.data[0];
    if (item && typeof item.id === "string" && item.id) kv.set(p + "item", item.id);
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
    if (isDeleting(caller)) return jsonError(409, "account deletion in progress");
    backfillSelf(caller, a.sub);
    // Team-account allowance rides the caller's PERSONAL account's plan —
    // your own tier decides how many orgs you may own.
    const teamLimit = planLimitsFor(caller).max_team_accounts;
    if (!a.is_root && ownedTeamAccountCount(caller) >= teamLimit) {
        response.status = 403;
        return { error: "team_limit_reached", limit: teamLimit };
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
// a local `email` would shadow the imported `@rewind/email` binding and break
// `email.send`.
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
            apiKey: resendKey,
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
    // Neither side of a deletion accepts invites: not a caller whose own
    // account is being erased, not a team that is being torn down.
    if (isDeleting(caller) || isDeleting(inv.aid))
        return jsonError(409, "account deletion in progress");
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

// ── Account deletion entry points + job (rove#340) ──────────────────

// POST /v1/account/delete — delete the CALLER's personal account,
// immediately (no grace period; the typed confirm is the guard, exactly
// like deleteInstance's type-the-name). Route class `authed`; the aid is
// BOUND to the session — there is nothing in the request to confuse.
// A root M2M grant ({sub:null}) has no personal account and is refused.
export function requestAccountDeletion(confirm) {
    const a = request.auth || {};
    if (!a.sub) return jsonError(401, "unauthenticated");
    const caller = accountHashFor(a.sub);
    // Typed confirm = the account email, compared through the ONE
    // normalization point — " Email@X " confirms email@x.
    if (typeof confirm !== "string" || userHashFor(confirm) !== caller)
        return jsonError(400, "to delete your account, confirm with your account email");
    if (isDeleting(caller)) return jsonError(409, "deletion_in_progress");
    backfillSelf(caller, a.sub);
    const sole = soleOwnerTeams(caller);
    if (sole.length > 0) {
        // Refuse, never cascade: deleting a team destroys OTHER members'
        // instances. Transfer ownership or delete the team first.
        response.status = 409;
        return { error: "sole_owner_of_teams", teams: sole };
    }
    // Leave every team now (member or co-owner with co-owners) — the
    // leaveAccount row deletes, synchronously, so the job then only ever
    // touches this account's own rows.
    for (const aid of accountsForUser(caller)) {
        if (aid === caller) continue;
        kv.delete("account/" + aid + "/members/" + caller);
        kv.delete("account/" + aid + "/email/" + caller);
        kv.delete("user/" + caller + "/accounts/" + aid);
    }
    kv.set(ACCTDEL + caller, JSON.stringify({
        state: "running", phase: "billing", is_team: false,
        email: a.sub, requested_by: caller,
        started_ms: Date.now(), updated_ms: Date.now(),
    }));
    acctdelArm(caller, 0);
    response.status = 202;
    return { ok: true, deleting: true };
}

// DELETE /v1/accounts/:aid — delete a TEAM account. Route class
// `accountOwner`; the typed confirm is the TEAM NAME, because the owner
// is authorizing the destruction of every member's access and every
// team-owned instance — that is the point of the confirmation.
export function deleteTeamAccount(aid, confirm) {
    if (isPersonalAccount(aid))
        return jsonError(400, "delete your personal account via /v1/account/delete");
    const nm = accountName(aid);
    if (!nm || typeof confirm !== "string" || confirm !== nm)
        return jsonError(400, "to delete this team, confirm with its name");
    if (isDeleting(aid)) return jsonError(409, "deletion_in_progress");
    const a = request.auth || {};
    kv.set(ACCTDEL + aid, JSON.stringify({
        state: "running", phase: "billing", is_team: true,
        email: null, requested_by: a.sub ? accountHashFor(a.sub) : null,
        started_ms: Date.now(), updated_ms: Date.now(),
    }));
    acctdelArm(aid, 0);
    response.status = 202;
    return { ok: true, deleting: true, aid: aid };
}

// The job's single driver — a durable_wake continuation (middleware does
// not run; request.auth is absent by design). Everything it needs lives in
// the marker; every branch is idempotent under at-least-once firing.
export function acctdelWake() {
    const ctx = request.ctx || {};
    const aid = ctx.aid;
    if (typeof aid !== "string" || !aid) return { ok: true };
    const m = acctdelMarker(aid);
    // Absent or terminal: let the chain die — a terminal wake fires at
    // most once more (the already-armed watchdog) and does not re-arm.
    if (m === null || m.state !== "running") return { ok: true };
    // Re-arm FIRST (the webhook_fire discipline): this activation's
    // writeset deletes the fired `_sched/` entry, so a crash below must
    // still re-fire. Same key ⇒ the entry moves, never accumulates.
    acctdelArm(aid, ACCTDEL_WATCHDOG_S + "s");

    if (m.phase === "billing") {
        // Cancel NOW — deletion is immediate (rove#340), unlike the
        // customer-facing period-end cancel (rove#313's grace applies to
        // cancellation, not erasure). Durable + idempotency-keyed, so a
        // watchdog re-fire maps onto the same Stripe request. Fire and
        // forget: the eventual customer.subscription.deleted webhook
        // resolves billing/customer/{cus} — by then erased and acked as
        // unknown (the webhook's deleted-accounts arm), or it downgrades a
        // plan on instances this job is deleting anyway.
        const sub = kv.get("account/" + aid + "/billing/subscription");
        const apiKey = kv.get("stripe_key");
        if (sub !== null && apiKey) {
            stripe.client({ apiKey: apiKey }).subscriptions.cancel(sub, {
                idempotencyKey: "acctdel-cxl-" + aid + "-" + sub,
            });
        }
        m.phase = "instances";
        // Fall through: the instances phase issues its sends this same
        // activation — nothing to wait on between the two.
    }

    if (m.phase === "instances") {
        // One durable CP delete per owned instance (the pushPlanToTenant
        // composition: webhook.send at the CP door, the worker attaches the
        // move-secret). Idempotency-keyed per (account, tenant), so a
        // re-fire maps onto the same in-flight send instead of racing it.
        const owned = ownedInstances(aid);
        let pending = 0;
        const failed = [];
        for (const t of owned) {
            const ik = ACCTDEL + aid + "/inst/" + t;
            const cur = kv.get(ik);
            if (cur === null) {
                kv.set(ik, "pending");
                webhook.send(CP_DOOR + "delete", {
                    body: JSON.stringify({ tenant: t }),
                    headers: { "content-type": "application/json" },
                    key: "acctdel-del-" + aid + "-" + t,
                    maxAttempts: 8,
                    // A send's `on` dispatches the target MODULE's default
                    // export (cross-module continuation), so the callback
                    // has its own door module delegating back here.
                    on: "acctdel_result.mjs",
                    ctx: { aid: aid, tenant: t },
                });
                pending++;
            } else if (cur === "pending") {
                pending++;
            } else if (cur.indexOf("failed:") === 0) {
                failed.push(t + " (" + cur.slice("failed:".length) + ")");
            }
        }
        if (failed.length > 0) {
            // An instance the CP refuses terminally freezes the whole job
            // (state=failed) rather than erasing the rows a retry needs to
            // re-authorize — half-erased must never be the resting state.
            m.state = "failed";
            m.error = "instance delete failed: " + failed.join(", ");
            acctdelWrite(aid, m);
            acctdelCancelWatchdog(aid);
            return { ok: true };
        }
        if (pending > 0) {
            // Sends in flight; their terminal callbacks advance the phase.
            // The re-armed watchdog above covers a lost callback.
            acctdelWrite(aid, m);
            return { ok: true };
        }
        m.phase = "rows";
        m.cursor = "";
    }

    if (m.phase === "rows") {
        // Page-erase account/{aid}/*, harvesting each row's reverse index
        // BEFORE deleting it: members → user/{h}/accounts/{aid}, pending
        // invites → the global invite/{tokenHash}, the billing customer →
        // billing/customer/{cus}, straggler instance rows → their pointers.
        const pre = "account/" + aid + "/";
        const page = kv.prefix(pre, m.cursor || "", 1000);
        for (const e of page) {
            const rest = e.key.slice(pre.length);
            if (rest.indexOf("members/") === 0) {
                kv.delete("user/" + rest.slice("members/".length) + "/accounts/" + aid);
            } else if (rest.indexOf("pending/") === 0) {
                try { kv.delete("invite/" + JSON.parse(e.value).tokenHash); } catch (_) {}
            } else if (rest === "billing/customer") {
                kv.delete("billing/customer/" + e.value);
            } else if (rest.indexOf("instances/") === 0) {
                // Normally cleared by onAcctdelCpDelete; a legacy row with
                // no live tenant still needs its pointers dropped.
                const t = rest.slice("instances/".length);
                kv.delete("instance/" + t + "/owner");
                kv.delete("instance/" + t + "/host");
            }
            kv.delete(e.key);
        }
        if (page.length >= 1000) {
            m.cursor = page[page.length - 1].key;
            acctdelWrite(aid, m);
            acctdelArm(aid, 0); // full page — continue immediately
            return { ok: true };
        }
        if (m.is_team) return acctdelFinish(aid, m);
        m.phase = "idp";
        m.idp_step = 0;
        m.idp_cursor = "";
    }

    if (m.phase === "idp") return acctdelIdpStep(aid, m);
    // Unknown phase (a marker from a newer schema after a rollback):
    // freeze loudly rather than guess.
    m.state = "failed";
    m.error = "unknown phase " + m.phase;
    acctdelWrite(aid, m);
    acctdelCancelWatchdog(aid);
    return { ok: true };
}

// IdP erasure (personal accounts): sweep the user's identity out of
// __auth__ — sessions, live magic links, the send cooldown, and every
// token record carrying their sub — plus the dashboard's own _rp/sess/
// rows. All the token rows are keyed by OPAQUE TOKEN, not by user, so
// this is a prefix scan with a payload match, one bounded page per
// activation (cursor + step in the marker). Scan cost is bounded by
// historical traffic, not TTLs — `_oidc/session/` rows never expire
// (rove#594 is the GC); deletion pays that page walk once.
//
// The steps are (prefix, kv-home) pairs; `null` home = __admin__'s own kv.
const ACCTDEL_IDP_STEPS = [
    ["_rp/sess/", null],
    ["_oidc/session/", "__auth__"],
    ["_oidc/magic/", "__auth__"],
    ["_oidc/code/default/", "__auth__"],
    ["_oidc/at/default/", "__auth__"],
    ["_oidc/rt/default/", "__auth__"],
    ["_oidc/device/default/", "__auth__"],
    ["_oidc/device_user/default/", "__auth__"],
];

// A row belongs to the user when its JSON payload names them — `sub` for
// sessions/tokens, `email` for magic links. Unparseable rows are left
// alone: they are someone's live state until proven otherwise.
function acctdelRowMatches(value, addr) {
    try {
        const v = JSON.parse(value);
        return v !== null && (v.sub === addr || v.email === addr);
    } catch (_) { return false; }
}

function acctdelIdpStep(aid, m) {
    const addr = m.email;
    if (typeof addr !== "string" || !addr) return acctdelFinish(aid, m);
    const step = m.idp_step || 0;
    if (step >= ACCTDEL_IDP_STEPS.length) return acctdelFinish(aid, m);
    const prefix = ACCTDEL_IDP_STEPS[step][0];
    const home = ACCTDEL_IDP_STEPS[step][1];
    const store = home === null ? kv : platform.scope(home).kv;
    const page = store.prefix(prefix, m.idp_cursor || "", 1000);
    for (const e of page) {
        if (acctdelRowMatches(e.value, addr)) store.delete(e.key);
    }
    if (page.length >= 1000) {
        m.idp_cursor = page[page.length - 1].key;
    } else {
        m.idp_step = step + 1;
        m.idp_cursor = "";
        if (m.idp_step >= ACCTDEL_IDP_STEPS.length) {
            // Last direct-keyed row: the magic-link send cooldown.
            platform.scope("__auth__").kv.delete(
                "_oidc/magic_cooldown/" + crypto.sha256(addr));
            return acctdelFinish(aid, m);
        }
    }
    acctdelWrite(aid, m);
    acctdelArm(aid, 0); // more to sweep — continue immediately
    return { ok: true };
}

function acctdelFinish(aid, m) {
    // Drop the per-instance bookkeeping; the marker itself STAYS as the
    // audit tombstone (`done` blocks nothing — re-signup materializes a
    // fresh personal account lazily).
    const rows = kv.prefix(ACCTDEL + aid + "/inst/", "", 1000);
    for (const e of rows) kv.delete(e.key);
    m.state = "done";
    m.phase = "done";
    m.finished_ms = Date.now();
    acctdelWrite(aid, m);
    acctdelCancelWatchdog(aid);
    return { ok: true };
}

// Terminal result of one instance's durable CP delete (send_callback —
// fires ONCE, delivered or given-up after the retry budget). Dispatched
// through `acctdel_result.mjs` (webhook.send's `on` runs a module's
// default export); exported so that door can delegate here.
export function onAcctdelCpDelete() {
    const ctx = request.ctx || {};
    const aid = ctx.aid;
    const t = ctx.tenant;
    if (!aid || !t) return { ok: true };
    const m = acctdelMarker(aid);
    if (m === null || m.state !== "running") return { ok: true };
    const ik = ACCTDEL + aid + "/inst/" + t;
    const status = request.status || 0;
    // 204 = deleted; 404 = already gone (a retried job converges).
    if (status === 204 || status === 404) {
        kv.delete("account/" + aid + "/instances/" + t);
        kv.delete("instance/" + t + "/owner");
        kv.delete("instance/" + t + "/host");
        kv.set(ik, "gone");
        // Kick the driver now rather than waiting out the watchdog — when
        // this was the last pending instance, the next fire advances to
        // the rows phase.
        acctdelArm(aid, 0);
    } else {
        // The send burned its whole retry budget (webhook.send terminal
        // semantics), so this is a real refusal or a dead CP — freeze.
        kv.set(ik, "failed:" + status);
        m.state = "failed";
        m.error = "instance " + t + " delete failed with status " + status +
            " after " + ((request.activation && request.activation.attempts) || "?") +
            " attempts";
        acctdelWrite(aid, m);
    }
    return { ok: true };
}

// ── Deletion ops surface (root-only) ────────────────────────────────
// A `failed` deletion freezes the account and waits for a human; these
// two verbs are how the human sees it and resumes it.
export function listDeletions() {
    const rows = kv.prefix(ACCTDEL, "", 1000);
    const out = [];
    for (const e of rows) {
        const rest = e.key.slice(ACCTDEL.length);
        if (rest.indexOf("/") !== -1) continue; // per-instance bookkeeping
        let m = {};
        try { m = JSON.parse(e.value); } catch (_) {}
        out.push({ aid: rest, state: m.state, phase: m.phase,
                   is_team: !!m.is_team, started_ms: m.started_ms,
                   updated_ms: m.updated_ms, finished_ms: m.finished_ms || null,
                   error: m.error || null });
    }
    return { deletions: out };
}

export function retryDeletion(aid) {
    const m = acctdelMarker(aid);
    if (m === null) return jsonError(404, "no such deletion");
    if (m.state !== "failed") return jsonError(409, "not failed");
    // Reset failed instances to unsent (the same idempotency keys re-map
    // onto fresh sends) and re-enter the instances phase.
    const rows = kv.prefix(ACCTDEL + aid + "/inst/", "", 1000);
    for (const e of rows) {
        if (e.value.indexOf("failed:") === 0) kv.delete(e.key);
    }
    m.state = "running";
    m.phase = "instances";
    delete m.error;
    acctdelWrite(aid, m);
    acctdelArm(aid, 0);
    return { ok: true, aid: aid };
}

// POST ?fn=provisionInstance, args [name, account?]. Identity is the
// OIDC-verified id_token `sub` the RP guard put on request.auth — NOT a
// client-supplied field (closes the old signup trust-the-body gap). Creates the
// tenant under `account` (defaults to the caller's personal account); any active
// member of that account may provision, counting against THAT account's plan.
// All account/* rows are __admin__-home kv.
// A tenant is REAL only once the CP has formed its raft group across the
// cluster and written its placement — front-door routing is placement-driven
// and a miss is a terminal 404. So provisioning goes through the same
// `/_control/provision` the operator CLI uses (rove#291): the local
// `platform.instances.create` it used to call did node-local bookkeeping only,
// which left a dashboard-provisioned tenant unreachable in a multi-node
// cluster while reporting success.
//
// This handler owns AUTHZ (session, membership, plan limit); the CP owns
// EXISTENCE (name spec, group, placement). Neither duplicates the other — in
// particular the name rules live in `rove-instance-id`, because an id has to be
// one the worker's `{id}.{suffix}` wildcard can resolve, and a second copy here
// would drift out of agreement with the thing that actually routes.
//
// The CP call is a buffered `after.fetch` at the privileged door, so the reply
// is stamped by `onProvisioned` — the bookkeeping writes live there too, so a
// refused provision leaves no rows behind.
export function provisionInstance(name, account) {
    const auth = request.auth;
    const sub = auth && auth.sub;
    if (!sub) return jsonError(401, "unauthenticated");

    const caller = accountHashFor(sub);
    backfillSelf(caller, sub);
    const aid = (typeof account === "string" && account) ? account : caller;
    if (isDeleting(aid)) return jsonError(409, "account deletion in progress");
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

    // No `cluster`: a customer has no basis to choose one, and the CP defaults
    // to the sole configured cluster. No `host` either — the tenant answers on
    // `{name}.{publicSuffix}` through the wildcard, so there is no host row to
    // write and none to leave dangling if this fails.
    after.fetch(CP_DOOR + "provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant: name }),
        on: "onProvisioned",
        ctx: { name: name, account: aid },
    });
    return next();
}

// The CP's answer to `provisionInstance`. Runs as a continuation, so
// `request.auth` is absent (middleware does not re-run) — everything this needs
// was decided before the fetch and travels in `request.ctx`, which the engine
// carries and a client cannot touch.
export function onProvisioned() {
    const ctx = request.ctx || {};
    const name = ctx.name;
    const aid = ctx.account;
    if (!name || !aid) return jsonError(500, "provision continuation lost its context");

    if (request.status !== 200 && request.status !== 204) {
        // Relay the CP's own reason — it is the only party that knows WHICH
        // rule the name broke, and the customer is the one who has to fix it.
        let reason = "provision failed";
        try {
            const body = request.json;
            if (body && typeof body.error === "string") reason = body.error;
        } catch (_) { /* not JSON — keep the generic reason */ }
        // 4xx is the customer's to fix; anything else is ours, and a failed
        // provision is a no-op cluster-side (the CP evicts what it formed).
        response.status = (request.status >= 400 && request.status < 500)
            ? request.status : 502;
        return { error: reason };
    }

    // Placed. The CP's reply names where it answers — the dashboard carries no
    // copy of the platform's zone, and deriving one here would be a second
    // truth that drifts from the thing that actually routes.
    let host = null;
    try {
        const body = request.json;
        if (body && typeof body.host === "string" && body.host) host = body.host;
    } catch (_) { /* older CP replies 204 with no body — host stays unknown */ }

    // Record ownership, then seed the plan row — both only now, so a refusal
    // above leaves the account exactly as it was.
    if (kv.get("account/" + aid + "/plan") === null) {
        kv.set("account/" + aid + "/plan", "free");
    }
    kv.set("account/" + aid + "/instances/" + name, "");
    kv.set("instance/" + name + "/owner", aid); // reverse pointer for canAccess
    // The instance's primary host, so the UI can link it later without asking
    // the CP again. Absent when the platform has no wildcard zone — then the
    // instance is placed but has no URL until an operator maps one.
    if (host) kv.set("instance/" + name + "/host", host);

    // Starter content best-effort — the instance is usable without it, and the
    // customer's first deploy replaces it anyway.
    try { platform.instances.deployStarter(name); } catch (_) {}

    response.status = 201;
    return { ok: true, name: name, account: aid, host: host };
}

// GET /v1/session — whoami. request.auth = {sub,is_root} (set by the RP guard in
// _middlewares). Returns the caller's accounts (personal + teams) with role +
// instances; `active_account` is a UI default (the personal account). `owned` is
// kept (personal-account instances) for back-compat with older SPA builds.
function handleSession() {
    const a = request.auth || {};
    if (!a.sub) return { is_root: !!a.is_root, sub: null, accounts: [], active_account: null, owned: [] };
    const h = accountHashFor(a.sub);
    // Mid-deletion the session must not rebuild anything: report the
    // deletion instead so the SPA renders "deletion in progress" rather
    // than an empty dashboard that invites re-provisioning.
    if (isDeleting(h)) {
        return { is_root: !!a.is_root, sub: a.sub, deleting: true,
                 accounts: [], active_account: null, owned: [] };
    }
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
// Reach over a tenant's logs is exactly reach over the tenant: `canAccess` —
// the same primitive the `tenant` route class uses — so an active member of the
// owning account reads them and a pending invitee does not. An operator reads
// any tenant, which is the only cross-tenant read there is. The route is
// wildcard (`/v1/logs/*`), so it carries no `:id` for `routeAuthz` to gate on
// and the check lives here, after the tenant is parsed out of the path. The
// result comes back in `onFetchResult` (the buffered on.fetch convention) and
// is relayed verbatim.
const LOG_DOOR = "http://rewind-logs.internal/v1/";

function handleLogQuery(path, qs) {
    const auth = request.auth || {};
    // The M2M root grant is `{sub: null, is_root: true}`, so authority — not a
    // session — is what 401 turns on (rove#414).
    if (!auth.sub && !auth.is_root) return jsonError(401, "unauthenticated");
    // path = /v1/logs/{tenant}/{list|count|show/{id}}
    const rest = path.slice("/v1/logs/".length);
    const slash = rest.indexOf("/");
    if (slash < 1) return jsonError(400, "bad log path");
    const tenant = rest.slice(0, slash);
    const sub = rest.slice(slash + 1);
    if (!validId(tenant)) return jsonError(400, "invalid tenant");
    // The saga-viewer routes carry the same tenant-scoped read
    // authority as list/show: `window` (the exec-seq tape view),
    // `saga/{id}` (one saga's hops + gap summaries), `seam` (the
    // interference scan between two hops).
    //
    // `body/{request_id}/{channel}/{index}` resolves ONE recorded payload
    // that was left out of line: a payload over the inline cap is not in
    // the record, which keeps a pointer while the bytes stay in object
    // storage. It is addressed by TAPE ORDINAL, never by a raw
    // {batch_id, offset} — the body pool is cross-tenant, so the reference
    // is derived server-side from a record the caller may already read.
    // That makes it exactly as privileged as `show/{id}`, which hands back
    // the inline bodies of the same request, so it takes the same gate
    // below rather than one of its own.
    if (
        sub !== "list" && sub !== "count" && sub !== "window" &&
        sub !== "seam" && !sub.startsWith("show/") && !sub.startsWith("saga/") &&
        !sub.startsWith("body/")
    ) {
        return jsonError(404, "no such log route");
    }
    // Membership is derived from the SESSION, never from the path: the tenant
    // in the URL is the thing being authorized, not evidence of anything. A
    // tenant the caller cannot reach is refused identically whether or not it
    // exists, so the door is not a tenant-existence oracle. `show/{id}` returns
    // full request and response bodies, so it is gated the same as `list`.
    if (!auth.is_root && !canAccess(accountHashFor(auth.sub), tenant)) {
        return jsonError(403, "not your instance");
    }
    after.fetch(LOG_DOOR + tenant + "/" + sub + (qs ? "?" + qs : ""));
    return next();
}

// ── Control-plane chokepoint (step3-auth-plan.md B4) ────────────────
//
// Operators drive CP control ops — provision / move / host / plan —
// through the dashboard, NOT by holding the move-secret on a shell. The
// admin issues a buffered `after.fetch` at the privileged `rewind-cp.internal`
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
    // Operator AUTHORITY, not a session. The M2M root-token grant is
    // deliberately `{sub: null, is_root: true}`, so requiring `sub` rejected
    // exactly the caller this chokepoint exists to serve — the operator CLI
    // (rove#414). Anything unauthenticated has already been 401'd by the
    // middleware, so is_root is the whole gate here.
    if (!auth.is_root) return jsonError(403, "operator only");
    after.fetch(CP_DOOR + cpPath, {
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
    // Operator authority, not a session — see handleCpOp.
    if (!auth.is_root) return jsonError(403, "operator only");
    after.fetch(CP_READ + cpSub + (qs ? "?" + qs : ""));
    return next();
}

// Buffered after.fetch result for the log + CP chokepoints — relay the upstream
// status + body back to the dashboard. A door/upstream failure (e.g. an expired
// cap, or the CP unreachable) surfaces as 502.
export function onFetchResult() {
    response.headers = { "content-type": "application/json" };
    if (request.status >= 200 && request.status < 300) {
        response.status = request.status;
        return (request.text || "");
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
        return (request.text || "");
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
// Package files stage under a parallel prefix keyed by pkg_hash so `cut` can
// assemble the manifest's packages[].files. Mirrors the baked genesis deploy
// app (starter/genesis_admin.mjs) — the @rewind package-staging half of the
// deploy protocol. See docs/architecture/package-resolution.md.
const WSPKG = "_workspace_pkg/";

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
    // A deploy racing the owning account's deletion would stage into a
    // tenant the CP is tearing down — refuse while the job runs.
    const owner = kv.get("instance/" + b.tenant + "/owner");
    if (owner !== null && isDeleting(owner)) {
        jsonError(409, "account deletion in progress"); return null;
    }
    return b;
}

function handleWsReset(body) {
    const b = deployGate(body); if (!b) return null;
    const sk = platform.scope(b.tenant).kv;
    const rows = sk.prefix(WS, "", 1000);
    for (let i = 0; i < rows.length; i++) sk.delete(rows[i].key);
    const prows = sk.prefix(WSPKG, "", 1000);
    for (let i = 0; i < prows.length; i++) sk.delete(prows[i].key);
    return { ok: true, cleared: rows.length + prows.length };
}

function handleWsFile(body) {
    const b = deployGate(body); if (!b) return null;
    if (!b.path) return jsonError(400, "path required");
    // Statics stream straight to S3 via PUT /v1/upload (scope(t).blob.receive),
    // which records their own workspace entry — only handlers come through here.
    if (b.kind !== "handler")
        return jsonError(400, "kind must be 'handler' (statics stream via PUT /v1/upload)");
    // Stage the source; the bundle COMPILES at cut. Not here, because
    // compilation resolves imports eagerly: a handler that imports a sibling
    // could only be compiled once every sibling had been uploaded, and
    // mid-upload the bundle is incomplete rather than wrong (rove#344).
    platform.stage([{ path: b.path, source: b.source || "" }], {
        scope: b.tenant, on: "onFileStaged",
        ctx: { target: b.tenant, path: b.path, content_type: b.content_type || "" },
    });
    return next();
}

// Stage one PACKAGE file — staged like handler files, NOT compiled: a
// package's modules may import each other, and a file uploaded on its own
// cannot resolve siblings that haven't arrived (the same rove#344 shape the
// handler path had). Each package compiles as ONE batch at cut, under its
// /pkg/<pkg_hash>/ virtual identity, dependency-ordered across packages.
// Recorded under _workspace_pkg/{pkg_hash}/{path} so `cut` can compile +
// assemble the manifest's packages[].files (mirrors starter/genesis_admin.mjs).
function handleWsPkgFile(body) {
    const b = deployGate(body); if (!b) return null;
    if (!b.pkg_hash || !b.path) return jsonError(400, "pkg_hash + path required");
    // TRY to compile now (no resolution — the file alone): a self-contained
    // file (the common single-file package) gets its bytecode here, keeping
    // the compile cost spread across the staging requests. A file that
    // imports a sibling or another package can't resolve yet — that is not
    // an error, the bundle is merely incomplete (rove#344) — so it falls
    // back to stage-only and cut's batch phase compiles it.
    platform.compile([{ path: b.path, source: b.source || "" }], {
        scope: b.tenant, pkg_hash: b.pkg_hash, on: "onPkgTryCompiled",
        ctx: { target: b.tenant, pkg_hash: b.pkg_hash, path: b.path, source: b.source || "" },
    });
    return next();
}

export function onPkgTryCompiled() {
    const ctx = request.ctx;
    const app = (ctx && ctx.app) || {};
    if (ctx && ctx.ok) {
        const r = ctx.results[0];
        platform.scope(app.target).kv.set(WSPKG + app.pkg_hash + "/" + app.path, JSON.stringify({
            source_hex: r.source_hex, bytecode_hex: r.bytecode_hex,
        }));
        response.status = 200;
        return JSON.stringify({
            ok: true, pkg_hash: app.pkg_hash, path: app.path, source_hex: r.source_hex,
        });
    }
    // The privileged-surface gate is a verdict on the SOURCE, not on the
    // bundle's completeness — reject now, don't defer to cut.
    if (ctx && ctx.error && ctx.error.indexOf("privileged surface") !== -1) {
        response.status = ctx.status || 400;
        return JSON.stringify({ stage: "pkg-compile", ctx: ctx });
    }
    // Unresolvable import (sibling/dep not staged yet) — or any other
    // compile error, which cut's batch compile re-surfaces naming the file.
    // Record the row stage-only; the source hash is the same sha256 the
    // engine content-addresses with (and the failed compile already staged
    // the source blob before compiling).
    const source_hex = crypto.sha256(app.source);
    platform.scope(app.target).kv.set(WSPKG + app.pkg_hash + "/" + app.path, JSON.stringify({
        source_hex: source_hex,
    }));
    response.status = 200;
    return JSON.stringify({
        ok: true, pkg_hash: app.pkg_hash, path: app.path,
        source_hex: source_hex, staged_only: true,
    });
}

// compile bound-resume (continuation — skips _middlewares) → record the entry.
export function onFileStaged() {
    const ctx = request.ctx;
    if (!ctx || !ctx.ok) {
        response.status = 500;
        return JSON.stringify({ stage: "stage", ctx: ctx || null });
    }
    const app = ctx.app || {};
    const r = ctx.results[0];
    // No bytecode_hex yet — cut compiles the bundle and fills it in.
    platform.scope(app.target).kv.set(WS + app.path, JSON.stringify({
        kind: "handler", content_type: app.content_type || "",
        source_hex: r.source_hex }));
    response.status = 200;
    return JSON.stringify({ ok: true, path: app.path, hash: r.source_hex });
}

// Stage one STATIC by hash-reference — no byte round-trip. The blob is
// content-addressed in this tenant's own file-blobs (a prior deploy put it
// there), so the workspace row just points at it; the dashboard uses this to
// carry a deployment's unedited statics through a redeploy. Statics only:
// handlers restage source (the cut compile needs it). The blob.get first is
// the existence check — a manifest pointing at a GC'd blob must fail HERE,
// at deploy, not at serve. (It reads the whole object server-side; fine at
// dashboard bundle sizes — a blob.head verb is the upgrade if it ever shows
// in deploy latency.)
function handleWsRef(body) {
    const b = deployGate(body); if (!b) return null;
    if (!b.path || !b.hash) return jsonError(400, "path + hash required");
    if (b.kind !== "static")
        return jsonError(400, "kind must be 'static' (handlers restage source)");
    if (!/^[0-9a-f]{64}$/.test(b.hash))
        return jsonError(400, "hash must be 64 lowercase hex chars");
    platform.scope(b.tenant).blob.get(b.hash, {
        on: "onRefVerified",
        ctx: { target: b.tenant, path: b.path,
               content_type: b.content_type || "", hash: b.hash },
    });
    return next();
}

// blob.get resume (flat ctx — blob.get passes the caller ctx through,
// unlike stage/compile which nest it under `.app`): 2xx = the blob exists →
// record the workspace row, mirroring the shape v1/upload's onStored writes.
export function onRefVerified() {
    const app = request.ctx || {};
    if (!(request.status >= 200 && request.status < 300)) {
        response.status = 404;
        response.headers = { "content-type": "application/json" };
        return JSON.stringify({ ok: false, error: "no blob with that hash" });
    }
    platform.scope(app.target).kv.set(WS + app.path, JSON.stringify({
        kind: "static", content_type: app.content_type, source_hex: app.hash,
    }));
    response.status = 200;
    response.headers = { "content-type": "application/json" };
    return JSON.stringify({ ok: true, path: app.path, hash: app.hash });
}

// Cut: COMPILE the staged handlers as one bundle, then stamp the manifest.
// Compiling here rather than per upload is what lets a handler import a
// sibling — only now is the whole bundle present, and compilation resolves
// every import eagerly (rove#344). It is also where a bad import fails, and
// the compile error names the file.
function handleWsCut(body) {
    const b = deployGate(body); if (!b) return null;
    const sk = platform.scope(b.tenant).kv;
    const rows = sk.prefix(WS, "", 1000);
    if (rows.length === 0) return jsonError(400, "workspace empty — nothing to cut");
    // Phase 1: any staged package files without bytecode compile first, one
    // batch per package in dependency order — a package's own siblings
    // resolve from its batch, and a package it imports resolves from the
    // batch compiled before it. Then the handlers (phase 2).
    const q = pkgCompileQueue(sk, b);
    if (q && q.error) return jsonError(400, q.error);
    if (q && q.length > 0) return compileNextPkg(b, q, 0, {});
    return cutCompileHandlers(b, {});
}

// Phase 2 of cut: batch-compile the workspace's handlers against the (now
// bytecode-complete) package graph, then stamp. `done` is the chain's
// accumulated {pkg_hash → files[]} from phase 1 — carried in ctx, NEVER
// written to kv mid-chain: a resume hop that writes and then fires a
// platform call gets the call dropped (bind-from-writing-resume is not
// wired), which would silently stall the held cut.
function cutCompileHandlers(b, done) {
    const sk = platform.scope(b.tenant).kv;
    const rows = sk.prefix(WS, "", 1000);
    const handlers = [];
    for (let i = 0; i < rows.length; i++) {
        const e = JSON.parse(rows[i].value);
        if (e.kind === "handler")
            handlers.push({ path: rows[i].key.slice(WS.length), source_hash: e.source_hex });
    }
    if (handlers.length === 0) return cutStamp(b, {}, done);  // statics-only bundle
    // Compile against the SERVER-authoritative resolution, not the client's
    // lockfile: the engine needs each package file's staged bytecode hash to
    // load it, and validating against anything but what the manifest will
    // record would validate the wrong thing.
    const cres = buildResolution(sk, b, done);
    if (cres && cres.error) return jsonError(400, cres.error);
    const copts = {
        scope: b.tenant, on: "onBundleCompiled",
        // The client's lockfile has to survive the compile hop to reach the stamp.
        ctx: {
            target: b.tenant, done: done,
            resolution: b.resolution === undefined ? null : b.resolution,
        },
    };
    if (cres) copts.resolution = cres;
    platform.compile(handlers, copts);
    return next();
}

// The packages whose staged rows still need bytecode, dependency-ordered
// (leaves first — DFS over each package's `imports` targets). A dep whose
// pkg_hash isn't in this deploy's resolution is fine (its rows compiled in
// an earlier deploy); a cycle is an author error. `{error}` on a declared
// package with nothing staged, so the failure names the package instead of
// surfacing as an unresolvable import later.
function pkgCompileQueue(sk, b) {
    if (b.resolution === undefined) return null;
    const pkgs = b.resolution.packages || [];
    const byHash = {};
    for (let i = 0; i < pkgs.length; i++) byHash[pkgs[i].pkg_hash] = pkgs[i];
    const order = [];
    const state = {}; // pkg_hash → 1 visiting, 2 done
    function visit(p) {
        if (state[p.pkg_hash] === 2) return null;
        if (state[p.pkg_hash] === 1)
            return "package import cycle involving " + p.spec + "@" + p.version;
        state[p.pkg_hash] = 1;
        const imp = p.imports || {};
        for (const spec in imp) {
            const dep = byHash[imp[spec]];
            if (dep) { const e = visit(dep); if (e) return e; }
        }
        state[p.pkg_hash] = 2;
        order.push(p);
        return null;
    }
    for (let i = 0; i < pkgs.length; i++) {
        const e = visit(pkgs[i]);
        if (e) return { error: e };
    }
    const q = [];
    for (let i = 0; i < order.length; i++) {
        const p = order[i];
        const staged = sk.prefix(WSPKG + p.pkg_hash + "/", "", 1000);
        if (staged.length === 0)
            return { error: "package " + p.spec + "@" + p.version + " has no staged files" };
        let needs = false;
        for (let j = 0; j < staged.length; j++)
            if (!JSON.parse(staged[j].value).bytecode_hex) { needs = true; break; }
        if (needs) q.push(p.pkg_hash);
    }
    return q;
}

// Compile package `q[idx]`'s staged files as one batch under its
// /pkg/<hash>/ virtual dir. Its resolution carries the packages that are
// already bytecode-complete — from stage-time try-compiles (kv rows) or
// earlier chain hops (`done`); the deploy thread prefetches every listed
// file's bytecode eagerly, so an incomplete package lists empty files.
// Dependency order makes the complete set exactly what this package may
// import from.
function compileNextPkg(b, q, idx, done) {
    const sk = platform.scope(b.tenant).kv;
    const pkg_hash = q[idx];
    const staged = sk.prefix(WSPKG + pkg_hash + "/", "", 1000);
    const files = staged.map(function (row) {
        return {
            path: row.key.slice((WSPKG + pkg_hash + "/").length),
            source_hash: JSON.parse(row.value).source_hex,
        };
    });
    const copts = {
        scope: b.tenant, pkg_hash: pkg_hash, on: "onPkgBatchCompiled",
        ctx: {
            target: b.tenant, pkg_hash: pkg_hash, queue: q, idx: idx, done: done,
            resolution: b.resolution === undefined ? null : b.resolution,
        },
    };
    const cres = compiledResolution(sk, b, done);
    if (cres) copts.resolution = cres;
    platform.compile(files, copts);
    return next();
}

export function onPkgBatchCompiled() {
    const ctx = request.ctx;
    if (!ctx || !ctx.ok) {
        response.status = (ctx && ctx.status) || 500;
        return JSON.stringify({ stage: "pkg-compile", ctx: ctx || null });
    }
    const app = ctx.app || {};
    // Accumulate this package's compiled files in ctx (`done`) — NOT in kv:
    // this hop chains another platform.compile, and a write here would drop
    // it (bind-from-writing-resume is not wired). The manifest gets these
    // via the `done` merge in buildResolution.
    const files = [];
    for (let i = 0; i < ctx.results.length; i++) {
        const r = ctx.results[i];
        files.push({ path: r.path, source_hash: r.source_hex, bytecode_hash: r.bytecode_hex });
    }
    const done = app.done || {};
    done[app.pkg_hash] = files;
    const b = {
        tenant: app.target,
        resolution: app.resolution === null ? undefined : app.resolution,
    };
    const nextIdx = app.idx + 1;
    if (nextIdx < app.queue.length) return compileNextPkg(b, app.queue, nextIdx, done);
    return cutCompileHandlers(b, done);
}

// This deploy's resolution with files listed ONLY for bytecode-complete
// packages, an empty files array otherwise. Every package stays present —
// the per-importer resolver needs the CURRENT package's own imports map to
// resolve its `@scope/pkg` specifiers mid-compile — while the empty files
// keep the deploy thread's eager bytecode prefetch off the not-yet-compiled
// ones. Rows are all-or-nothing per pkg_hash (content identity), so a
// package is never half-listed.
function compiledResolution(sk, b, done) {
    if (b.resolution === undefined) return null;
    const res = { packages: [], app_imports: b.resolution.app_imports || {} };
    const pkgs = b.resolution.packages || [];
    for (let i = 0; i < pkgs.length; i++) {
        const p = pkgs[i];
        let files = done[p.pkg_hash] || null;
        if (!files) {
            const staged = sk.prefix(WSPKG + p.pkg_hash + "/", "", 1000);
            let complete = staged.length > 0;
            const fromRows = [];
            for (let j = 0; j < staged.length; j++) {
                const f = JSON.parse(staged[j].value);
                if (!f.bytecode_hex) { complete = false; break; }
                fromRows.push({
                    path: staged[j].key.slice((WSPKG + p.pkg_hash + "/").length),
                    source_hash: f.source_hex, bytecode_hash: f.bytecode_hex,
                });
            }
            files = complete ? fromRows : [];
        }
        res.packages.push({
            spec: p.spec, version: p.version, pkg_hash: p.pkg_hash,
            files: files, imports: p.imports || {},
            capabilities: p.capabilities || [], private: !!p.private,
        });
    }
    if (res.packages.length === 0) return null;
    return res;
}

// The bundle compiled: fold each handler's bytecode hash in, then stamp.
export function onBundleCompiled() {
    const ctx = request.ctx;
    if (!ctx || !ctx.ok) {
        // A compile failure here is the author's — a syntax error, or an
        // import that resolves to nothing. Relay the engine's status so it
        // reads as a bad bundle, not a broken deploy service.
        response.status = (ctx && ctx.status) || 500;
        return JSON.stringify({ stage: "compile", ctx: ctx || null });
    }
    const app = ctx.app || {};
    const bc = {};
    for (let i = 0; i < ctx.results.length; i++) bc[ctx.results[i].path] = ctx.results[i].bytecode_hex;
    return cutStamp(
        { tenant: app.target, resolution: app.resolution === null ? undefined : app.resolution },
        bc,
        app.done || {},
    );
}

// Assemble the manifest from the workspace + the just-compiled bytecode
// hashes (`bc`, path → bytecode_hex) and stamp it.
function cutStamp(b, bc, done) {
    const sk = platform.scope(b.tenant).kv;
    const rows = sk.prefix(WS, "", 1000);
    const entries = rows.map(function (row) {
        const e = JSON.parse(row.value);
        const path = row.key.slice(WS.length);
        return { path: path, kind: e.kind,
                 content_type: e.content_type || "",
                 source_hex: e.source_hex, bytecode_hex: bc[path] || e.bytecode_hex || "" };
    });
    const sopts = { on: "onCut" };
    const res = buildResolution(sk, b, done);
    if (res && res.error) return jsonError(400, res.error);
    if (res) sopts.resolution = res;
    platform.scope(b.tenant).deploy.stampManifest(entries, sopts);
    return next();
}

// Join the client's lockfile (spec/version/pkg_hash/imports) with the
// server-staged package files — hashes stay server-authoritative (recorded by
// onPkgStaged) → manifest-v2 packages[]. See package-resolution.md. The SAME
// resolution feeds the cut compile and the manifest, so a handler's
// `@scope/pkg` import validates against exactly the package files the
// deployment will record. Null when the deploy has no packages; `{error}` when
// a declared package was never staged.
function buildResolution(sk, b, done) {
    if (b.resolution === undefined) return null;
    const res = { packages: [], app_imports: b.resolution.app_imports || {} };
    const pkgs = b.resolution.packages || [];
    for (let i = 0; i < pkgs.length; i++) {
        const p = pkgs[i];
        // A package compiled during THIS cut has its bytecode only in `done` —
        // the compile chain accumulates there because a kv write in a resume
        // hop would drop the next platform call (rove#344). The staged rows
        // still carry `bytecode_hex: undefined` for it, and the manifest
        // stamper requires a 64-hex `bytecode_hash` on every package file, so
        // reading kv alone refuses the deploy with "invalid resolution".
        let files = done[p.pkg_hash] || null;
        if (!files) {
            const staged = sk.prefix(WSPKG + p.pkg_hash + "/", "", 1000);
            if (staged.length === 0)
                return { error: "package " + p.spec + "@" + p.version + " has no staged files" };
            files = staged.map(function (row) {
                const f = JSON.parse(row.value);
                return { path: row.key.slice((WSPKG + p.pkg_hash + "/").length),
                         source_hash: f.source_hex, bytecode_hash: f.bytecode_hex };
            });
        }
        res.packages.push({
            spec: p.spec, version: p.version, pkg_hash: p.pkg_hash,
            files: files, imports: p.imports || {},
            capabilities: p.capabilities || [], private: !!p.private,
        });
    }
    return res;
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
        { on: "onManifest", ctx: { tenant: tenant, dep: dep } });
    return next();
}

// Read-door continuation: the manifest JSON arrives on request.body. Parse it,
// then kick off the sequential handler-source reads (or finish if there are
// none).
export function onManifest() {
    const ctx = request.ctx || {};
    if (!(request.status >= 200 && request.status < 300)) {
        response.headers = { "content-type": "application/json" };
        response.status = request.status === 404 ? 404 : 502;
        return JSON.stringify({ error: "manifest read failed", status: request.status || 0 });
    }
    let manifest;
    try { manifest = JSON.parse((request.text || "")); }
    catch (e) { response.status = 502; return JSON.stringify({ error: "manifest parse failed" }); }
    // manifest_json stores the source/content hash under "hash".
    const entries = (manifest.entries || []).map((e) => ({
        path: e.path, kind: e.kind, content_type: e.content_type, hash: e.hash,
    }));
    // Package metadata + resolution maps, for the replay shell: a handler
    // importing `@scope/pkg` resolves (the engine's module normalize) to the
    // package-virtual key `/pkg/<pkg_hash>/<file>`, and the captured module
    // tape records THAT name — so a replay needs the package sources under
    // their virtual keys plus the specifier→pkg_hash maps to rewrite its
    // imports the same way.
    const pkgs = (manifest.packages || []).map((p) => ({
        spec: p.spec, version: p.version, pkg_hash: p.pkg_hash,
        imports: p.imports || {},
        // capabilities + private ride along so a dashboard redeploy can hand
        // `cut` a resolution that preserves them — buildResolution reads both,
        // and a resolution without them would silently STRIP the package's
        // capability grants from the new manifest.
        capabilities: p.capabilities || [],
        private: !!p.private,
        files: (p.files || []).map((f) => ({
            path: f.path,
            virtual: "/pkg/" + p.pkg_hash + "/" + f.path,
            source_hash: f.source_hash,
        })),
    }));
    const ctx2 = {
        tenant: ctx.tenant, dep: ctx.dep, entries: entries,
        pkgs: pkgs, app_imports: manifest.app_imports || {},
    };
    const handlers = entries.filter((e) => e.kind === "handler");
    if (handlers.length === 0) return startPkgSources(ctx2, []);
    platform.scope(ctx.tenant).blob.get(handlers[0].hash, {
        on: "onModuleSource",
        ctx: { ...ctx2, idx: 0, acc: [] },
    });
    return next();
}

// Read-door continuation: one handler's source bytes arrive on request.body.
// Accumulate, then either read the next handler or move on to the package
// files.
export function onModuleSource() {
    const ctx = request.ctx || {};
    const handlers = (ctx.entries || []).filter((e) => e.kind === "handler");
    const ok = request.status >= 200 && request.status < 300;
    const src = ok ? (request.text || "") : null;
    const acc = ctx.acc.concat([{
        path: handlers[ctx.idx].path, source: src, missing: !ok,
    }]);
    const nextIdx = ctx.idx + 1;
    if (nextIdx < handlers.length) {
        platform.scope(ctx.tenant).blob.get(handlers[nextIdx].hash, {
            on: "onModuleSource",
            ctx: { ...ctx, idx: nextIdx, acc: acc },
        });
        return next();
    }
    return startPkgSources(ctx, acc);
}

// Kick off (or skip) the sequential package-file source reads that follow the
// handler reads. Package sources are content-addressed blobs in the SAME
// tenant's file-blobs (the pkgfile door staged them there at deploy time), so
// the read is the same `blob.get` the handler sources use.
function startPkgSources(ctx, handlerAcc) {
    const files = (ctx.pkgs || []).flatMap((p) => p.files);
    if (files.length === 0) return finishSources(ctx, handlerAcc, []);
    platform.scope(ctx.tenant).blob.get(files[0].source_hash, {
        on: "onPkgSource",
        ctx: { ...ctx, handler_acc: handlerAcc, pidx: 0, pacc: [] },
    });
    return next();
}

// Read-door continuation: one package file's source bytes arrive.
export function onPkgSource() {
    const ctx = request.ctx || {};
    const files = (ctx.pkgs || []).flatMap((p) => p.files);
    // `status` is the single result signal (handler-shape.md — no request.ok).
    const ok = request.status >= 200 && request.status < 300;
    const src = ok ? (request.text || "") : null;
    const pacc = ctx.pacc.concat([{
        virtual: files[ctx.pidx].virtual, source: src, missing: !ok,
    }]);
    const nextIdx = ctx.pidx + 1;
    if (nextIdx < files.length) {
        platform.scope(ctx.tenant).blob.get(files[nextIdx].source_hash, {
            on: "onPkgSource",
            ctx: { ...ctx, pidx: nextIdx, pacc: pacc },
        });
        return next();
    }
    return finishSources(ctx, ctx.handler_acc, pacc);
}

// Merge handler sources into the manifest entries + respond (releases the held
// chain). Handlers carry `source` (or `missing:true` if the blob read failed);
// statics carry metadata only. Packages ride alongside with their files'
// sources folded in under the virtual key.
function finishSources(ctx, sources, pkgSources) {
    const srcByPath = {};
    for (const s of sources) srcByPath[s.path] = s;
    const out = (ctx.entries || []).map((e) => {
        const r = { path: e.path, kind: e.kind, content_type: e.content_type, source_hex: e.hash };
        if (e.kind === "handler") {
            const s = srcByPath[e.path];
            if (s && s.source != null) r.source = s.source; else r.missing = true;
        }
        return r;
    });
    const srcByVirtual = {};
    for (const s of pkgSources) srcByVirtual[s.virtual] = s;
    const pkgsOut = (ctx.pkgs || []).map((p) => ({
        spec: p.spec, version: p.version, pkg_hash: p.pkg_hash,
        imports: p.imports,
        capabilities: p.capabilities || [], private: !!p.private,
        files: p.files.map((f) => {
            const r = { path: f.path, virtual: f.virtual, source_hex: f.source_hash };
            const s = srcByVirtual[f.virtual];
            if (s && s.source != null) r.source = s.source; else r.missing = true;
            return r;
        }),
    }));
    response.status = 200;
    response.headers = { "content-type": "application/json" };
    return JSON.stringify({
        ok: true, dep_id: ctx.dep, entries: out,
        packages: pkgsOut, app_imports: ctx.app_imports || {},
    });
}

// ── Single-file source read (lazy static open) ──────────────────────
//
// GET /v1/source/{tenant}/{dep_hex|current}?path=… — one entry's source via
// the same read door composition as /v1/sources (readManifest → blob.get),
// so the dashboard can open a text static WITHOUT the bulk read pulling
// every static's bytes eagerly. TEXT ONLY: this door feeds the editor, and
// binary statics carry through deploys by hash-reference so their bytes
// never need reading back (request.text on binary would mangle them — this
// door has no base64 surface).

function isTextual(ct) {
    const base = String(ct || "").split(";")[0].trim().toLowerCase();
    if (base.startsWith("text/")) return true;
    return base === "application/json" || base === "application/javascript" ||
           base === "application/xml" || base === "image/svg+xml";
}

function handleReadSource(tenant, depArg, qs) {
    const auth = request.auth || {};
    if (!auth.is_root && !auth.sub) return jsonError(401, "unauthenticated");
    if (!validId(tenant)) return jsonError(400, "invalid tenant");
    if (!auth.is_root && !canAccess(accountHashFor(auth.sub), tenant)) {
        return jsonError(403, "not your instance");
    }
    const filePath = new URLSearchParams(qs || "").get("path");
    if (!filePath) return jsonError(400, "path query param required");
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
        { on: "onSourceFileManifest", ctx: { tenant: tenant, path: filePath } });
    return next();
}

// Read-door continuation: locate the requested entry in the manifest, gate
// on textiness, then read its blob.
export function onSourceFileManifest() {
    const ctx = request.ctx || {};
    if (!(request.status >= 200 && request.status < 300)) {
        response.headers = { "content-type": "application/json" };
        response.status = request.status === 404 ? 404 : 502;
        return JSON.stringify({ error: "manifest read failed", status: request.status || 0 });
    }
    let manifest;
    try { manifest = JSON.parse(request.text || ""); }
    catch (e) { response.status = 502; return JSON.stringify({ error: "manifest parse failed" }); }
    const entry = (manifest.entries || []).find((e) => e.path === ctx.path);
    if (!entry) return jsonError(404, "no such file in that deployment");
    if (!isTextual(entry.content_type) && entry.kind !== "handler") {
        return jsonError(415, "not a text file — binary statics carry by hash-reference");
    }
    platform.scope(ctx.tenant).blob.get(entry.hash, {
        on: "onSourceFileBlob",
        ctx: { path: entry.path, kind: entry.kind,
               content_type: entry.content_type || "", hash: entry.hash },
    });
    return next();
}

export function onSourceFileBlob() {
    const app = request.ctx || {};
    response.headers = { "content-type": "application/json" };
    if (!(request.status >= 200 && request.status < 300)) {
        response.status = 502;
        return JSON.stringify({ error: "blob read failed", status: request.status || 0 });
    }
    response.status = 200;
    return JSON.stringify({
        ok: true, path: app.path, kind: app.kind,
        content_type: app.content_type, source_hex: app.hash,
        source: request.text || "",
    });
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
    // `canAccess` — the same reach primitive every other tenant route
    // uses, so a team MEMBER reads history like they read logs and kv
    // (the old ownedInstances check saw only the caller's personal
    // account and 403'd members of the owning team).
    if (!auth.is_root && !canAccess(accountHashFor(auth.sub), tenant)) {
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

// ── Instance data export (rove#340) ─────────────────────────────────
// The dashboard runs a customer's export FOR them: `@rewind/export`'s
// verbs bound to the target's `platform.scope(t)` handle. The rows a
// cross-tenant `start` writes are identical to a self-start's, and the
// engine arms the target tenant's durable wake at commit (the
// target-envelope sched-write arm), so the job begins immediately on
// whichever node leads the target's group. Route authz is the standard
// tenant classes — reach over a tenant's export is exactly reach over
// the tenant.
//
// The artifact: content-addressed parts in the target's unmetered
// `exports/` pool. KV parts are JSONL; a `kind:"bundle"` part is the
// deployment manifest, whose per-file hashes presign out of the
// target's immutable file-blobs (fileUrl). Links are TTL-bounded —
// re-request to re-mint.

const EXPORT_LINK_TTL_S = 300;

// Newest-first export list, metadata only (never part hashes as
// authority — links mint server-side from the marker).
function exportMeta(id, st) {
    return {
        id: id,
        state: st.state || null,
        started_at: st.started_at || null,
        finished_at: st.finished_at || null,
        bytes: st.bytes || 0,
        entries: st.entries || 0,
        parts: Array.isArray(st.parts) ? st.parts.length : 0,
        bundle: st.bundle || null,
        error: st.error || null,
    };
}

function listExports(tenant) {
    const rows = platform.scope(tenant).kv.prefix("_export/", "", 100);
    const out = [];
    for (const e of rows) {
        let st = null;
        try { st = JSON.parse(e.value); } catch (_) { continue; }
        out.push(exportMeta(e.key.slice("_export/".length), st));
    }
    // `started_at` descending — the UI leads with the newest.
    out.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    return { tenant: tenant, exports: out };
}

function startExport(tenant) {
    const scoped = exportLib.forScope(platform.scope(tenant));
    // One at a time per tenant: a second concurrent walk doubles the S3
    // writes for zero information — the artifact is a snapshot either way.
    const rows = platform.scope(tenant).kv.prefix("_export/", "", 100);
    for (const e of rows) {
        try {
            if (JSON.parse(e.value).state === "running")
                return jsonError(409, "an export is already running");
        } catch (_) { /* unparseable marker cannot be running */ }
    }
    const id = scoped.start({ bundle: true });
    response.status = 202;
    return { id: id };
}

function getExport(tenant, eid) {
    if (typeof eid !== "string" || !eid) return jsonError(400, "bad export id");
    const st = exportLib.forScope(platform.scope(tenant)).get(eid);
    if (st === null) return jsonError(404, "no such export");
    return exportMeta(eid, st);
}

function getExportLinks(tenant, eid) {
    if (typeof eid !== "string" || !eid) return jsonError(400, "bad export id");
    const scope = platform.scope(tenant);
    const st = exportLib.forScope(scope).get(eid);
    if (st === null) return jsonError(404, "no such export");
    if (st.state !== "done") return jsonError(409, "export not finished");
    const parts = Array.isArray(st.parts) ? st.parts : [];
    const links = parts.map((p) => ({
        hash: p.hash,
        bytes: p.bytes || 0,
        kind: p.kind || "kv",
        url: scope.blob.exportUrl(p.hash, { ttl: EXPORT_LINK_TTL_S }),
    }));
    return { id: eid, ttl_seconds: EXPORT_LINK_TTL_S, links: links };
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
    ["DELETE", "/v1/instances/:id",             "tenant",        (c) => deleteInstance(c.params.id, c.body && c.body.confirm)],
    ["POST",   "/v1/instances/:id/release",     "tenant",        (c) => publishRelease(c.params.id, c.body.dep_id)],
    ["POST",   "/v1/instances/:id/export",      "tenant",        (c) => startExport(c.params.id)],
    ["GET",    "/v1/instances/:id/export",      "tenantRead",    (c) => listExports(c.params.id)],
    ["GET",    "/v1/instances/:id/export/:eid", "tenantRead",    (c) => getExport(c.params.id, c.params.eid)],
    ["GET",    "/v1/instances/:id/export/:eid/links", "tenantRead", (c) => getExportLinks(c.params.id, c.params.eid)],
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
    // account deletion + account-rows export (rove#340)
    ["POST",   "/v1/account/delete",            "authed",        (c) => requestAccountDeletion(c.body.confirm)],
    ["DELETE", "/v1/accounts/:aid",             "accountOwner",  (c) => deleteTeamAccount(c.params.aid, c.body && c.body.confirm)],
    ["GET",    "/v1/deletions",                 "root",          (c) => listDeletions()],
    ["POST",   "/v1/deletions/:aid/retry",      "root",          (c) => retryDeletion(c.params.aid)],
    ["GET",    "/v1/accounts/:aid/export",      "accountMember", (c) => accountExport(c.params.aid)],
    ["GET",    "/v1/accounts/:aid/billing",     "accountMember", (c) => getBilling(c.params.aid)],
    ["GET",    "/v1/billing/config",            "authed",        (c) => billingConfigPk()],
    ["POST",   "/v1/accounts/:aid/billing/subscribe", "accountOwner", (c) => subscribeBilling(c.params.aid, c.body.tier)],
    ["POST",   "/v1/accounts/:aid/billing/change",    "accountOwner", (c) => changeBilling(c.params.aid, c.body.tier)],
    ["POST",   "/v1/accounts/:aid/billing/cancel",    "accountOwner", (c) => cancelBilling(c.params.aid)],
    // Stripe webhook — pre-auth in _middlewares; the signature is the auth.
    ["POST",   "/v1/billing/webhook",           "open",          (c) => handleStripeWebhook(c.rawBody || "")],
    ["POST",   "/v1/invites/accept",            "authed",        (c) => acceptInvite(c.body.token)],
    // deploy chokepoint (root-token M2M or session-ownership; deployGate self-gates)
    ["POST",   "/v1/deploy/reset",              "open",          (c) => handleWsReset(c.rawBody || "{}")],
    ["POST",   "/v1/deploy/file",               "open",          (c) => handleWsFile(c.rawBody || "{}")],
    ["POST",   "/v1/deploy/pkgfile",            "open",          (c) => handleWsPkgFile(c.rawBody || "{}")],
    ["POST",   "/v1/deploy/ref",                "open",          (c) => handleWsRef(c.rawBody || "{}")],
    ["POST",   "/v1/deploy/cut",                "open",          (c) => handleWsCut(c.rawBody || "{}")],
    // deployment history (handler enforces ownership) — /v1/history/{tenant}
    ["GET",    "/v1/history/:id",               "self",          (c) => handleHistory(c.params.id)],
    // log query door (handler enforces is_root) — /v1/logs/{tenant}/{list|count|show/{id}}
    ["GET",    "/v1/logs/*",                    "self",          (c) => handleLogQuery(c.path, c.qs)],
    // source read door (handler enforces canAccess) — /v1/sources/{tenant}/{dep}
    ["GET",    "/v1/sources/*",                 "self",          (c) => handleSourcesPath(c.path)],
    // single-file twin (text only; the file path rides the query so its
    // slashes never meet the segment matcher) — /v1/source/{tenant}/{dep}?path=…
    ["GET",    "/v1/source/:id/:dep",           "self",          (c) => handleReadSource(c.params.id, c.params.dep, c.qs)],
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
    try { return JSON.parse(request.text || "{}") || {}; } catch (_) { return {}; }
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
    // `request.path` NEVER carries the query string — it lives only on
    // `request.query` (handler-shape.md, the default-activation surface).
    // Splitting `path` on "?" always produced an empty query, so every routed
    // read that needs one (`/v1/cp/route?host=`, `/v1/logs/*?…`) reached its
    // door with the parameter missing.
    const path = request.path;
    const qs = request.query || "";
    const m = matchRoute(request.method, path);
    if (!m) { response.status = 404; return { error: "not found" }; }
    const denied = routeAuthz(m.authz, m.params);
    if (denied) return denied;
    return m.thunk({
        params: m.params, query: parseQuery(qs), qs: qs,
        body: parseBody(), rawBody: request.text || "", path: path,
    });
}
