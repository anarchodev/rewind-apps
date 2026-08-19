// Assert the DASHBOARD half of the saga viewer's seam surface: that it
// scans a saga's seams, hands the scans to the viewer, and opens a new
// viewer when the viewer asks to follow a mark.
//
// Why this exists as its own check: `saga-scrubber-check.mjs` seeds the
// viewer's cache directly, so it proves the rail draws what it is given
// — and proves nothing about whether anything gives it that. The two
// halves talk over a postMessage handshake and a same-origin log
// chokepoint, and a rail that renders every seam "not scanned" because
// the dashboard silently stopped sending scans looks exactly like a
// saga whose seams are genuinely quiet. So this check owns the seam
// itself: the REAL `admin/_static/api.js` driving the REAL
// `replay/_static` viewer, with only the log-server responses stubbed.
//
// Both origins collapse to one here: `replayOpen` derives the replay
// origin by replacing the `app.` label of its own, and the viewer
// derives the dashboard origin by replacing `replay.` — on a bare
// 127.0.0.1 host neither label exists, so each resolves to the other's
// actual origin and the origin checks on both sides stay live.
//
// Run: node e2e/seam-handshake-check.mjs   (or `npm run check:handshake` in e2e/)

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPLAY_ROOT = path.join(HERE, "..", "replay", "_static");
const ADMIN_ROOT = path.join(HERE, "..", "admin", "_static");

const MIME = {
  ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json",
};

// Thirteen hops ⇒ twelve seams. Two are quiet (count 0) and need no
// scan at all — their gap count already answers the question. Of the
// ten left, the dashboard's cap scans eight and leaves two, so this one
// fixture pins all three states a seam can be in: scanned, quiet, and
// never looked at.
const T = 1n << 40n;
const HOPS = 13;
const QUIET_GAPS = new Set([1, 4]); // gap indices with nothing in them
const SCAN_CAP = 8;                 // api.js's SEAM_SCAN_CAP

const hops = [];
for (let i = 0; i < HOPS; i++) {
  hops.push({
    request_id: `req_010000000000000${i.toString(16)}`,
    exec_seq: String(T + BigInt(i) * 100n + 1n),
    received_ns: 1786940000000000000 + i * 1000000000,
    duration_ns: 1000000, status: 200, method: "POST", path: "/orders",
    host: "acme.test", outcome: "ok", activation: "inbound",
  });
}
const gaps = [];
for (let i = 0; i < HOPS - 1; i++) {
  gaps.push({
    after_seq: hops[i].exec_seq, before_seq: hops[i + 1].exec_seq,
    count: QUIET_GAPS.has(i) ? 0 : 7, truncated: false, quiet_ns: 500000000,
  });
}

const ANCHOR = hops[0].request_id;
const SAGA = {
  saga: {
    saga_id: "sg-demo", first_received_ns: hops[0].received_ns,
    last_received_ns: hops[HOPS - 1].received_ns, activation_count: HOPS,
    error_count: 0, last_status: 200, closed_at_ns: 0, last_outcome: "ok",
    root_method: "POST", root_path: "/orders", root_host: "acme.test",
  },
  hops, gaps, unplaced: [], unplaced_truncated: false,
  next_cursor: { exec_seq: hops[HOPS - 1].exec_seq },
};

// The activation the viewer will be asked to follow: it sits in the
// FIRST seam and wrote a key the saga's second hop reads.
const FOREIGN_ID = "req_0100000000000099";

const BUNDLE = {
  request_id: ANCHOR, deployment_id: "dep_d41f0cabcdef1234",
  tenant_id: "acme", saga_id: "sg-demo", activation: "inbound",
  entry_path: "index.mjs",
  entry_source: "export default function () { return 'hi'; }\n",
  modules: [{ path: "index.mjs", source: "export default function () { return 'hi'; }\n" }],
  app_imports: {}, packages: [], seed: "1",
  timestamp_ns: "1786940000000000000", js_engine_version: 1, tape_blobs: {},
  request: { method: "POST", path: "/orders", host: "acme.test" },
  response: { status: 200, outcome: "ok", console: "", exception: "" },
};

const failures = [];
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
}

// One origin serving the viewer at `/`, the dashboard's real api.js
// under `/_admin/`, and a harness page that drives it.
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
  if (url === "/_harness.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HARNESS_HTML);
    return;
  }
  const root = url.startsWith("/_admin/") ? ADMIN_ROOT : REPLAY_ROOT;
  const rel = url.startsWith("/_admin/") ? url.slice("/_admin".length) : url;
  const file = path.join(root, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

// The harness stubs ONE thing: the log chokepoint's responses. Every
// other line of the exchange — the seam scan loop, the cap, the
// postMessage handshake, the compose on a followed mark — is the
// shipped `api.js` running for real.
const HARNESS_HTML = `<!doctype html><meta charset="utf-8"><title>seam handshake harness</title>
<script type="module">
import { api } from "/_admin/api.js";

const SAGA = ${JSON.stringify(SAGA)};
const BUNDLE = ${JSON.stringify(BUNDLE)};
const FOREIGN_ID = ${JSON.stringify(FOREIGN_ID)};
window.__seamUrls = [];
window.__showUrls = [];

const json = (o) => new Response(JSON.stringify(o),
  { status: 200, headers: { "content-type": "application/json" } });

window.fetch = async (input) => {
  const u = new URL(String(input), location.origin);
  const p = u.pathname;
  if (p.endsWith("/saga/sg-demo")) return json(SAGA);
  if (p.endsWith("/seam")) {
    window.__seamUrls.push(u.search);
    const after = u.searchParams.get("after_seq");
    const before = u.searchParams.get("before_seq");
    // Only the saga's FIRST seam has an interfering activation in it.
    const first = after === SAGA.gaps[0].after_seq;
    return json({
      after_seq: after, before_seq: before,
      probe: { reads: 1, read_prefixes: 0, writes: 1, hop_tapes_truncated: false,
               before_no_tape: false, after_no_tape: false },
      scanned: 7, scan_truncated: false, skipped_no_tape: 0,
      interacting: first ? [{
        request_id: FOREIGN_ID, exec_seq: String(BigInt(after) + 2n),
        received_ns: 1786940000500000000, status: 200, method: "POST",
        path: "/inventory", outcome: "ok", activation: "inbound",
        wrote: ["stock/sku-9"], read: [], keys_truncated: false,
      }] : [],
    });
  }
  if (p.includes("/show/")) {
    window.__showUrls.push(p);
    // Enough of a record for composeReplayBundle; its sources fetch
    // 404s below, which is the sourcesUnavailable path it already has.
    return json({ record: {
      request_id: p.slice(p.lastIndexOf("/") + 1),
      deployment_id: "dep_d41f0cabcdef1234", saga_id: "sg-other",
      tenant_id: "acme", activation: "inbound", method: "POST",
      path: "/inventory", host: "acme.test", status: 200, outcome: "ok",
      tapes: {},
    } });
  }
  return new Response("not found", { status: 404 });
};

window.__open = () => api.replayOpen(BUNDLE, "acme", ${JSON.stringify(ANCHOR)});
<\/script>`;

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
const dash = await ctx.newPage();
dash.on("pageerror", (e) => console.log("  [dash pageerror]", e.message));

console.log("=== saga viewer: the dashboard ↔ viewer seam handshake ===");
await dash.goto(base + "/_harness.html", { waitUntil: "domcontentloaded" });

const [viewer] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 15000 }),
  dash.evaluate(() => window.__open()),
]);
viewer.on("pageerror", (e) => console.log("  [viewer pageerror]", e.message));
await viewer.waitForSelector("#scrubber-segments .scrubber__seam", { timeout: 30000 });

// The scans the dashboard actually issued. A quiet gap is answered by
// its own count — scanning it would be a round-trip to learn nothing.
const seamUrls = await dash.evaluate(() => window.__seamUrls);
const quietScanned = [...QUIET_GAPS].filter(
  (i) => seamUrls.some((u) => u.includes("after_seq=" + gaps[i].after_seq)));
check("a gap with nothing in it is never scanned",
  quietScanned.length === 0, JSON.stringify(quietScanned));
check("the scan stops at its cap instead of one round-trip per seam",
  seamUrls.length === SCAN_CAP, `${seamUrls.length} scans issued`);

const rail = await viewer.evaluate(() => ({
  seams: [...document.querySelectorAll("#scrubber-segments .scrubber__seam")]
    .map((e) => ({ title: e.title, unscanned: e.classList.contains("scrubber__seam--unscanned") })),
  marks: [...document.querySelectorAll("#scrubber-segments .scrubber__mark")]
    .map((e) => e.title),
  hops: document.querySelectorAll("#scrubber-segments .scrubber__seg--hop").length,
}));

check("the viewer draws every hop of the saga the dashboard sent",
  rail.hops === HOPS, String(rail.hops));
check("the viewer draws every seam of the saga the dashboard sent",
  rail.seams.length === HOPS - 1, String(rail.seams.length));
check("the scans crossed the handshake and became marks on the rail",
  rail.marks.length === 1 && /wrote stock\/sku-9/.test(rail.marks[0]),
  JSON.stringify(rail.marks));

// The two ways a seam ends up without a scan must not look alike, and
// neither may look like a seam that was scanned and found quiet.
const quiet = rail.seams.filter((s) => /^0 activation/.test(s.title));
check("a quiet seam reads as scanned-and-empty, not as unscanned",
  quiet.length === QUIET_GAPS.size && quiet.every((s) => !s.unscanned),
  JSON.stringify(quiet.map((s) => s.title)));
const unscanned = rail.seams.filter((s) => s.unscanned);
check("seams past the scan cap read as not scanned, never as quiet",
  unscanned.length === (HOPS - 1) - QUIET_GAPS.size - SCAN_CAP &&
  unscanned.every((s) => /not scanned for interference/.test(s.title)),
  JSON.stringify(rail.seams.map((s) => s.unscanned)));

// Following a mark: the viewer asks, the dashboard composes, a SECOND
// viewer opens anchored at that activation. The session never leaves
// the dashboard — which is why the viewer has to ask at all.
const [second] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 15000 }),
  viewer.click("#scrubber-segments .scrubber__mark >> nth=0"),
]);
const showUrls = await dash.evaluate(() => window.__showUrls);
check("following a mark makes the DASHBOARD compose that activation",
  showUrls.some((u) => u.endsWith(FOREIGN_ID)), JSON.stringify(showUrls));
check("following a mark opens a second viewer anchored at that activation",
  second.url().endsWith("#/acme/" + FOREIGN_ID), second.url());
check("the viewer that asked keeps its own anchor",
  viewer.url().endsWith("#/acme/" + ANCHOR), viewer.url());

await browser.close();
server.close();
if (failures.length) {
  console.log(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nPASS — the dashboard scans the seams and the viewer draws them");
