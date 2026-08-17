// Assert the saga viewer's TAPE RAIL renders a saga window correctly.
//
// Why this exists: the rail is the viewer's spine — it is what turns a
// pile of activations into "one saga, in order, with the world moving
// between its hops". Every claim it makes is a claim about data the
// customer cannot otherwise see, so a rail that renders plausibly but
// wrongly is worse than one that fails: a fabricated gap count or a
// fabricated "end" reads as fact.
//
// The rail draws from the saga window alone (`/v1/{t}/saga/{id}`) and
// renders BEFORE the engine boots, so this check needs no cluster, no
// WASM run, and no session: it serves the real `replay/_static`, seeds
// the sessionStorage cache the page already uses for refresh-safety,
// and asserts the DOM. The prod-facing Playwright specs cover the
// engine; this covers the rail's contract.
//
// Run: node e2e/tape-rail-check.mjs   (or `npm run check:tape` in e2e/)

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "replay", "_static");
const FRAG = "#/acme/req_0100000000000002";

const MIME = {
  ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json",
};

// Three hops of one saga, with the seams between them summarized. The
// stamps are real-shaped (`term << 40 | counter`), which is the whole
// reason the rail renders the counter rather than the raw number.
const T = 1n << 40n;
const SAGA = {
  saga: {
    saga_id: "sg-demo", first_received_ns: 1786940000000000000,
    last_received_ns: 1786940044000000000, activation_count: 3, error_count: 1,
    last_status: 204, closed_at_ns: 0, last_outcome: "ok",
    root_method: "POST", root_path: "/orders", root_host: "acme.test",
  },
  hops: [
    { request_id: "req_0100000000000001", exec_seq: String(T + 1n), received_ns: 1786940000000000000,
      duration_ns: 1000000, status: 201, method: "POST", path: "/orders", host: "acme.test",
      outcome: "ok", activation: "inbound" },
    { request_id: "req_0100000000000002", exec_seq: String(T + 5n), received_ns: 1786940002300000000,
      duration_ns: 2000000, status: 500, method: "POST", path: "wh_84c1", host: "",
      outcome: "handler_error", activation: "send_callback" },
    // A LATER term: leadership changed mid-saga, so the per-term
    // counter restarts and the rail must say which term it is in.
    { request_id: "req_0100000000000003", exec_seq: String(2n * T + 2n), received_ns: 1786940044000000000,
      duration_ns: 500000, status: 204, method: "POST", path: "retry.backoff", host: "",
      outcome: "ok", activation: "wake_batch" },
  ],
  gaps: [
    { after_seq: String(T + 1n), before_seq: String(T + 5n), count: 13, truncated: false, quiet_ns: 2299000000 },
    { after_seq: String(T + 5n), before_seq: String(2n * T + 2n), count: 1000, truncated: true, quiet_ns: 41000000000 },
  ],
  unplaced: [
    { request_id: "req_0100000000000009", exec_seq: "0", received_ns: 1786940001000000000,
      duration_ns: 1, status: 200, method: "GET", path: "/lost", host: "",
      outcome: "ok", activation: "inbound" },
  ],
  unplaced_truncated: false,
  next_cursor: { exec_seq: String(2n * T + 2n) },
};

const BUNDLE = {
  request_id: "req_0100000000000002", deployment_id: "dep_d41f0cabcdef1234",
  tenant_id: "acme", saga_id: "sg-demo", activation: "send_callback",
  entry_path: "handlers/webhooks.mjs",
  entry_source: "export function onDelivery() { return 'x'; }\n",
  modules: [
    { path: "handlers/webhooks.mjs", source: "export function onDelivery() { return 'x'; }\n" },
    { path: "index.mjs", source: "export default function () { return 'hi'; }\n" },
  ],
  app_imports: {}, packages: [], seed: "1",
  timestamp_ns: "1786940002300000000", js_engine_version: 1, tape_blobs: {},
  request: { method: "POST", path: "/orders", host: "acme.test" },
  response: { status: 500, outcome: "handler_error", console: "", exception: "" },
};

const failures = [];
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
  const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.addInitScript(([frag, payload]) => {
  sessionStorage.setItem("replay:bundle:" + frag, JSON.stringify(payload));
}, [FRAG, { bundle: BUNDLE, saga: SAGA }]);

console.log("=== saga viewer: tape rail ===");
await page.goto(base + "/" + FRAG, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#tape-list .tape__hop", { timeout: 20000 });

const hops = await page.$$eval("#tape-list .tape__hop", (els) => els.map((e) => ({
  text: e.textContent.replace(/\s+/g, " ").trim(),
  anchor: e.classList.contains("is-anchor"),
  current: e.getAttribute("aria-current"),
  seq: e.querySelector(".tape__seq")?.textContent ?? "",
})));
check("one row per hop", hops.length === 3, JSON.stringify(hops.map((h) => h.text)));
check("exactly one anchor, and it is the hop in view",
  hops.filter((h) => h.anchor).length === 1 && hops[1].anchor && hops[1].current === "true",
  JSON.stringify(hops.map((h) => h.anchor)));
check("a hop row carries kind, status and target",
  hops[0].text.includes("inbound") && hops[0].text.includes("201") &&
  hops[0].text.includes("POST /orders"), hops[0].text);

// The stamp is `term << 40 | counter`: show the counter, and surface
// the term only where it CHANGES — a counter restart across a
// leadership change is exactly where a bare counter would mislead.
check("a stamp renders as its per-term counter, not the raw 13-digit value",
  hops[0].seq === "#1" && hops[1].seq === "#5", JSON.stringify([hops[0].seq, hops[1].seq]));
check("a term change is marked where the counter restarts",
  hops[2].seq === "t2·#2", hops[2].seq);

const gaps = await page.$$eval("#tape-list .tape__gap", (els) => els.map((e) => ({
  text: e.textContent.trim(), truncated: e.classList.contains("tape__gap--truncated"),
})));
check("one gap line per seam between consecutive hops", gaps.length === 2, JSON.stringify(gaps));
check("a seam counts the foreign activations and the quiet time",
  gaps[0].text === "· 13 quiet · 2.3 s", gaps[0].text);
check("a capped count says so ('1000+') instead of stating a total",
  gaps[1].text.startsWith("· 1000+ quiet") && gaps[1].truncated, gaps[1].text);

const caps = await page.$$eval("#tape-list .tape__cap", (els) => els.map((e) => e.textContent.trim()));
check("the saga bracket has a begin and an end cap", caps.length === 2, JSON.stringify(caps));
check("an unclosed saga says 'open as of', never a fabricated end",
  caps[1].startsWith("open as of"), caps[1]);

const unplaced = await page.$$eval("#tape-list .tape__unplaced", (els) => els.map((e) => e.textContent.trim()));
check("unstamped hops ride as an addendum, never a made-up position",
  unplaced.length === 1 && unplaced[0] === "1 unplaced hop", JSON.stringify(unplaced));

const opts = await page.$$eval("#file-pick option", (els) => els.map((e) => ({ v: e.value, sel: e.selected })));
check("the file picker carries this hop's modules, entry selected",
  opts.length === 2 && opts.some((o) => o.v === "handlers/webhooks.mjs" && o.sel), JSON.stringify(opts));

const deploy = await page.textContent("#source-deploy");
check("the deploy hash sits with the hop's source (per-hop identity)",
  (deploy || "").startsWith("deploy d41f0c"), deploy);

const crumb = (await page.textContent(".crumb, #crumb").catch(() => "")) || "";
check("the crumb names the saga, the unit of playback",
  crumb.includes("sagas") && crumb.includes("sg-demo"), crumb.replace(/\s+/g, " ").trim());

// Hop switching is a NAVIGATION: URLs are saga-addressed, so the hop
// in view survives a refresh and can be linked to.
await page.click("#tape-list .tape__hop >> nth=2");
await page.waitForFunction(() => location.hash === "#/acme/req_0100000000000003",
  null, { timeout: 5000 }).catch(() => {});
check("clicking a hop navigates to that hop's own URL",
  page.url().endsWith("#/acme/req_0100000000000003"), page.url());

await browser.close();
server.close();
if (failures.length) {
  console.log(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nPASS — the tape rail renders the saga window");
