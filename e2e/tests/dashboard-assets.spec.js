import { test, expect } from "@playwright/test";
import { loginAsOperator } from "../lib/flow.js";
import { watchAssets } from "../lib/netcheck.js";
import { OPERATOR_EMAIL, RESEND_API_KEY, APP, APP_HOST, dbg } from "../lib/config.js";

// Guards the dashboard's asset load path. Motivated by a real incident: the
// admin SPA's module scripts (`/api.js`, `/pages/*.js`) intermittently failed
// with `net::ERR_SSL_PROTOCOL_ERROR` — a fresh HTTP/2 connection to the front
// coming up broken while a warm connection kept serving 200s. The app "worked"
// (the first load succeeded) so nothing else caught it; only the console
// errors did.
//
// This can't *deterministically* reproduce an intermittent front flake, but it
// (a) fails loudly and with detail whenever it does happen, and (b) is a
// standing smoke that every first-party dashboard asset loads cleanly. The
// reloads force fresh connections/asset fetches to widen the catch window
// without hammering prod (a small, fixed count).
test("dashboard assets load cleanly (no SSL/connection failures)", async ({ page }) => {
  test.skip(!RESEND_API_KEY, "RESEND_API_KEY not set — dashboard modules load post-login");

  const net = watchAssets(page, APP_HOST);

  await loginAsOperator(page, OPERATOR_EMAIL);

  // A few full reloads: each re-fetches app.js + the page modules, often on a
  // freshly-opened connection — the exact condition that surfaced the SSL error.
  const RELOADS = 3;
  for (let i = 0; i < RELOADS; i++) {
    await page.reload({ waitUntil: "load" });
    // Back on the authenticated dashboard, not bounced to the IdP login form.
    await expect(page.locator('input[name="email"]')).toHaveCount(0);
    expect(new URL(page.url()).host).toBe(APP_HOST);
    dbg(`reload ${i + 1}/${RELOADS} ok:`, page.url());
  }

  const problems = net.problems();
  if (problems.length) {
    console.error(
      `Asset load problems on ${APP}:\n` +
        problems.map((p) => `  [${p.kind}] ${p.url} — ${p.detail}`).join("\n"),
    );
  }
  expect(problems, "same-origin asset load failures").toEqual([]);
});
