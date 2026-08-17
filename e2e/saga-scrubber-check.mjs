// Assert the saga viewer's SCRUBBER spans the saga, not one hop.
//
// Why this exists: the scrubber is the one surface that claims to show
// where you are in a causal chain and what happened in the parts of it
// you were not running. Every mark on it asserts something the customer
// cannot otherwise see — "a foreign activation wrote a key your next hop
// reads" — so a rail that draws plausibly but wrongly is worse than one
// that fails. A fabricated position, a seam nobody scanned drawn as a
// quiet one, or a mark in the wrong seam all read as fact.
//
// Like the tape rail, the saga geometry draws from index data alone
// (the saga window + the per-seam interference scans) and renders BEFORE
// the engine boots — so this check needs no cluster, no WASM run, and no
// session: it serves the real `replay/_static`, seeds the sessionStorage
// cache the page already uses for refresh-safety, and asserts the DOM.
//
// Run: node e2e/saga-scrubber-check.mjs   (or `npm run check:scrubber` in e2e/)

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

// Four hops, three seams. The stamps are real-shaped
// (`term << 40 | counter`) because the marks' positions are computed
// from them: a seam WITHIN one term has a measurable span, and a seam
// across a leadership change does not.
const T = 1n << 40n;
const hop = (id, seq, extra) => ({
  request_id: id, exec_seq: String(seq), received_ns: 1786940000000000000,
  duration_ns: 1000000, status: 200, method: "POST", path: "/orders",
  host: "acme.test", outcome: "ok", activation: "inbound", ...extra,
});

const SAGA = {
  saga: {
    saga_id: "sg-demo", first_received_ns: 1786940000000000000,
    last_received_ns: 1786940044000000000, activation_count: 4, error_count: 0,
    last_status: 204, closed_at_ns: 0, last_outcome: "ok",
    root_method: "POST", root_path: "/orders", root_host: "acme.test",
  },
  hops: [
    hop("req_0100000000000001", T + 1n, { status: 201 }),
    hop("req_0100000000000002", T + 5n, { activation: "send_callback", path: "wh_84c1" }),
    // A later term: leadership changed, so the seam before this hop has
    // no measurable span.
    hop("req_0100000000000003", 2n * T + 2n, { activation: "wake_batch", path: "retry.backoff" }),
    hop("req_0100000000000004", 2n * T + 9n, { activation: "disconnect", path: "" }),
  ],
  gaps: [
    { after_seq: String(T + 1n), before_seq: String(T + 5n), count: 13, truncated: false, quiet_ns: 2299000000 },
    { after_seq: String(T + 5n), before_seq: String(2n * T + 2n), count: 1000, truncated: true, quiet_ns: 41000000000 },
    { after_seq: String(2n * T + 2n), before_seq: String(2n * T + 9n), count: 5, truncated: false, quiet_ns: 900000000 },
  ],
  unplaced: [],
  unplaced_truncated: false,
  next_cursor: { exec_seq: String(2n * T + 9n) },
};

// One scan per seam the dashboard got to. The THIRD seam is absent —
// past the scan cap, or it failed — and the rail must render that as
// "not scanned", never as a seam where nothing happened.
const SEAMS = [
  {
    after_seq: String(T + 1n), before_seq: String(T + 5n),
    probe: { reads: 3, read_prefixes: 0, writes: 2, hop_tapes_truncated: false,
             before_no_tape: false, after_no_tape: false },
    scanned: 13, scan_truncated: false, skipped_no_tape: 0,
    interacting: [
      // A quarter of the way into the seam (stamp 2 of the open
      // interval 1..5), and it WROTE what the next hop reads.
      { request_id: "req_0100000000000021", exec_seq: String(T + 2n),
        received_ns: 1786940001000000000, status: 200, method: "POST",
        path: "/inventory", outcome: "ok", activation: "inbound",
        wrote: ["stock/sku-9"], read: [], keys_truncated: false },
      // Three quarters in, and it READ what the previous hop wrote.
      { request_id: "req_0100000000000022", exec_seq: String(T + 4n),
        received_ns: 1786940002000000000, status: 200, method: "GET",
        path: "/audit", outcome: "ok", activation: "inbound",
        wrote: [], read: ["order/1042"], keys_truncated: false },
    ],
  },
  {
    after_seq: String(T + 5n), before_seq: String(2n * T + 2n),
    probe: { reads: 1, read_prefixes: 1, writes: 0, hop_tapes_truncated: false,
             before_no_tape: false, after_no_tape: false },
    scanned: 1000, scan_truncated: true, skipped_no_tape: 4,
    interacting: [
      { request_id: "req_0100000000000031", exec_seq: String(T + 900n),
        received_ns: 1786940030000000000, status: 500, method: "POST",
        path: "/refund", outcome: "handler_error", activation: "wake_batch",
        wrote: ["order/1042"], read: [], keys_truncated: true },
    ],
  },
];

// The hop in view reads BOTH keys the seam before it touched, and
// writes one of its own — one row per blame outcome that matters, in
// the state pane below.
// `default`, not a named export: a send_callback activation dispatches
// the default export (`exportForActivation`), and a handler the epilogue
// cannot find simply never runs — leaving an empty pane that looks like
// a handler which read nothing.
const HANDLER = `export default function () {
  try { kv.get("stock/sku-9"); } catch (e) {}
  try { kv.get("order/1042"); } catch (e) {}
  kv.set("cart/mine", "1");
  return "x";
}
`;

const BUNDLE = {
  request_id: "req_0100000000000002", deployment_id: "dep_d41f0cabcdef1234",
  tenant_id: "acme", saga_id: "sg-demo", activation: "send_callback",
  entry_path: "handlers/webhooks.mjs",
  entry_source: HANDLER,
  modules: [
    { path: "handlers/webhooks.mjs", source: HANDLER },
  ],
  app_imports: {}, packages: [], seed: "1",
  timestamp_ns: "1786940002300000000", js_engine_version: 1, tape_blobs: {},
  request: { method: "POST", path: "/orders", host: "acme.test" },
  response: { status: 204, outcome: "ok", console: "", exception: "" },
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
}, [FRAG, { bundle: BUNDLE, saga: SAGA, seams: SEAMS }]);

console.log("=== saga viewer: the saga-spanning scrubber ===");
await page.goto(base + "/" + FRAG, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#scrubber-segments .scrubber__seg--hop", { timeout: 20000 });

// Geometry, read back as the browser laid it out. Percentages are the
// contract here: a mark's position only means anything relative to the
// seam it claims to be in.
const geom = await page.evaluate(() => {
  const pct = (el) => ({
    left: parseFloat(el.style.left), width: parseFloat(el.style.width),
  });
  const segs = [...document.querySelectorAll("#scrubber-segments .scrubber__seg--hop")]
    .map((e) => ({ ...pct(e), anchor: e.classList.contains("is-anchor"),
                   tag: e.tagName, title: e.title }));
  const seams = [...document.querySelectorAll("#scrubber-segments .scrubber__seam")]
    .map((e) => ({ ...pct(e), title: e.title,
                   unscanned: e.classList.contains("scrubber__seam--unscanned"),
                   truncated: e.classList.contains("scrubber__seam--truncated") }));
  const marks = [...document.querySelectorAll("#scrubber-segments .scrubber__mark")]
    .map((e) => ({ left: parseFloat(e.style.left), title: e.title,
                   wrote: e.classList.contains("scrubber__mark--wrote"),
                   read: e.classList.contains("scrubber__mark--read"),
                   unplaced: e.classList.contains("scrubber__mark--unplaced") }));
  return { segs, seams, marks };
});

check("one segment per hop of the saga", geom.segs.length === 4,
  JSON.stringify(geom.segs.map((s) => s.left.toFixed(1))));
check("one band per seam between consecutive hops", geom.seams.length === 3,
  JSON.stringify(geom.seams.map((s) => s.left.toFixed(1))));

// The rail is ordered and gapless: hop, seam, hop, seam, … covering the
// whole track. A hole would be a stretch of saga the rail forgot.
const ordered = [...geom.segs, ...geom.seams].sort((a, b) => a.left - b.left);
let contiguous = Math.abs(ordered[0].left) < 0.01;
for (let i = 1; i < ordered.length; i++) {
  if (Math.abs((ordered[i - 1].left + ordered[i - 1].width) - ordered[i].left) > 0.01) contiguous = false;
}
const last = ordered[ordered.length - 1];
check("the segments tile the whole rail, hop then seam, with no holes",
  contiguous && Math.abs(last.left + last.width - 100) < 0.01,
  JSON.stringify(ordered.map((s) => s.left.toFixed(2) + "+" + s.width.toFixed(2))));

check("exactly one segment is the hop in view", geom.segs.filter((s) => s.anchor).length === 1,
  JSON.stringify(geom.segs.map((s) => s.anchor)));
check("the hop in view is the second one, and is not a control",
  geom.segs[1].anchor && geom.segs[1].tag === "DIV", geom.segs[1].tag);
check("every other hop is a control that replays it",
  geom.segs.filter((s) => !s.anchor).every((s) => s.tag === "BUTTON" && /replay this hop/.test(s.title)),
  JSON.stringify(geom.segs.map((s) => s.tag)));

// A mark's position is its stamp's position in the seam — not an
// ordinal. Stamps 2 and 4 of the open interval (1,5) sit a quarter and
// three quarters in; even spacing would put them at a third and
// two thirds.
const s0 = geom.seams[0];
const inSeam0 = geom.marks.filter((m) => m.left >= s0.left && m.left <= s0.left + s0.width);
check("both interfering activations land in the seam they ran in",
  inSeam0.length === 2, JSON.stringify(geom.marks.map((m) => m.left.toFixed(2))));
const rel = inSeam0.map((m) => (m.left - s0.left) / s0.width);
check("a mark sits at its stamp's true position in the seam, not at an ordinal",
  Math.abs(rel[0] - 0.25) < 0.01 && Math.abs(rel[1] - 0.75) < 0.01,
  JSON.stringify(rel.map((r) => r.toFixed(3))));
check("neither placed mark claims the hollow 'position unknown' shape",
  inSeam0.every((m) => !m.unplaced), JSON.stringify(inSeam0.map((m) => m.unplaced)));

// The two directions of interference are different findings and read
// differently: they wrote what I read, or they read what I wrote.
check("a writer of a key this saga reads is marked as the write direction",
  inSeam0[0].wrote && !inSeam0[0].read && /wrote stock\/sku-9/.test(inSeam0[0].title),
  inSeam0[0].title);
check("a reader of a key this saga wrote is marked as the read direction",
  inSeam0[1].read && !inSeam0[1].wrote && /read order\/1042/.test(inSeam0[1].title),
  inSeam0[1].title);
check("a mark says what following it does — open that activation's own saga",
  /open this activation in its own saga/.test(inSeam0[0].title), inSeam0[0].title);

// A seam across a leadership change has no measurable span: the counter
// restarts, so there is no distance between its bounds. Ordering
// survives; spacing is not invented.
const s1 = geom.seams[1];
const inSeam1 = geom.marks.filter((m) => m.left >= s1.left && m.left <= s1.left + s1.width);
check("a mark in a seam that straddles a term change says its spacing is not measured",
  inSeam1.length === 1 && inSeam1[0].unplaced,
  JSON.stringify(inSeam1.map((m) => [m.left.toFixed(2), m.unplaced])));
check("a capped scan says the rail is showing a floor, not a total",
  s1.truncated && /hit its cap/.test(s1.title), s1.title);
check("a scan that could not probe every candidate says how many",
  /4 could not be probed/.test(s1.title), s1.title);

// The claim the rail must never make: an unexamined seam drawn as a
// quiet one.
const s2 = geom.seams[2];
check("a seam nobody scanned says so, instead of reading as quiet",
  s2.unscanned && /not scanned for interference/.test(s2.title), s2.title);
check("a scanned seam with nothing in it is NOT marked unscanned",
  !s0.unscanned && /none touched this saga's keys|touched this saga's keys/.test(s0.title), s0.title);

// ── With a run on the rail ───────────────────────────────────────────
//
// Everything above draws from index data. The rest needs the hop
// actually replayed: the playhead and its statement ticks live INSIDE
// the anchor segment, and getting that mapping wrong is invisible on a
// single-hop saga — which is what a hand-check would reach for.
await page.waitForFunction(
  () => /^completed · \d+ event/.test(document.getElementById("source-state")?.textContent || ""),
  null, { timeout: 120000 });

const anchor = geom.segs[1];
const run = await page.evaluate(() => ({
  chip: document.querySelector(".scrubber__playhead-chip")?.textContent || "",
  playhead: parseFloat(document.getElementById("scrubber-playhead").style.left),
  ticks: [...document.querySelectorAll("#scrubber-ticks .scrubber__tick")]
    .map((e) => parseFloat(e.style.left)),
}));

check("the playhead reads in saga grain — which hop, and where inside it",
  /^hop 2\/4 · \d+\/\d+$/.test(run.chip), run.chip);
check("the playhead sits inside the hop in view, not in raw rail space",
  run.playhead >= anchor.left - 0.01 && run.playhead <= anchor.left + anchor.width + 0.01,
  `${run.playhead} vs [${anchor.left}, ${anchor.left + anchor.width}]`);
check("this hop's statement ticks stay inside this hop's segment",
  run.ticks.length > 0 && run.ticks.every(
    (t) => t >= anchor.left - 0.01 && t <= anchor.left + anchor.width + 0.01),
  JSON.stringify(run.ticks.map((t) => t.toFixed(2))));

// Dragging is confined to the hop in view: the rest of the rail is
// other hops and seams. The gesture starts inside the anchor segment
// (pressing elsewhere is pressing another hop's control — a
// navigation) and drags off its left edge; the playhead must clamp to
// this hop's first event rather than walk into hop 1, which this
// window has not loaded and whose events it cannot show.
const box = await page.locator(".scrubber").boundingBox();
const midAnchor = (anchor.left + anchor.width / 2) / 100;
await page.mouse.move(box.x + box.width * midAnchor, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.02, box.y + box.height / 2);
await page.mouse.up();
const dragged = await page.evaluate(() => ({
  chip: document.querySelector(".scrubber__playhead-chip")?.textContent || "",
  playhead: parseFloat(document.getElementById("scrubber-playhead").style.left),
  hash: location.hash,
}));
check("a drag past the start of this hop clamps to it, never into another hop",
  dragged.playhead >= anchor.left - 0.01 && /^hop 2\/4 · /.test(dragged.chip) &&
  dragged.hash === "#/acme/req_0100000000000002",
  `${dragged.playhead} · ${dragged.chip} · ${dragged.hash}`);

// ── Blame: who wrote the value this hop was served ───────────────────
//
// The same seam scan, read from the other direction. A mark asks "what
// did this seam do to me?"; a chip in the state pane asks "who did this
// to THIS key?" — and following either lands in the same place.
// At the end of the run every read has happened — the drag above left
// the playhead at the hop's first event, where the handler has
// correctly seen nothing yet.
await page.click('.transport__controls button[aria-label="Jump to end"]');
await page.waitForSelector("#state-kv .statepane__row", { timeout: 30000 });
const kvRows = await page.$$eval("#state-kv .statepane__row", (els) => els.map((e) => ({
  key: e.querySelector(".statepane__key")?.textContent || "",
  chip: e.querySelector(".statepane__origin")?.textContent || "",
  title: e.querySelector(".statepane__origin")?.title || "",
  tag: e.querySelector(".statepane__origin")?.tagName || "",
  blame: !!e.querySelector(".statepane__origin--blame"),
})));
const rowFor = (k) => kvRows.find((r) => r.key === k);

const written = rowFor("stock/sku-9");
check("a value written in the seam before this hop names its writer",
  written?.blame && written.chip === "POST /inventory" && written.tag === "BUTTON",
  JSON.stringify(written));
check("the blame chip says what it found and what following it does",
  /wrote stock\/sku-9/.test(written?.title || "") &&
  /open it in its own saga viewer/.test(written?.title || ""), written?.title);

// The mistake that would make every chip untrustworthy: the seam's
// OTHER activation only read this key, and must never be named as
// having written it.
const observed = rowFor("order/1042");
check("a key the seam only READ is not blamed on its reader",
  observed && !observed.blame && observed.chip === "read", JSON.stringify(observed));
check("and the pane says why there is no name — a scanned seam, nothing wrote it",
  /nothing in the seam before this hop wrote it/.test(observed?.title || ""),
  observed?.title);

const own = rowFor("cart/mine");
check("a key this handler wrote stays 'you' — it is reading its own value",
  own && own.chip === "you" && !own.blame, JSON.stringify(own));

// Following a blame chip is the same jump as a seam mark, and equally
// must not disturb the window that asked.
const anchorBefore = page.url();
const [blamePopup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 10000 }),
  page.click("#state-kv .statepane__origin--blame"),
]);
check("following a blame chip opens the writer in its own viewer",
  blamePopup.url().endsWith("#/acme/req_0100000000000021"), blamePopup.url());
check("the window that asked keeps its own anchor", page.url() === anchorBefore, page.url());
await blamePopup.close();

// Following a MARK is a new window anchored at that activation — and it
// must never disturb the window that asked. (With no opener, as here,
// the viewer opens the saga-addressed URL itself; from the dashboard it
// asks the dashboard, which holds the session.)
const before = page.url();
const [popup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 10000 }),
  page.click("#scrubber-segments .scrubber__mark >> nth=0"),
]);
check("following a mark opens a new viewer anchored at that activation",
  popup.url().endsWith("#/acme/req_0100000000000021"), popup.url());
check("the window that asked keeps its own anchor", page.url() === before, page.url());
await popup.close();

// Following a hop segment is the same navigation the tape rail does:
// saga-addressed, refresh-safe. Last, because it leaves this page on
// another hop.
await page.click("#scrubber-segments .scrubber__seg-btn >> nth=0");
await page.waitForFunction(() => location.hash === "#/acme/req_0100000000000001",
  null, { timeout: 5000 }).catch(() => {});
check("clicking another hop's segment navigates to that hop's own URL",
  page.url().endsWith("#/acme/req_0100000000000001"), page.url());

await browser.close();
server.close();
if (failures.length) {
  console.log(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nPASS — the scrubber spans the saga, and its marks are placed, not invented");
