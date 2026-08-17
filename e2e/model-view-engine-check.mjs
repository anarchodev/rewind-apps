// Run a handler on the REAL replay engine and assert the state pane's
// inputs are what the pane thinks they are.
//
// Why this exists, specifically: the pane shipped completely broken and
// nothing caught it. `e2e/model-view-check.mjs` pins the folding RULES
// but hand-builds their inputs, so it could not notice that the tape is
// a plain array (making `tapes.kv.entries` a *function*, which threw on
// every render) or that the `_cursor` field the pane read is never
// moved by anything. Both halves either side of the seam were verified;
// the seam was not.
//
// So this check owns the seam: it boots the actual WASM arena with the
// actual prelude and epilogue, runs a handler that reads and writes,
// and asserts the SHAPES the pane consumes — the tape, the overlay, the
// recorded reads, and the ordered interaction log — then folds them and
// checks the rows. No cluster, no browser, no capture.
//
// Run: node e2e/model-view-engine-check.mjs   (`npm run check:engine`)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, "..", "replay", "_static");

const { default: getArenaJs } = await import(pathToFileURL(path.join(STATIC, "qjs_arena_wasm.js")).href);
const { CursorEngine } = await import(pathToFileURL(path.join(STATIC, "cursor.mjs")).href);
const { buildRequestEpilogue, REPLAY_OUTPUT_KEY } =
    await import(pathToFileURL(path.join(STATIC, "request-replay.mjs")).href);
const { foldModelView, cutInteractionLog, pendingEffects } =
    await import(pathToFileURL(path.join(STATIC, "model-view.mjs")).href);

const failures = [];
const check = (label, ok, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
    if (!ok) failures.push(label);
};

// The tape channels rtap produces: PLAIN ARRAYS of entries. Written out
// literally here because the pane's first bug was assuming otherwise.
const KV_OP_GET = 0;
const KV_OK = 0, KV_NOT_FOUND = 1;
const tapes = {
    kv: [
        { op: KV_OP_GET, outcome: KV_OK, key: "cart/1", value: "7" },
        { op: KV_OP_GET, outcome: KV_NOT_FOUND, key: "cart/missing", value: "" },
    ],
    module: [],
    request_reads: [],
    fetch_responses: [],
    trigger_payload: [],
};

// A handler that reads both keys, writes one, reads back its own write
// (which must reach the overlay, NOT the recorded inputs), and queues a
// connection effect.
const ENTRY = "index.mjs";
const SOURCE = `
export default function () {
  const a = kv.get("cart/1");
  const missing = kv.get("cart/missing");
  kv.set("cart/1", "8");
  const back = kv.get("cart/1");
  after.ms(5000);
  return "a=" + a + " missing=" + missing + " back=" + back;
}
`;

const Module = await getArenaJs();
const arena_init_open = Module.cwrap("arena_init_open", "number", ["number", "number"]);
const arena_eval_base = Module.cwrap("arena_eval_base", "number", ["string"]);
const arena_freeze = Module.cwrap("arena_freeze", null, []);
const arena_destroy = Module.cwrap("arena_destroy", null, []);

const preludePath = path.join(STATIC, "arena-prelude.js");
if (!fs.existsSync(preludePath)) {
    console.log("  FAIL no arena-prelude.js — run rove's scripts/ops/gen_replay_prelude.py");
    process.exit(1);
}
if (arena_init_open(8192, 8192) !== 0) throw new Error("arena_init_open failed");
if (arena_eval_base(fs.readFileSync(preludePath, "utf-8")) !== 0)
    throw new Error("arena_eval_base(prelude) failed");
arena_freeze();

const epilogue = buildRequestEpilogue({
    record: { method: "GET", path: "/", host: "acme.test" },
    requestReads: [],
    bodyBytes: null,
    binaryBody: false,
    exportName: "default",
    activation: "inbound",
    captured: true,
    ctx: undefined,
    middlewarePath: null,
    tenant: "acme",
    sagaId: "sg-engine-check",
});

console.log("=== state pane: against the real engine ===");

const engine = new CursorEngine(Module);
const mat = await engine.materialise({
    entry: { name: ENTRY, src: SOURCE + epilogue },
    tapes,
    module_sources: { [ENTRY]: SOURCE },
    seed: 1n,
    timestamp_ns: 1786940000000000000n,
    js_engine_version: 1,
    outputKey: REPLAY_OUTPUT_KEY,
}, { targetSnapshots: 8 });

check("the handler ran to completion",
    mat.runStatus?.rc === 0 && mat.outcome != null,
    JSON.stringify(mat.runStatus) + " outcome=" + (mat.outcome ? "yes" : "null"));

// THE SHAPE. `tapes.kv` is the array itself; it has no `.entries`.
check("a tape channel is a plain array of entries",
    Array.isArray(mat.replay.tapes.kv) && mat.replay.tapes.kv.length === 2);
check("`.entries` on a tape is Array.prototype.entries, never the data",
    typeof mat.replay.tapes.kv.entries === "function");

// THE OVERLAY + THE RECORDED READS at end of run.
const end = mat.endKv;
check("the end-of-run view carries the writes the handler made",
    end && end.writes instanceof Map && end.writes.get("cart/1") === "8",
    end ? JSON.stringify([...end.writes]) : "null");
check("the end-of-run view records the keys actually read",
    Array.isArray(end.reads) && end.reads.includes("cart/1") && end.reads.includes("cart/missing"),
    JSON.stringify(end.reads));
// The read-back of its own write must be answered by the overlay, so it
// must NOT appear a second time in the recorded reads.
check("a read-your-write does not reach the recorded inputs",
    end.reads.filter((k) => k === "cart/1").length === 1, JSON.stringify(end.reads));

// THE FOLD over real inputs.
const rows = foldModelView({ kvEntries: mat.replay.tapes.kv, reads: end.reads, writes: end.writes });
const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
check("the fold produces rows from real engine state", rows.length >= 2, JSON.stringify(rows));
check("the written key reads back as yours, at the written value",
    byKey["cart/1"]?.origin === "you" && byKey["cart/1"]?.value === "8",
    JSON.stringify(byKey["cart/1"]));
check("a key the handler was served absent says absent",
    byKey["cart/missing"]?.origin === "read" && byKey["cart/missing"]?.state === "absent",
    JSON.stringify(byKey["cart/missing"]));
check("no harness bookkeeping leaks into the view",
    !rows.some((r) => r.key.startsWith("__rove_store/") || r.key === REPLAY_OUTPUT_KEY),
    JSON.stringify(rows.map((r) => r.key)));

// THE ORDERED INTERACTION LOG.
const log = mat.outcome?.effects || [];
check("the run parks an ordered interaction log", Array.isArray(log) && log.length > 0,
    JSON.stringify(log.map((e) => e.kind)));
const cut = cutInteractionLog(log, { reads: end.reads, writes: end.writes, end: true });
check("the whole log is confirmed at the end of the run",
    cut.confident === true, JSON.stringify(cut));
const fx = pendingEffects(log, cut.cut, end.writes);
check("the queued connection effect is surfaced",
    fx.some((e) => e.label === "after.ms" && e.detail === "5000 ms"),
    JSON.stringify(fx));

// A MID-RUN STOP: the pane's whole premise.
const mid = Math.max(0, Math.floor(mat.events.length / 2));
const snaps = await engine.inspectAt(mat, mid, { cluster: 0 });
const at = snaps.find((s) => s.eventOrdinal === mid) || snaps[0];
check("a mid-run stop carries its own Model view",
    at && at.kv && at.kv.writes instanceof Map && Array.isArray(at.kv.reads),
    at ? JSON.stringify({ writes: [...at.kv.writes], reads: at.kv.reads }) : "none");
check("a mid-run stop sees no more than the end of the run does",
    at.kv.reads.length <= end.reads.length && at.kv.writes.size <= end.writes.size,
    JSON.stringify({ mid: at.kv.reads.length, end: end.reads.length }));

arena_destroy();
if (failures.length) {
    console.log(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nPASS — the pane's inputs are what the engine actually produces");
