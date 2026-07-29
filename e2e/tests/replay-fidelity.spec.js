import { test, expect } from "@playwright/test";
import { loginAsOperator } from "../lib/flow.js";
import { APP, REPLAY_HOST, OPERATOR_EMAIL, RESEND_API_KEY, dbg } from "../lib/config.js";

// The replay-fidelity gate (rove#229).
//
// `replay.spec.js` proves the shell LOADS and materialises a timeline.
// This proves the timeline is TRUE: for a corpus of real captured
// records, re-running the handler must reproduce what production
// recorded — same status, no throw the live run didn't have.
//
// Why a gate and not a one-off check: every replay↔prod divergence found
// so far (rove#214 fixture schema, #222's three module-pipeline bugs,
// #227 missing engine shims, #228 the host timezone) was discovered by a
// human replaying one record and hitting the next wall. One bug per
// session, found by luck. A capture is only worth keeping if replaying it
// tells the truth, so that property belongs in CI.
//
// The corpus is the first-party tenants' own recent traffic: `__auth__`
// serves the login flow this test performs, so records are minutes old
// and cover package imports, crypto, kv and encoding on real paths.
const INSTANCE = process.env.E2E_REPLAY_INSTANCE || "__auth__";
// How many of the newest records to put through the gate. Each is a full
// WASM boot + re-execution (~5 s), so this trades wall-clock for
// coverage; raise it when hunting, keep it modest in CI.
const CORPUS = Number(process.env.E2E_REPLAY_CORPUS || 4);

// Divergences we have already diagnosed and filed. The gate's job is to
// catch the NEXT one, so a known shape is reported and not failed —
// otherwise the suite is permanently red and stops being read.
//
// An entry earns its place by naming the issue that will delete it. Each
// matches on the verdict plus a signature of the failure, so a record
// that diverges the same way for a DIFFERENT reason still fails.
const KNOWN = [
  {
    issue: "rove#245",
    what: "request.session is never recorded, so a session-gated handler takes its no-session branch",
    match: (f) => f.verdict === "mismatch" && /no session context/.test(String(f.replayedResult ?? "")),
  },
];

function knownFor(fidelity, label) {
  for (const k of KNOWN) {
    try {
      if (k.match(fidelity ?? {}, label)) return k;
    } catch (_) { /* a matcher that throws simply does not match */ }
  }
  return null;
}

test("captured records replay faithfully", async ({ page }) => {
  test.skip(!RESEND_API_KEY, "RESEND_API_KEY not set — needs an authenticated dashboard");
  test.setTimeout(120_000 + CORPUS * 60_000);

  await loginAsOperator(page, OPERATOR_EMAIL);
  await page.goto(APP + "/#/instance/" + encodeURIComponent(INSTANCE));
  await page.locator("tr.log-row").first().waitFor({ state: "visible", timeout: 30_000 });

  const rows = page.locator("tr.log-row");
  const available = await rows.count();
  const n = Math.min(CORPUS, available);
  expect(n, `no records to replay for ${INSTANCE}`).toBeGreaterThan(0);
  dbg(`gating ${n} of ${available} records for ${INSTANCE}`);

  const failures = [];
  const known = [];
  const checked = [];

  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const method = (await row.locator("td.method").innerText()).trim();
    const path = (await row.locator("td.path").innerText()).trim();
    const liveStatus = Number((await row.locator("td.status").innerText()).trim());
    const label = `${method} ${path} (live ${liveStatus})`;

    const popupPromise = page.waitForEvent("popup", { timeout: 45_000 });
    await row.locator("button.replay").click();
    const popup = await popupPromise;
    popup.on("pageerror", (err) => dbg(`[${label}] pageerror:`, err.message));

    try {
      await popup.waitForURL((u) => u.host === REPLAY_HOST, { timeout: 15_000 });

      // Race completion against the shell's own load-error badge, so a
      // failure reports immediately instead of waiting out the timeout.
      const sourceState = popup.locator("#source-state");
      const completed = expect(sourceState)
        .toHaveText(/completed · \d+ event\(s\)/, { timeout: 90_000 });
      const loadFailed = popup
        .locator("#appbar-meta .badge--error")
        .waitFor({ state: "visible", timeout: 90_000 })
        .then(
          async () => {
            const meta = await popup.locator("#appbar-meta").innerText().catch(() => "(unreadable)");
            throw new Error(`${label}: shell reported a load error: "${meta.replace(/\s+/g, " ").trim()}"`);
          },
          () => new Promise(() => {}),
        );
      await Promise.race([completed, loadFailed]);

      const fidelity = await popup.evaluate(() => window.__replay_fidelity__ ?? null);
      const events = await popup.locator("#event-stream li.ev").count();
      dbg(`[${label}] ${JSON.stringify(fidelity)} · ${events} event(s)`);
      checked.push({ label, fidelity });

      const hit = knownFor(fidelity, label);
      if (hit && fidelity && fidelity.verdict !== "match") {
        known.push(`${label}: ${hit.issue} — ${hit.what}`);
      } else if (!fidelity) {
        failures.push(`${label}: shell exposed no fidelity verdict`);
      } else if (fidelity.verdict === "mismatch") {
        failures.push(
          `${label}: replayed ${fidelity.replayedStatus}, capture recorded ${fidelity.capturedStatus}`);
      } else if (fidelity.verdict === "incomplete") {
        failures.push(
          `${label}: replay did not complete${fidelity.threw ? " (threw where the live run did not)" : ""}` +
          (fidelity.run ? ` [rc=${fidelity.run.rc}${fidelity.run.oom ? ", arena exhausted" : ""}]` : ""));
      }
      // "unknown" (capture carries no status) is not a failure — there is
      // nothing to compare, and saying otherwise would make the gate lie.

      // A throw is only legitimate when production itself failed. Below
      // 500 the live run finished cleanly, so a THROW is the replay's own
      // — the #227 shape (a missing global) and the loudest way a replay
      // misleads: the timeline stops somewhere production never did.
      if (fidelity?.threw && liveStatus < 500 && !hit) {
        failures.push(`${label}: THROW in the replayed timeline, but the live run returned ${liveStatus}`);
      }
    } catch (err) {
      // A record that cannot even load IS a fidelity failure — collect it
      // and keep going, so one bad capture doesn't mask the others.
      const hit = knownFor(null, label);
      const msg = err.message.includes(label) ? err.message : `${label}: ${err.message}`;
      if (hit) known.push(`${label}: ${hit.issue} — ${hit.what}`);
      else failures.push(msg);
    } finally {
      await popup.close().catch(() => {});
    }
  }

  // Known divergences are reported every run, never silently swallowed —
  // a suppressed failure nobody sees is how a gate rots.
  if (known.length) {
    console.log(
      `\n${known.length}/${n} replayed records diverged in a KNOWN, filed way:\n` +
        known.map((k) => "  · " + k).join("\n"));
  }

  if (failures.length) {
    throw new Error(
      `${failures.length}/${n} replayed records diverged from their capture in a NEW way:\n` +
        failures.map((f) => "  ✗ " + f).join("\n") +
        `\n\nChecked: ${checked.map((c) => c.label).join(", ")}` +
        `\n\nIf one of these is expected, it needs an issue and a KNOWN entry — not a deleted assertion.`);
  }
});
