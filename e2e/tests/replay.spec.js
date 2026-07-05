import { test, expect } from "@playwright/test";
import { loginAsOperator } from "../lib/flow.js";
import { watchAssets } from "../lib/netcheck.js";
import {
  APP,
  REPLAY_HOST,
  OPERATOR_EMAIL,
  RESEND_API_KEY,
  dbg,
} from "../lib/config.js";

// Replays an EXISTING request end-to-end through the production replay
// pipeline: dashboard Logs tab → composeReplayBundle (log record + the
// historical sources of the deployment that ran it) → popup to
// replay.<suffix> → postMessage handshake → the arenajs WASM engine boots
// in the popup, re-executes the handler from its tapes, and materialises
// the drill timeline.
//
// The instance defaults to `__auth__`: the login flow this test performs
// is itself a series of __auth__ handler runs (IdP form GET, magic-link
// POST, verify), so fresh replayable records are guaranteed to exist —
// no pre-seeded state, and the "existing request" is minutes old at most.
const INSTANCE = process.env.E2E_REPLAY_INSTANCE || "__auth__";

test("replay shell loads an existing request end-to-end", async ({ page }) => {
  test.skip(!RESEND_API_KEY, "RESEND_API_KEY not set — replay needs an authenticated dashboard");
  // login (email round-trip) + bundle compose + ~1 MiB WASM boot + a full
  // re-execution — comfortably more than the suite's 120 s default.
  test.setTimeout(240_000);

  await loginAsOperator(page, OPERATOR_EMAIL);

  // Straight to the instance's Logs tab (the operator sees every tenant).
  await page.goto(APP + "/#/instance/" + encodeURIComponent(INSTANCE));
  const firstRow = page.locator("tr.log-row").first();
  await firstRow.waitFor({ state: "visible", timeout: 30_000 });

  // Newest record first — with INSTANCE=__auth__ that's one of the handler
  // runs our own login just produced. Remember its path so we can assert
  // the popup replayed THIS record, not just any record.
  const method = (await firstRow.locator("td.method").innerText()).trim();
  const path = (await firstRow.locator("td.path").innerText()).trim();
  dbg("replaying newest record:", method, path);

  // Replay opens a cross-origin popup — but only after composeReplayBundle
  // has fetched the record + sources, so give the popup event some slack.
  const popupPromise = page.waitForEvent("popup", { timeout: 45_000 });
  await firstRow.locator("button.replay").click();
  const popup = await popupPromise;

  // Standing guard on the replay origin's own assets (index.html, the
  // .mjs modules, the ~1 MiB .wasm) — same front-flake class the
  // dashboard-assets spec watches for on app.<suffix>.
  const net = watchAssets(popup, REPLAY_HOST);
  popup.on("pageerror", (err) => dbg("replay pageerror:", err.message));

  await popup.waitForURL((u) => u.host === REPLAY_HOST, { timeout: 15_000 });

  // wasm-app.mjs writes `completed · N event(s)` into #source-state once
  // the engine has re-run the handler and materialised the timeline. Any
  // load failure instead renders a "load error" badge + message into
  // #appbar-meta — race the two so a failure reports immediately instead
  // of waiting out the success timeout.
  const sourceState = popup.locator("#source-state");
  const completed = expect(sourceState)
    .toHaveText(/completed · \d+ event\(s\)/, { timeout: 90_000 })
    .catch(async (err) => {
      const state = await sourceState.innerText().catch(() => "(unreadable)");
      throw new Error(`replay never completed — source-state: "${state}"`, {
        cause: err,
      });
    });
  const failed = popup
    .locator("#appbar-meta .badge--error")
    .waitFor({ state: "visible", timeout: 90_000 })
    .then(
      async () => {
        const meta = await popup.locator("#appbar-meta").innerText().catch(() => "(unreadable)");
        throw new Error(`replay shell reported a load error: "${meta}"`);
      },
      // No error badge within the window is the GOOD case — park this arm
      // forever and let `completed` decide the outcome.
      () => new Promise(() => {}),
    );
  await Promise.race([completed, failed]);
  dbg("replay completed:", await sourceState.innerText());

  // The record replayed is the row we clicked (appbar meta renders the
  // bundle's `method path`, composed from the same log record).
  await expect(popup.locator("#appbar-meta")).toContainText(path);

  // A real timeline materialised: at least one visible event card, and
  // the run captured variable snapshots (diagnostic hook wasm-app.mjs
  // exposes for exactly this kind of smoke).
  await expect(popup.locator("#event-stream li.ev").first()).toBeVisible();
  const snapshots = await popup.evaluate(
    () => window.__mat_varSnapshots_count__ ?? 0,
  );
  expect(snapshots, "materialise() captured variable snapshots").toBeGreaterThan(0);

  const problems = net.problems();
  if (problems.length) {
    console.error(
      `Asset load problems on ${REPLAY_HOST}:\n` +
        problems.map((p) => `  [${p.kind}] ${p.url} — ${p.detail}`).join("\n"),
    );
  }
  expect(problems, "replay-origin asset load failures").toEqual([]);
});
