---
name: rewind
description: Deploy / release / replay first-party app content (this repo's tenants) using the `rewind` customer CLI — the dogfooded, OIDC-authed path we expect customers to use. Use when asked to deploy, ship, release, roll back, replay, or pull logs for a rewind-apps tenant (marketing, docs, admin, auth, agent-sample, or a customer-style app). This is the tenant-CONTENT path; deploying platform binaries is a different repo (rewind-infra `/deploy`).
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

## Replay a production request (debugging — pull then replay)

Deterministic re-execution is `pull` → `replay` (this is today's "sim"; the
dedicated `sim` verb is not built yet — see Gaps):

1. `rewind logs <tenant> [--limit N]` → find the `req_id`.
2. `rewind pull <tenant> <req_id> -o /tmp/fixture.json` → the recorded request +
   tape.
3. `rewind replay /tmp/fixture.json [--source-dir <dir>] [-o out.json]` →
   re-executes locally (no cluster, no network) and emits the LLM-JSON result.
   `--source-dir` replays the working-tree handler against the recorded effects,
   so you can confirm a fix reproduces / diverges before deploying.

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
- **System tenants** deploy to their id, not their dir (`admin` → `__admin__`,
  `auth` → `__auth__`); the manifest encodes this. Whether the privileged
  `__admin__`/`__auth__` can be deployed over the *customer* (non-root) session
  or still need an operator session is unconfirmed — if a system-tenant deploy is
  rejected, that's the operator boundary, not a bug.
- **`{tenant}.rewindjs.app` hosts need no `host add`** (wildcard); apex/system
  hosts on `rewindjs.com` need it once.

## Gaps (surface, don't work around)

- **`sim` is not a verb yet** (planned). Use `pull` → `replay` for deterministic
  re-execution today.
- If `rewind` can't express a customer-needed operation, note it as a CLI/product
  gap rather than dropping to operator tooling.
