# CLAUDE.md — rewind-apps

First-party tenant **application code** for rewindjs (see `README.md` for the
repo's place in the rove / rewind-infra / rewind-apps split, the tenant→host map,
and publishing). This file covers how to work in it — especially the test gate.

## Tenants

`manifest.json` maps each source dir → tenant id → host(s). Handler code lives per
tenant; `marketing/`, `docs/`, `replay/` are **static-only** (no handlers). The
ones with handlers:

| dir | tenant | entry | notes |
|---|---|---|---|
| `admin/` | `__admin__` | `admin/index.mjs` | operator dashboard: instances, teams, deploy doors, source-read; OIDC relying party (`_middlewares` guard) |
| `auth/` | `__auth__` | `auth/index.mjs` | OIDC IdP + magic-link login |
| `agent-sample/agent/` | `agent-sample` | `agent-sample/agent/index.mjs` | reference browser-agent WS saga (note the nested `agent/` dir) |

Deploy/release/replay/sim/**test** these with the customer `rewind` CLI — see the
**`/rewind` skill** (`.claude/skills/rewind/`). System tenants (`__admin__`,
`__auth__`) deploy via `rewind-ops` — the **`/deploy-admin` skill**.

## Testing — offline handler suites + the CI gate

Every handler tenant has a `_tests/*.mjs` suite run offline through the real engine
by `rewind test` (no cluster, network, or secrets). `_tests/` never ships (the
deploy path strips it). **163 assertions** across:

- `admin/_tests/` — `release.mjs` (dep_id regression), `teams.mjs` (authz matrix +
  membership), `doors.mjs` (log/CP after.fetch relay), `deploy.mjs` (reset/file/cut
  + source-read saga). See `admin/_tests/README.md` for the admin fixture recipe.
- `auth/_tests/login.mjs` — magic-link security (single-use, expiry, open-redirect).
- `agent-sample/agent/_tests/agent.mjs` — the full WS agent loop.

Run locally (from the repo root):

```
rewind test ./admin
rewind test ./auth
rewind test ./agent-sample/agent
```

**CI gate:** `.github/workflows/rewind-test.yml` runs these on every PR/push touching
`admin/**`, `auth/**`, or `agent-sample/**`. It's a *real per-PR gate* (offline,
deterministic, runs on forked PRs) — distinct from `e2e.yml`, which hits live prod
and is a post-merge monitor. The gate builds the `rewind` CLI from a **pinned rove
commit** (`ROVE_REF`) via `zig build rewind` and caches the binary by that SHA.

> ⚠️ **Bump `ROVE_REF` when a suite starts using a newer `rewind test` feature.**
> The harness lives in rove; if a test uses a driver/matcher added after the pinned
> commit, CI errors on the missing method even though it passes locally (your local
> `rewind` is newer). Set `ROVE_REF` to a rove `main` SHA that includes the fix.

### Fixture recipe (the non-obvious bits)

- **Admin auth** goes through the real `_middlewares` OIDC guard: seed the RP config
  at `_config/oidc/rp/default` (values mirror `admin/_config/oidc/rp/default.json`)
  and an unexpired session `_rp/sess/{sid}` = `{sub, is_root, exp}`; the inbound
  carries `session: { id: "<sid>" }`. `is_root: true` = operator.
- **`admin: true`** unlocks `platform.*` (cross-tenant kv, root store, releases,
  compile, stampManifest) — admin-only, off by default.
- **M2M deploy paths** (`/v1/deploy/reset|file|cut`) accept a Bearer root token:
  `scenario({ rootToken })` + `headers: { authorization: "Bearer <token>" }`.
- **Membership / ownership** rows are `sha256(email)`-keyed — compute with the same
  `crypto.sha256(email.trim().toLowerCase())` in-test (`crypto` is available).
- **Scoped stores**: seed another tenant's kv via `instances: { <id>: { kv } }`,
  read back with `instanceKv(id, key)`; the platform root store via `root: { kv }`.
- Bodyless GET/DELETE need no special handling — `request.text` reads `""`.

For the `rewind:test` library surface (scenario/matchers/resume drivers), see the
`/rewind` skill and rove `docs/guides/testing.md`.

## The rove dependency

`rewind` (and its `rewind test` harness) is built from the **rove** repo (public,
`~/src/rove`). When the offline sim can't faithfully drive a handler shape, that's a
rove harness gap — **file it as a rove issue** (e.g. anarchodev/rove #3, #6) rather
than working around it, then bump `ROVE_REF` once the fix lands. Never reach for
operator tooling to route around a customer-CLI gap (the `/rewind` skill's one rule).
