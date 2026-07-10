# admin `_tests/` — offline saga tests (`rewind test ./admin`)

These run the real handlers through the offline `rewind test` engine — no cluster,
no network. Run them from the repo root:

```
rewind test ./admin      # release.mjs, teams.mjs, doors.mjs
```

## Fixture conventions

- **Auth.** Handlers gate behind the real `_middlewares/index.mjs` OIDC guard, so a
  scenario seeds the RP config at `_config/oidc/rp/default` (the same values
  config-mirrored from `admin/_config/oidc/rp/default.json` on deploy) and an
  unexpired session record `_rp/sess/{sid}` = `{sub, is_root, exp}`. The inbound then
  carries `session: { id: "<sid>" }`. Use `is_root: true` for an operator.
- **`admin: true`.** The dashboard uses `platform.*` (cross-tenant kv, root store,
  releases.publish, instances.create), which is admin-only — the scenario must opt in.
- **Membership** rows are `sha256(email)`-keyed; fixtures compute the hash with the
  same `crypto.sha256(email.trim().toLowerCase())` (`userHashFor`) the handler uses.
- **Bodyless requests** (GET/DELETE) need no special handling — an authored inbound with
  no `body` reads `request.text` as `""`, matching prod (rove `2e27da3`).
