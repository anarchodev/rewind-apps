---
name: deploy-admin
description: Deploy / release the SYSTEM tenants of this repo (__admin__, __auth__) with the operator `rewind-ops` CLI. Use when asked to deploy / publish / release / ship / roll back the admin app (dashboard + deploy app) or the auth app — or when a system-tenant deploy via the customer `rewind` CLI is rejected (403 = the ownership boundary, not a bug). System tenants are operator-owned (root-token / move-secret), so the customer OIDC `rewind` CLI is the wrong tool for them; customer-style content (marketing / docs / agent-sample) still uses the `rewind` skill.
---

# /deploy-admin — ship system tenants with the operator CLI

`__admin__` (the dashboard + the standing deploy app) and `__auth__` are **system
tenants**: operator-owned, no customer account owns them. They deploy through the
operator CLI **`rewind-ops`**, which authenticates with a **platform secret**
(root token / move-secret) — NOT the OIDC session the customer `rewind` CLI
carries. Customer-style tenants dogfood the `rewind` skill; this skill is the
operator boundary.

## This skill vs the `rewind` skill

- **This skill (`rewind-ops`)** — `__admin__`, `__auth__`, anything operator-owned.
  Also the fallback if a system-tenant deploy via `rewind` returns **403**: that's
  the ownership boundary working (unless your OIDC session is itself an operator).
- **The `rewind` skill** — customer-style tenants (marketing, docs, agent-sample),
  the dogfooded OIDC path.

## Preconditions

- **`rewind-ops` binary** — rove-built: in the rove checkout, `zig build
  rewind-ops` → `zig-out/bin/rewind-ops` (put it on PATH or call it by path).
- **`~/.config/rove/prod.env`** — the operator env `rewind-ops` reads by default
  (root token, `REWIND_MOVE_SECRET`, `REWIND_ADMIN_DOMAIN`, worker URLs, S3).
  Override the path with `rewind-ops --env <file> …`.
- **`manifest.json`** (repo root) maps tenant → source dir → hosts. `dir != id`
  for system tenants (`admin` → `__admin__`, `auth` → `__auth__`).

## Deploy one system tenant — stage, then release (approval-gated)

Stage first, show the result, get a yes, then release. Do **not** pass
`--release` by default — the live flip is the approval gate.

1. `rewind-ops deploy __admin__ admin` — classify + stage the `admin/` bundle
   through the standing `__admin__` workspace flow. Prints a `dep_id` (hex
   string). Does **not** go live. (`__admin__` redeploying itself is expected —
   the standing app hosts its own workspace flow.)
2. Report: the `dep_id`, N handler(s) / N static(s), any compile warnings.
3. On the go-ahead: `rewind-ops release __admin__ <dep_id_hex>` → flips
   `_deploy/current` live. (Or re-run step 1 with `--release` once pre-approved.)
4. Verify: a request to the tenant's host returns **200** —
   `curl -sS -o /dev/null -w '%{http_code}' https://app.rewindjs.com/` (expect
   `200`; run it a few times — an intermittent SSL-EOF/502 is an *edge* problem,
   not this deploy).

`__auth__` is the same shape: `rewind-ops deploy __auth__ auth [--release]`, host
`auth.rewindjs.com`.

## Deploy ALL first-party tenants (bulk)

```
python3 <rove-checkout>/scripts/ops/publish_firstparty.py \
    --apps-dir <this repo> [--tenants __admin__,__auth__] [--dry-run]
```

Reads `manifest.json` and runs provision + deploy + release + host-map per tenant
through `rewind-ops`. `--tenants` targets a subset; `--dry-run` prints the plan
first.

## dep_id is a HEX STRING — pass it verbatim

sha256-derived dep_ids exceed 2^53, so a JSON **number** loses precision and would
release the **wrong** build. `deploy` returns the hex id; hand it to `release`
as-is. (The admin app rejects a numeric dep_id outright, and the customer
`rewind` CLI's release was fixed to post the REST route with a hex string.)

## Notes

- `rewind-ops` reaches prod over the private plane / admin domain (HTTP, not SSH)
  on a **platform secret**, so a system-tenant release is outward-facing — confirm
  the go-live with the user.
- Platform **binaries** (worker / cp / front / logs) are a different path — the
  rewind-infra `/deploy` skill, not this.
