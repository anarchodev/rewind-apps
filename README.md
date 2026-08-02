# rewind-apps — rewindjs first-party tenant content

The application bundles for rewindjs's own tenants — the third concern, separate
from the engine and from deploy/secrets:

- **`rove`** (public) — the engine + the generic publish tooling.
- **`rewind-infra`** (private) — deploy config + secrets.
- **`rewind-apps`** (public, this) — first-party **application code**.

## Contents

`manifest.json` is the declarative list; each entry maps a source dir → a tenant
id → the host(s) the front routes to it. The engine has no built-in knowledge of
these — this manifest + the dirs are the entire "first-party-ness."

| dir | tenant | host(s) |
|---|---|---|
| `marketing/` | `marketing` | rewindjs.com |
| `docs/` | `docs` | docs.rewindjs.com |
| `replay/` | `replay` | replay.rewindjs.com |
| `auth/` | `__auth__` | auth.rewindjs.com (OIDC IdP) |
| `admin/` | `__admin__` | app.rewindjs.com (operator dashboard) |
| `agent-sample/` | `agent-sample` | (no host) |

`rove.js` / `rove-agent.js` are shared client SDK assets used across the apps.

## Testing

Handler tenants (`admin/`, `auth/`, `agent-sample/`) carry offline `_tests/*.mjs`
suites run through the real engine by `rewind test` — no cluster, network, or
secrets. Run locally with e.g. `rewind test ./admin`. The `rewind-test` GitHub
workflow gates every PR that touches a handler tenant (it builds the `rewind` CLI
from a pinned `rove` commit and runs all suites). This is separate from `e2e.yml`,
which drives live prod as a post-merge monitor. See `CLAUDE.md` for the test-gate
details and the fixture recipe.

## Publishing

The publisher (`scripts/publish_firstparty.py`) and `rewind-ops` live in the
**`rove`** repo and are operator-neutral; they're pointed at THIS repo:

```bash
cd ~/src/rove
REWIND_APPS_DIR=~/src/rewind-apps scripts/publish_firstparty.py \
  --ops-bin zig-out/bin/rewind-ops --env <(cd ~/src/rewind-infra && scripts/render-env.sh ops)
# or: scripts/publish_firstparty.py --apps-dir ~/src/rewind-apps ...
```

## Secrets

**No secrets live here.** App-level secrets (e.g. the Google OAuth client secret)
live in the tenant KV (`__auth__` `_config/oauth/google.json`), set via the admin
app / `rewind-ops kv-put` — not in this repo. See `rewind-infra/ROTATION.md` §F.

## Note: history

This content was previously in the public `rove` repo (served live + in `rove`'s
git history), so the *current* bundles were already public before the move. This
repo is the **forward home** for first-party work — new marketing/positioning,
new admin/auth logic, the control surface.

## License

Copyright (C) 2026 Loop46, Inc.

This content is free software under the GNU Affero General Public License,
version 3 or later — `SPDX-License-Identifier: AGPL-3.0-or-later`, the same
license as the `rove` engine it runs on. The complete text is in
[`LICENSE`](LICENSE), reproduced verbatim, because the AGPL requires conveying
a copy along with the program.

Distributed WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

These are working applications, not templates: they are the tenants that serve
rewindjs.com, the docs, the dashboard, and the identity plane. Read them as
worked examples of the handler contract — they use the same public surface any
tenant does. Secrets are not here; they live in tenant KV.
