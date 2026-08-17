import { test, expect } from "@playwright/test";
import { loginAsOperator } from "../lib/flow.js";
import { APP, OPERATOR_EMAIL, RESEND_API_KEY, dbg } from "../lib/config.js";

// Full lifecycle of the instance page's KV pane, against live prod:
// prefix-filter → create → edit+save → verify persisted (not just DOM) →
// delete → verify gone server-side. One test = one login email.
//
// The instance defaults to `__auth__` (guaranteed to exist — the login this
// test performs runs through it). All writes stay under the `e2e/` key
// prefix, which no first-party handler reads, and the key is deleted again
// both by the test body and by a belt-and-braces REST cleanup in `finally`.
const INSTANCE = process.env.E2E_KV_INSTANCE || "__auth__";
const KV_PATH = `/v1/instances/${encodeURIComponent(INSTANCE)}/kv`;

// WCAG relative-luminance contrast between a button's text colour and its
// EFFECTIVE background (walking up through transparent ancestors), computed
// in-page. Guards the class of bug where a broader `button.danger` rule
// paints a solid --danger fill under a per-pane rule that sets `color:
// var(--danger)` — danger-on-danger, ratio ~1, illegible.
async function contrastRatio(locator) {
  return locator.evaluate((el) => {
    const parse = (s) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = "1"] = m[1].split(",").map((x) => x.trim());
      return { r: +r, g: +g, b: +b, a: +a };
    };
    const effectiveBg = (node) => {
      for (let n = node; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) return c;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = parse(getComputedStyle(el).color);
    const bg = effectiveBg(el);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
}

test("KV pane: create, edit, persist, delete a key", async ({ page }) => {
  test.skip(!RESEND_API_KEY, "RESEND_API_KEY not set — the KV pane needs an authenticated dashboard");
  // login email round-trip + several raft-committed writes over prod.
  test.setTimeout(180_000);

  const key = `e2e/kv-${Date.now()}`;
  await loginAsOperator(page, OPERATOR_EMAIL);

  try {
    // The KV tab is click-selected (no hash for tabs) off the instance page.
    await page.goto(APP + "/#/instance/" + encodeURIComponent(INSTANCE));
    await page.locator("nav.tabs button.tab", { hasText: "KV" }).click();
    const panel = page.locator(".kv-panel");
    await expect(panel).toBeVisible();

    // Click Refresh and wait for the resulting server listing to land —
    // the pre-refresh DOM would otherwise satisfy "row present/absent"
    // assertions and mask a server-side persistence failure.
    async function refreshList() {
      const listed = page.waitForResponse(
        (r) => r.url().includes(KV_PATH) && r.request().method() === "GET" && r.ok(),
      );
      await panel.locator("button.refresh").click();
      await listed;
    }

    // Scope every listing to our prefix FIRST: the pane lists at most 200
    // entries, and a busy tenant (e.g. __auth__ sessions) can exceed that —
    // unfiltered, our key might legitimately not be on the page. This also
    // exercises the prefix filter itself.
    await panel.locator(".prefix-input").fill("e2e/");
    await refreshList();
    await expect(panel.locator(".count")).toHaveText(/entr(y|ies)/);

    // Create. The pane refreshes itself after the PUT; wait for the PUT to
    // actually succeed so the follow-up list can't race it.
    const putDone = page.waitForResponse(
      (r) => r.url().includes(KV_PATH) && r.request().method() === "PUT" && r.ok(),
    );
    await panel.locator('.kv-create input[name="key"]').fill(key);
    await panel.locator('.kv-create input[name="value"]').fill("v1");
    await panel.locator('.kv-create button[type="submit"]').click();
    await putDone;
    const row = panel.locator(`tr[data-key="${key}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator(".kv-value-input")).toHaveValue("v1");
    dbg("created", key);

    // Edit in place. Save arms only once the value diverges from the
    // original (fill fires the input events that enable it).
    const saveBtn = row.getByRole("button", { name: "Save" });
    await expect(saveBtn).toBeDisabled();
    await row.locator(".kv-value-input").fill("v2");
    await expect(saveBtn).toBeEnabled();
    const saveDone = page.waitForResponse(
      (r) => r.url().includes(KV_PATH) && r.request().method() === "PUT" && r.ok(),
    );
    await saveBtn.click();
    await saveDone;

    // Persisted, not just painted: a fresh server listing shows v2.
    await refreshList();
    await expect(row.locator(".kv-value-input")).toHaveValue("v2");
    dbg("edited + persisted", key);

    // Legibility guard on the destructive affordance (WCAG AA for normal
    // text is 4.5:1; danger-on-danger scores ~1).
    const delBtn = row.getByRole("button", { name: "Delete" });
    const ratio = await contrastRatio(delBtn);
    dbg("Delete button contrast ratio:", ratio.toFixed(2));
    expect(ratio, "Delete button text is illegible against its background").toBeGreaterThanOrEqual(4.5);

    // Delete (the pane confirm()s first) and verify the key is gone from a
    // fresh listing, not merely removed from the DOM.
    page.once("dialog", (d) => d.accept());
    const deleteDone = page.waitForResponse(
      (r) => r.url().includes(KV_PATH) && r.request().method() === "DELETE" && r.ok(),
    );
    await delBtn.click();
    await deleteDone;
    await expect(row).toHaveCount(0);
    await refreshList();
    await expect(panel.locator(`tr[data-key="${key}"]`)).toHaveCount(0);
    dbg("deleted", key);
  } finally {
    // Belt-and-braces: never leave a stray e2e key behind on a mid-test
    // failure. page.request shares the context's session cookie.
    await page.request
      .delete(APP + KV_PATH + "?key=" + encodeURIComponent(key))
      .catch(() => {});
  }
});
