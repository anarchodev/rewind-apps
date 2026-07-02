---
name: rewind
description: Deploy / release / replay / simulate first-party app content (this repo's tenants) using the `rewind` customer CLI — the dogfooded, OIDC-authed path we expect customers to use. Use when asked to deploy, ship, release, roll back, replay, simulate/sim a request, or pull logs for a rewind-apps tenant (marketing, docs, admin, auth, agent-sample, or a customer-style app). This is the tenant-CONTENT path; deploying platform binaries is a different repo (rewind-infra `/deploy`).
---

# /rewind — ship app content with the customer CLI

This repo (`rewind-apps`) is the first-party app content. We deploy it with the
**exact same `rewind` CLI a customer uses** — OIDC session auth, no platform
secrets, no SSH. Dogfooding the tool is the point: if the workflow is awkward
here, it's awkward for customers, and that's a product signal to surface (don't
work around it with operator shortcuts).

## The one rule

**Only `rewind`.** Never reach for `rewind-ops`, `ssh`, raw `curl` to the
private plane, `publish_tenant.py`, or any platform secret (move-secret /
root-token). Those live in the operator repos and bypass the customer surface
we're validating. If `rewind` genuinely can't do something a customer would need,
**stop and surface the gap** rather than routing around it.

## Preconditions

- **`rewind` on PATH.** It's a rove-built binary (`zig build rewind` in the rove
  checkout → install `zig-out/bin/rewind` to `~/.local/bin`). Distribution for
  non-rove checkouts is still being decided.
- **Config at `~/.config/rewind/config`** (auto-discovered — no `--env` needed),
  `KEY=VALUE` lines:
  ```
  REWIND_ADMIN_URL=https://app.rewindjs.com
  REWIND_IDP_URL=https://auth.rewindjs.com
  ```
  Optional: `REWIND_CLIENT_ID` (default `admin-dashboard`), and `REWIND_CACERT` /
  `REWIND_RESOLVE` only for local/private-CA targets. OS env overrides the file
  per-var; an explicit `rewind --env <file> …` overrides the default path (use it
  only to target a non-default cluster). The session cookie lives at
  `~/.config/rewind/rewind.session`.
- **`manifest.json`** (repo root) lists this operator's tenants → source dir →
  tenant id → hosts. It drives `rewind publish`. `dir != id` for system tenants
  (`admin` → `__admin__`, `auth` → `__auth__`).

## Auth — `login` is interactive (by design)

1. Check first: `rewind status`. If it reports an authed session, skip login.
2. If not authed (`not signed in — run rewind login`): run `rewind login`. This
   is the **RFC 8628 device grant** — it prints a verification URL + a short
   user-code and then **blocks waiting for a human to approve**. You (Claude)
   **cannot complete this step yourself**: surface the URL and code to the user,
   tell them to approve it in a browser, and let the command finish. This is the
   customer auth flow — don't try to shortcut it.

## Deploy a single app (the common iteration — stage, then release)

Deploys stay **approval-gated**: stage first, show the result, get a yes, then
release. Do **not** pass `--release` by default.

1. `rewind deploy <tenant> <bundle-dir>` — compiles + uploads, stamps a
   deployment, **does not go live**. It prints a `dep_id` (a hex string).
2. Report: the `dep_id`, what was published (N handlers / N statics), any compile
   warnings.
3. On the user's go-ahead: `rewind release <tenant> <dep_id>` → flips
   `_deploy/current` live. (Or re-run step 1 with `--release` once the user has
   pre-approved.)
4. Verify the live tenant (e.g. `rewind status`, or a request to its host).

Example (docs tenant): `rewind deploy docs docs` then `rewind release docs <dep_id>`.

## Publish all first-party tenants (bulk, operator session)

`rewind publish [--only marketing,docs] [--include-examples] [--no-release]`
reads `manifest.json`, provisions/deploys/releases each tenant. This is the
manifest-driven bulk path (it replaces the old `publish_firstparty.py`). It needs
an **operator (`is_root`) session** — `rewind status` shows whether yours is.
Default stages + releases per the manifest; `--no-release` to stage only.

## Run a handler offline — `sim` / `replay` (no cluster, no network)

Both run the working-tree handler through the **real engine** offline and return
the activation's **effect log**. Use this for a saga (`on.fetch` + resume),
concurrency, a regression, or "does my change still behave?" — not for every
change (reasoning + deploy is fine for a simple one). Two ways to get the world:

**A real request → `pull`, then `replay`:**

1. `rewind logs <tenant> [--limit N]` → find the `req_id`.
2. `rewind pull <tenant> <req_id> -o world.json` → a self-contained `world.json`
   (the real request + the state it read). Hand-editable.
3. `rewind replay world.json --source-dir <dir>` → re-executes locally;
   `--source-dir` runs your working-tree handler against the recorded inputs, so
   you confirm a fix reproduces / diverges before deploying.

**A new request → author a `world.json`, then `sim`.** You don't scaffold — the
schema has defaults, so the minimum is tiny, and the effect log tells you the
rest:

```json
{ "request": { "method": "POST", "path": "/checkout", "body": { "id": "c_1" } } }
```

Fields (all but `request` default): `entry` (`index.mjs`), `activation`
(`inbound`), `export` (the conventional export for the kind — set it only for a
callback), `kv` (**a little starting store, closed-world: a key not in it reads
_absent_ (`not_found`)**; non-string values auto-JSON-stringify), `seed` (`0`),
`now_ms`.

Per-activation `request` shapes:

```json
// inbound (export "default")
{ "activation": "inbound",
  "request": { "method": "POST", "path": "/checkout",
               "headers": { "content-type": "application/json" },
               "body": { "id": "c_1", "total": 4200 } },
  "kv": { "config/rate": "10" } }

// fetch_chunk — an on.fetch result resuming a saga (export "onFetchResult" or a
// {to}). The result rides request.status/.body; body is BYTES; ctx threads.
{ "activation": "fetch_chunk", "export": "onCharge",
  "request": { "status": 200, "ok": true, "done": true, "fetchId": "ftch_1",
               "body": { "id": "ch_1", "paid": true } },
  "ctx": { "cartId": "c_1" } }

// ws_message (export "onMessage")
{ "activation": "ws_message",
  "request": { "activation": { "opcode": "text", "data": "hello" } },
  "ctx": { "room": "general" } }

// on.kv / on.timer wake (export "onWake")
{ "activation": "kv_wake",
  "request": { "activation": { "wakes": [ { "kind": "kv", "prefix": "orders/" } ] } },
  "ctx": {} }
```

`rewind sim world.json --source-dir .` returns the ordered **effect log**:

```json
{ "response": { "status": 202, "headers": {}, "cookies": [] },
  "disposition": "terminal", "body": "accepted",
  "effects": [
    { "kind": "read",  "key": "config/rate", "present": true },
    { "kind": "read",  "key": "user/c_1",    "present": false },
    { "kind": "write", "key": "order/c_1",   "value": "…" },
    { "kind": "fetch", "url": "…/charge", "ctx": {}, "to": "onCharge" },
    { "kind": "log",   "level": "info", "message": "charging c_1" } ],
  "error": null, "ok": true }
```

- `response` is the HEAD (status/headers/cookies — the ambient `response`
  global). `disposition` is `terminal` (+`body`) or `held` (+`ctx`, from `next()`).
- `effects` is **one list, occurrence order** — reads, writes, cmds
  (fetch/webhook/…/stream) and `console` as `{kind:"log"}` — the causal trace.
  Filter by `kind` for a typed view.

**The loop — minimal → run → fill.** Don't pre-guess the `kv`. Write just
`request`, run, and read the effects: the `present:false` reads and emitted
`fetch`es are exactly what the handler consumed (real, resolved keys/URLs). Add
those keys to `kv` (values whose shape you know — you wrote the handler) and
re-run. It converges without guessing.

## Other verbs

- `rewind deployments <tenant>` — release history (operator session for tenants
  you don't own).
- `rewind rollback <tenant> <dep_id>` — re-point live at an older deployment.
- `rewind provision` / `host add` / `plan set` / `move` / `route` — operator
  verbs (`is_root`); outward-facing (new tenant / new public host / live
  re-route) → confirm specifics with the user first.

## Traps

- **`dep_id` is a HEX STRING, always pass it as-is** — sha256-derived dep_ids
  exceed 2^53, so anything that coerces it to a number releases the wrong build.
- **`deploy` stages; it does not release** unless you pass `--release`. The live
  flip is the approval gate — keep it explicit.
- **System tenants** (`__admin__`, `__auth__`) are **operator-owned** — deploy /
  release them with `rewind-ops` (the **`deploy-admin`** skill), NOT this customer
  path. They deploy to their id, not their dir (`admin` → `__admin__`, `auth` →
  `__auth__`; the manifest encodes this). A **403** releasing a system tenant here
  is the ownership boundary working, not a bug — unless your OIDC session is
  itself an operator (`is_root`), in which case it's allowed but `deploy-admin` is
  still the intended path.
- **`{tenant}.rewindjs.app` hosts need no `host add`** (wildcard); apex/system
  hosts on `rewindjs.com` need it once.
- **(sim) a fetch result's `request.body` is BYTES** — a `fetch_chunk` is a
  binary activation. Decode it: `JSON.parse(new TextDecoder().decode(request.body))`.
  Plain `JSON.parse(request.body)` throws "unexpected data at the end".
- **(sim) the response HEAD is `response.*`; the RETURN value is the body or
  `next()`.** Write `response.status = 202; return "accepted"` — NOT
  `return { status: 202 }`, which ships a **200** with that object as the body.
- **(sim) it's what-if, not proof.** Durability shims (`webhook`/`schedule`/`cron`)
  are recorded, not re-run. A green sim means "the logic handles these inputs,"
  not "prod is correct."

## Gaps (surface, don't work around)

- **Multi-activation sagas aren't drivable in one command.** `sim` runs ONE
  activation. A request where an inbound fires `on.fetch`es whose resumes race —
  supplying the fetch responses, threading `ctx`, exploring interleavings — is
  prototyped (a scenario driver) but not a `rewind` verb yet. For now, `sim` each
  activation or `pull` the real request; surface the saga case as the gap.
- If `rewind` can't express a customer-needed operation, note it as a CLI/product
  gap rather than dropping to operator tooling.
