# rewind-apps e2e (Playwright)

Browser-driven end-to-end tests for the rewind.js first-party apps. Unlike
HTTP-level checks, these drive a real browser against the **live production**
platform (`app.rewindjs.com` / `auth.rewindjs.com`, which serve this repo's
`admin/` + `auth/` tenants) and exercise flows a user actually performs.

> Moved here from the `rove` repo — these drive first-party app *content*
> (this repo), not the engine.

## First test: magic-link login

`tests/login.spec.js` drives the full operator sign-in:

1. Open `app.rewindjs.com` unauthenticated → the admin SPA bounces through
   the OIDC relying-party handshake to the `auth.rewindjs.com` IdP login
   form.
2. Submit the operator email; the platform sends a magic-link email via
   **Resend** (`auth/index.mjs` → `email.send`).
3. Read that email back out of **our own Resend account** using the
   "list sent emails" API (`GET /emails` → `GET /emails/{id}`) and extract
   the `…/login/verify?mt=…` link. No inbox needed — it's an email *we
   sent*.
4. Open the link in the same browser context → verify → `/authorize` →
   app `/_rp/callback` poll page completes the session.
5. Assert we land authenticated at `app.rewindjs.com/#/instances`.

Each run sends a real email and mints a real prod session. That's by
design (true end-to-end), but it means: don't run it in a tight loop.

## Replay: load an existing request

`tests/replay.spec.js` exercises the WASM replay pipeline end-to-end on a
real captured request:

1. Log in as the operator — which itself produces fresh `__auth__` handler
   records, so the "existing request" is guaranteed and minutes old.
2. Open the `__auth__` instance's Logs tab and click **Replay** on the
   newest record.
3. The dashboard composes the bundle (log record + that deployment's
   historical sources) and hands it to the `replay.rewindjs.com` popup via
   the postMessage handshake.
4. Assert the arenajs WASM engine boots, re-executes the handler from its
   tapes, and materialises the timeline: `#source-state` reaches
   `completed · N event(s)`, the popup shows the same `method path` as the
   row clicked, at least one event card renders, variable snapshots were
   captured, and no replay-origin asset failed to load.

Override the target with `E2E_REPLAY_INSTANCE` / `E2E_REPLAY_URL` (see
`.env.example`). Run just this spec with
`npx playwright test tests/replay.spec.js` (env loaded as under Run below).

History: this spec's very first prod run (2026-07-04) caught a real front
bug — h2 responses over ~100–200 KB truncated with a TLS `bad record mac`,
so the ~1 MiB `qjs_arena_wasm.wasm` could never load in a browser
(anarchodev/rove#2). Fixed infra-side and verified green 2026-07-05. If it
reddens with `WASM load failed`, suspect that class first
(`curl -sS -o /dev/null -w "%{size_download}B\n"
https://replay.rewindjs.com/qjs_arena_wasm.wasm` should print 1050175).

## KV pane: full key lifecycle

`tests/kv.spec.js` drives the instance page's KV tab end-to-end on
`__auth__` (override with `E2E_KV_INSTANCE`): prefix-filter to `e2e/`,
create a unique `e2e/kv-<ts>` key, edit it in place, **verify the edit via
a fresh server listing** (not the already-painted DOM), delete it through
the confirm() dialog, and verify the key is gone from another fresh
listing. A `finally` REST delete guarantees no stray key survives a
mid-test failure.

It also asserts the Delete button's WCAG contrast (text vs. effective
background) is ≥ 4.5:1 — its first prod run (2026-08-16) failed here at
ratio 1.0: a broader `button.danger` rule painted a solid `--danger` fill
under the pane's outline-style `color: var(--danger)` override,
danger-on-danger. Fixed in `admin/_static/app.css` the same day; the spec
goes green once the fixed admin bundle is republished.

## Cluster-free checks (`npm run check:*`)

The `*-check.mjs` scripts are a different family from the specs above:
they need no cluster, no session, and no prod. Each serves the real
`replay/_static` (and, for the handshake check, the real
`admin/_static/api.js`) off a throwaway localhost server, seeds only the
inputs a surface actually consumes, and asserts the DOM. They are the
gate for surfaces whose every claim is about data the customer cannot
otherwise see — where rendering plausibly but wrongly is worse than
failing.

| Script | Owns |
|---|---|
| `check:surface` | the epilogue's installed request surface |
| `check:tape` | the tape rail — the saga window as a list of hops |
| `check:scrubber` | the saga-spanning scrubber: hop segments, seam bands, where each interference mark is placed, and the state pane's blame chips |
| `check:handshake` | the dashboard ↔ viewer seam: that the seam scans are issued, capped, and drawn — and that following a mark opens a second viewer |
| `check:model` | the Model view's rules, including who the value a hop was served is blamed on |
| `check:engine` | those rules against what the WASM arena really produces |
| `check:response` | the wire response the shell derives from a re-execution |
| `check:body` | a payload the record kept only a pointer to is resolved, or refused |

`npm run check` runs the node-only ones — the always-on CI lane
(`.github/workflows/replay-checks.yml`). `npm run check:browser` runs the
playwright-driven ones (`check:tape`, `check:scrubber`, `check:handshake`),
which are deliberately out of that lane: they need an install and a browser
download. Run them by hand when touching the saga viewer.

`check:scrubber` and `check:handshake` split deliberately. The first
seeds the viewer's cache directly, so it proves the rail draws what it
is given; the second drives the shipped `api.js` against the real
viewer, so it proves something gives it that. A rail rendering every
seam "not scanned" because the dashboard quietly stopped scanning looks
exactly like a saga whose seams are genuinely quiet — only the second
check can tell those apart.

## Setup

```bash
cd e2e
npm install
npx playwright install chromium   # one-time browser download
cp .env.example .env              # then fill in RESEND_API_KEY
```

`RESEND_API_KEY` must be a **full-access** key (read scope) for the Resend
account that sends rewindjs sign-in emails. A send-only key 401s on the
list call. The test `skip`s itself if the key is absent.

## Run

```bash
set -a; . ./.env; set +a     # load env into the shell
npm test                     # headless
npm run test:headed          # watch the browser
npm run test:debug           # Playwright inspector (step through)
npm run report               # open the HTML report after a run
```

## Config

All targets are env-overridable (see `.env.example`): `E2E_APP_URL`,
`E2E_AUTH_URL`, `E2E_LOGIN_EMAIL`. Defaults point at production with the
seeded operator identity.

## Notes

- `retries: 0`, `workers: 1` — never hammer prod. Re-run by hand.
- Traces / screenshots / video are retained only on failure
  (`playwright-report/`).
- The magic-link extraction lives in `lib/resend.js`, reusable by future
  email-driven tests (signup, password reset, etc.).
