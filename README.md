# rewind-apps — rewindjs first-party tenant content (PRIVATE)

The application bundles for rewindjs's own tenants — the third concern, separate
from the engine and from deploy/secrets:

- **`rove`** (public) — the engine + the generic publish tooling.
- **`rewind-infra`** (private) — deploy config + secrets.
- **`rewind-apps`** (private, this) — first-party **application code**.

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
git history), so the *current* bundles are already public. This repo is the
**forward home** — future first-party work (new marketing/positioning, new
admin/auth logic — the control surface) stays private here.
