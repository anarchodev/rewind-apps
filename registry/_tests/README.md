# registry `_tests/` — offline saga tests (`rewind test ./registry`)

The real handlers run through the offline `rewind test` engine — no cluster, no
network. From the repo root:

```
rewind test ./registry     # publish.mjs, resolve.mjs
```

## What's covered

- **`publish.mjs`** — the source-only, gated, immutable publish path (issue #1
  §2): the operator-only auth gate, spec/version validation, the reserved
  `@rewind` scope, the privileged-surface reject (`_system` / `__rove`, mirror
  of rove `referencesPrivilegedSurface`), capability extraction, dependency
  freezing (own deps → concrete dep `pkg_hash`es), and immutability
  (idempotent identical re-publish / 409 on divergent content).
- **`resolve.mjs`** — the resolve API (§3) that returns the manifest-v2
  Resolution lockfile shape, plus discovery (§4): encapsulation + dedup + the
  nested `private` copy, `overrides`, unsatisfiable-dep 422, and the
  list/get/version/blob read endpoints.

## Fixture conventions

- **Auth.** Publish gates behind the real `_middlewares/index.mjs` OIDC guard,
  so a scenario seeds the RP config at `_config/oidc/rp/default` (the values
  config-mirrored from `registry/_config/oidc/rp/default.json` on deploy) and an
  unexpired session `_rp/sess/{sid}` = `{sub, is_root, exp}`; the inbound carries
  `session: { id: "<sid>" }`. `is_root: true` = operator (the only role that may
  publish in v1). **Resolve + discovery are public** — those inbounds carry no
  session. (Same recipe as `admin/_tests/README.md`, minus `admin: true` — the
  registry is a plain operator tenant with no `platform.*`.)

- **`pkg_hash` is a wire contract, so the tests recompute it independently.**
  Both suites carry a standalone reimplementation of the JCS formula
  (`canon` / `pkgHash`) and assert byte-for-byte equality against what the
  handler returns — an independent reimplementation is the proof the content
  identity is reproducible across publishers.

- **Writes don't leak between inbounds.** So `publish.mjs` fires one publish per
  assertion and reads back its own writes via `res.kv(...)`; `resolve.mjs`
  **seeds** already-published packages into kv (source blob + version record,
  twice-keyed by `pkg/ver/{spec}/{version}` and `pkg/hash/{pkg_hash}`, + a
  `pkg/idx/{spec}` row) with content-consistent hashes.

- **`res.kv(key)`** returns JSON values already parsed (a raw string for a
  non-JSON blob like stored source) — don't `JSON.parse` it again.

## kv layout (this tenant's own home store)

```
pkg/src/{source_hash}        raw source bytes (content-addressed, deduped)
pkg/ver/{spec}/{version}     immutable version record (JSON)
pkg/hash/{pkg_hash}          same record, keyed by content identity (resolve)
pkg/idx/{spec}               [{version, pkg_hash}, ...]  (discovery + resolve)
```

The `spec` (`@rewind/jwt`) contains a `/`, which kv keys allow (rove `6513ce0`).

For the `rewind:test` library surface (scenario/matchers), see the `/rewind`
skill and rove `docs/guides/testing.md`.
