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

## Gotcha: bodyless requests need `body: ""`

`admin/index.mjs` `default()` reads `request.text` unconditionally (`rawBody:
request.text || ""`). In prod a GET request's body reads as `""`, but the offline
sim throws on a **missing** payload — so an authored bodyless inbound makes the
handler abort (swallowed to a 200) *after* `routeAuthz`, before the thunk runs. The
`call()` helpers therefore pass `body: ""` for any request without one, which
matches prod and lets the handler run.

This is a rove sim faithfulness gap (an authored bodyless inbound should read
`request.text` as `""`, not throw); once the harness defaults it, the `body: ""`
workaround can be dropped. Tracked in the rove-side test-harness notes.
