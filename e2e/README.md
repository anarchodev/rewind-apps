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
