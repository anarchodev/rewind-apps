// Replay a captured record in node and print the digest the replay computed.
//
// This is the smallest useful version of the three-engine idea (rove#195):
// production captured a record and recorded what the handler DID; this
// re-executes that record in the replay engine and recomputes the same digest.
// Agreement is the first actual evidence that a replay reproduces production
// behaviour rather than merely finishing — every prior claim rested on the
// response status, which two different executions can share.
//
// Driven by rove's `scripts/smoke/interaction_digest_smoke_v2.py`, which
// supplies a record captured seconds earlier from a real local worker.
//
//   node replay-digest-check.mjs <record.json> <entry-source-file> [path=file ...]
//
// Trailing `path=file` pairs add the rest of the bundle's modules, so a handler
// that imports its own helpers can be replayed — a single-module check would
// pass for the one shape real tenants never have.
//
// Prints one JSON line: {"replayed": "<hex>|null", "error": "<why>"|null}.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, "..", "replay", "_static");

const [recordPath, entryPath, ...extraArgs] = process.argv.slice(2);
const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.error ? 1 : 0); };
if (!recordPath || !entryPath) out({ replayed: null, error: "usage: <record.json> <entry.mjs>" });

const record = JSON.parse(readFileSync(recordPath, "utf-8"));
const entrySrc = readFileSync(entryPath, "utf-8");
const tapesField = record.tapes || {};

const { buildTapesFromBlobs } = await import(join(STATIC, "rtap.mjs"));
const { buildRequestEpilogue, REPLAY_OUTPUT_KEY } = await import(join(STATIC, "request-replay.mjs"));
const getArenaJs = (await import(join(STATIC, "qjs_arena_wasm.js"))).default;

const b64 = (s) => (s ? Uint8Array.from(Buffer.from(s, "base64")) : null);

const Module = await getArenaJs();
const init_open = Module.cwrap("arena_init_open", "number", ["number", "number"]);
const eval_base = Module.cwrap("arena_eval_base", "number", ["string"]);
const freeze = Module.cwrap("arena_freeze", null, []);
const run_mod = Module.cwrap("arena_run_module", "number", ["string", "string"]);
const setSeed = Module.cwrap("arena_set_random_seed", null, ["number", "number"]);
const setNow = Module.cwrap("arena_set_date_now", null, ["number", "number"]);

if (init_open(8192, 8192) !== 0) out({ replayed: null, error: "arena_init_open failed" });
if (eval_base(readFileSync(join(STATIC, "arena-prelude.js"), "utf-8")) !== 0)
  out({ replayed: null, error: "arena_eval_base(prelude) failed" });
freeze();

let tapes;
try {
  tapes = buildTapesFromBlobs({
    kv: b64(tapesField.kv_tape_b64),
    module: b64(tapesField.module_tree_b64),
    request_reads: b64(tapesField.request_reads_tape_b64),
    fetch_responses: b64(tapesField.fetch_responses_tape_b64),
    trigger_payload: b64(tapesField.trigger_payload_tape_b64),
  });
} catch (e) {
  out({ replayed: null, error: "tape decode failed: " + e.message });
}

// Pin the same execution context production ran under — the seed and clock are
// inputs, and a replay that drew different randomness or read a different
// clock would diverge for a reason that is not the handler's behaviour.
const seed = BigInt(tapesField.seed ?? 0);
setSeed(Number(seed & 0xffffffffn), Number((seed >> 32n) & 0xffffffffn));
const ms = BigInt(tapesField.timestamp_ns ?? 0) / 1000000n;
setNow(Number(ms & 0xffffffffn), Number((ms >> 32n) & 0xffffffffn));

Module._kvOverlay = new Map();
Module.tapes = tapes;
// The bundle the handler imports from. The entry is keyed `index.mjs` because
// that is the specifier the epilogue runs; siblings keep the paths they were
// deployed under, since that is what an `import "./lib.mjs"` resolves to.
Module.module_sources = { "index.mjs": entrySrc };
for (const pair of extraArgs) {
  const eq = pair.indexOf("=");
  if (eq < 1) out({ replayed: null, error: `bad module arg ${pair} (want path=file)` });
  Module.module_sources[pair.slice(0, eq)] = readFileSync(pair.slice(eq + 1), "utf-8");
}

const epilogue = buildRequestEpilogue({
  record: { method: record.method, path: record.path, host: record.host },
  requestReads: tapes.request_reads,
  bodyBytes: b64(tapesField.request_body_b64),
  exportName: tapesField.export || "default",
  activation: record.activation || "inbound",
});

let stderrCap = "";
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (c) => { stderrCap += c.toString(); return true; };
const rc = run_mod("index.mjs", entrySrc + epilogue);
process.stderr.write = origWrite;

const raw = Module._kvOverlay.get(REPLAY_OUTPUT_KEY);
if (raw == null) {
  const why = (stderrCap.match(/message=([^\n]{0,120})/) || [])[1] || `rc=${rc}`;
  out({ replayed: null, error: "replay produced no outcome: " + why });
}
const parsed = JSON.parse(raw);
out({
  replayed: parsed.digest ?? null,
  error: null,
  // The folded sequence, so a disagreement can be read element by element
  // instead of guessed at from one opaque hash.
  effects: (parsed.effects || []).map((e) => [e.kind, e.op ?? "", e.key ?? e.url ?? e.prefix ?? String(e.ms ?? ""), String(e.value ?? e.on ?? "").slice(0, 30), e.present === undefined ? "" : String(e.present)]),
  status: parsed.status,
  result: typeof parsed.result === "string" ? parsed.result.slice(0, 40) : parsed.result,
});
