// Replay-side `request` reconstruction — the consumer of the
// `request_reads` tape channel (read-taping; src/tape/root.zig).
//
// `buildRequestEpilogue` returns a JS source string the caller APPENDS
// to the entry module's source before `arena_run_module`. Appended
// lines never shift the original line numbers, so the trace timeline
// stays aligned with the deployed source. The epilogue:
//
//   - rebuilds `globalThis.request` with the SAME lazy-accessor shape
//     the worker installs (src/js/globals.zig installRequest): header
//     getters from the recorded name set, values from the recorded
//     reads; body / cookies / ip accessors; `unmaskedIp()` method;
//   - throws a loud REPLAY-DIVERGENCE error when the handler reads
//     anything the capture tape didn't record (never a silent
//     undefined — an unrecorded read means the handler is
//     nondeterministic relative to the capture, or capture is buggy);
//   - stamps a fresh `globalThis.response`;
//   - invokes the activation's export through `__arena_entry_ns()`
//     (the arenajs reactor's entry-module namespace accessor — the
//     only way to reach an anonymous `export default` from appended
//     code) and parks the result on `globalThis.__replay_result`.
//
// Shared by the browser shell (wasm-app.mjs) and the node smoke
// driver (scripts/replay_wasm_smoke.mjs) — one epilogue builder, one
// behavior.

import { READ_KIND_HEADER_NAMES, READ_KIND_HEADER_VALUE, READ_KIND_BODY_READ, READ_KIND_IP_MASKED, READ_KIND_IP_RAW } from "./rtap.mjs";

// Sentinel kv key the epilogue parks the re-executed outcome under; the
// shell reads it back from the kv overlay after a run. Mirrors the native
// driver's OUTPUT_KEY (rove src/replay/host.zig) — the same side channel,
// because the arena's own result value is unreachable from the host.
export const REPLAY_OUTPUT_KEY = "__replay_output__";

const _decoder = new TextDecoder("utf-8", { fatal: false });
const _encoder = new TextEncoder();

function _toBase64(bytes) {
    const b = typeof bytes === "string" ? _encoder.encode(bytes) : bytes;
    let bin = "";
    for (let i = 0; i < b.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

/// The export an activation kind invokes — mirrors
/// `rpc_dispatch.defaultExportForKind` (src/js/rpc_dispatch.zig).
export function exportForActivation(activation) {
    switch (activation) {
        case "wake_batch":
        case "kv_wake":
        case "timer":           return "onWake";
        case "disconnect":      return "onDisconnect";
        case "ws_message":      return "onMessage";
        case "inbound_headers": return "onHeaders";
        case "inbound_chunk":   return "onChunk";
        default:                return "default";
    }
}

/// Fold a parsed `request_reads` entry list (rtap.mjs decode shape:
/// `{kind, name, value}`) into the lookup tables the epilogue embeds.
export function foldRequestReads(entries) {
    const out = {
        names: [],            // header_names JSON, parsed
        values: {},           // header name → recorded value
        bodyRead: false,
        ipMasked: null,       // {value} when recorded ("" ⇒ null returned)
        ipRaw: null,
    };
    for (const e of entries || []) {
        switch (e.kind) {
            case READ_KIND_HEADER_NAMES:
                try { out.names = JSON.parse(e.value); } catch { out.names = []; }
                break;
            case READ_KIND_HEADER_VALUE:
                out.values[e.name] = e.value;
                break;
            case READ_KIND_BODY_READ:
                out.bodyRead = true;
                break;
            case READ_KIND_IP_MASKED:
                out.ipMasked = { value: e.value };
                break;
            case READ_KIND_IP_RAW:
                out.ipRaw = { value: e.value };
                break;
        }
    }
    return out;
}


/// Rebuild the non-inbound half of the `request` surface from the tapes
/// (`docs/architecture/replay-and-sim.md` §3). Mirrors the native
/// transcoder `src/replay/export_fixture.zig` — same channels, same
/// splits — because a browser replay and a `rewind replay` of the same
/// record must reconstruct the same activation.
///
/// Returns `{ ctx, activation, result, bodyBytes }`, all null/undefined
/// when the record is a plain inbound.
// The module paths prod probes for a tenant's middleware, in its own
// order (`.mjs` then `.js` — dispatcher.zig's bytecode lookup), so a
// `.js`-spelled middleware gates offline exactly as it does live.
const MIDDLEWARE_PATHS = ["_middlewares/index.mjs", "_middlewares/index.js"];

// Activation kinds that cross the trust boundary. The worker runs
// `_middlewares` for these only — a continuation resume already ran
// behind the gate, so replaying it must NOT re-run the gate.
const TRUST_BOUNDARY = new Set(["inbound", "inbound_headers", "inbound_chunk", "ws_message"]);

/// The middleware module this activation would have run, or null.
/// Resolvable = present in the bundle's own sources, since a replay can
/// only compile what the capture shipped.
export function resolveMiddleware(moduleSources, activation = "inbound") {
    if (!TRUST_BOUNDARY.has(activation)) return null;
    for (const p of MIDDLEWARE_PATHS) {
        if (moduleSources && moduleSources[p] !== undefined) return p;
    }
    return null;
}

// Activation source → the `kind` string prod puts on the bag. Mirrors the
// switch in `src/js/globals_request.zig` — note `kv_wake` surfaces as
// "kv", not "kv_wake"; the rest are identity.
const ACTIVATION_KIND = { kv_wake: "kv" };

export function deriveActivationSurface({ activation = "inbound", tapes = {}, activationBytes = null } = {}) {
    // Prod installs `request.activation = {kind, ...payload}` on EVERY
    // activation, inbound included (globals_request.zig) — a handler that
    // branches on `request.activation.kind` is doing the documented thing.
    // So the bag always exists; only its extras vary by kind.
    const out = {
        ctx: undefined,
        activation: { kind: ACTIVATION_KIND[activation] ?? activation },
        result: null,
        bodyBytes: null,
    };
    const trigger = (tapes.trigger_payload || []).filter((e) => e.batch_id === 0 && e.inline_bytes?.length);
    const fetches = tapes.fetch_responses || [];

    // The threaded ctx rides a synthesized `{"ctx": …}` envelope.
    let envelope = null;
    if (trigger.length) {
        try { envelope = JSON.parse(_decoder.decode(trigger[0].inline_bytes)); }
        catch (_) { envelope = null; }
    }
    if (envelope && "ctx" in envelope) out.ctx = envelope.ctx;

    // A send_callback's Msg IS that envelope: `{ctx:{result, context}}`
    // for a result delivery. Split it exactly as prod's install hoist
    // does — `result` onto the flattened surface + the activation
    // metadata bag, `context` onto the bare `request.ctx`. A bare-ctx
    // envelope (an internal chained hop) keeps the whole-ctx lift.
    if (activation === "send_callback" && envelope?.ctx && typeof envelope.ctx === "object") {
        const r = envelope.ctx.result;
        if (r && typeof r === "object") {
            out.ctx = envelope.ctx.context;
            out.result = {
                status: r.status ?? null,
                done: r.done ?? null,
                bodyTruncated: r.bodyTruncated ?? r.body_truncated ?? null,
            };
            if (typeof r.body === "string") out.bodyBytes = r.body;
            else if (typeof r.bodyB64 === "string") {
                const bin = atob(r.bodyB64);
                const u = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
                out.bodyBytes = u;
            }
            // Delivery metadata, passed through as recorded — absent
            // fields stay absent (→ undefined on replay), matching the
            // hoist. `ok` is deliberately not surfaced: status is the
            // single success signal (rove#7 / #214).
            for (const k of ["attempts", "error", "id", "headers", "hash"]) {
                if (k in r) out.activation[k] = r[k];
            }
        }
    }

    // A bound fetch's result: the last recorded chunk carries the
    // terminal status; its bytes are the activation's body.
    if (activation === "fetch_chunk" && fetches.length) {
        const last = fetches[fetches.length - 1];
        out.result = {
            status: last.final ? last.terminal_status : null,
            done: last.final,
            fetchId: last.fetch_id || null,
            chunkSeq: last.seq ?? null,
            bodyTruncated: last.body_truncated ?? null,
        };
        if (last.inline_bytes?.length) out.bodyBytes = last.inline_bytes;
    }

    // ws_message: activationBytes = [opcode][data]. A binary frame's
    // data must reach the handler as bytes, a text frame as a string.
    if (activation === "ws_message" && activationBytes?.length) {
        const opcode = activationBytes[0];
        const data = activationBytes.subarray(1);
        out.activation.opcode = opcode;
        out.activation.data = opcode === 2 ? Array.from(data) : _decoder.decode(data);
    }

    // wake_batch: activationBytes = the fired-watch bag, verbatim in the
    // JS-facing encoding (`captureWakeBatchTapes`), always at least `[]`.
    if (activation === "wake_batch" && activationBytes?.length) {
        try {
            const wakes = JSON.parse(_decoder.decode(activationBytes));
            if (Array.isArray(wakes)) out.activation.wakes = wakes;
        } catch (_) { /* unparseable bag → leave undefined */ }
    }

    return out;
}

/// Build the epilogue source.
///
///   record       — the LogRecord fields ({method, path, host}); the
///                  query string is derived by splitting `path` on `?`.
///   requestReads — parsed `request_reads` entries (rtap.mjs shape),
///                  or null/[] for records captured with no reads.
///   bodyBytes    — Uint8Array | null: the bundle's request_body
///                  bytes. Only consulted when the tape says the
///                  handler read the body. ≤16 KB read bodies ride
///                  inline in the record; larger ones live behind the
///                  trigger_payload BodyRef and are NOT fetched here
///                  yet (the epilogue returns "" for them — same
///                  pre-existing bundle limitation as before).
///   exportName   — the export the activation invokes ("default",
///                  "onChunk", "onHeaders", ...). Defaults "default".
///   binaryBody   — true for chunk activations (`inbound_chunk` /
///                  `fetch_chunk`): live `request.body` is a
///                  Uint8Array of arbitrary bytes (the chunk IS the
///                  Msg, always recorded — never read-elided), so the
///                  replay body must be byte-exact binary too.
export function buildRequestEpilogue({ record = {}, requestReads = null, bodyBytes = null, exportName = "default", binaryBody = false, activation = "inbound", ctx = undefined, activationBag = undefined, result = null, middlewarePath = null, tenant = null, correlationId = null } = {}) {
    const reads = foldRequestReads(requestReads);

    const rawPath = record.path || "/";
    const q = rawPath.indexOf("?");
    const data = {
        method: record.method || "GET",
        path: q >= 0 ? rawPath.slice(0, q) : rawPath,
        query: q >= 0 ? rawPath.slice(q + 1) : null,
        host: record.host || "",
        names: reads.names,
        values: reads.values,
        // Captured body bytes imply readability: capture elides the
        // body of any record whose handler never read it, so present
        // bytes mean "was read" even when the marker entry is absent
        // (chunk activations record the payload structurally, not
        // via the getter).
        bodyRead: reads.bodyRead || bodyBytes != null,
        body: binaryBody || bodyBytes == null
            ? null
            : (typeof bodyBytes === "string" ? bodyBytes : _decoder.decode(bodyBytes)),
        bodyB64: binaryBody && bodyBytes != null ? _toBase64(bodyBytes) : null,
        ipMasked: reads.ipMasked,
        ipRaw: reads.ipRaw,
        fn: exportName,
        kind: activation,
        // The non-inbound surface (replay-and-sim.md §3). `hasCtx`
        // distinguishes a recorded `undefined` ctx from an absent one —
        // JSON cannot carry undefined, and the first activation of a
        // chain legitimately has none.
        hasCtx: ctx !== undefined,
        ctx: ctx === undefined ? null : ctx,
        activationBag: activationBag ?? null,
        result: result ?? null,
        // Identity prod pins on EVERY activation (replay-and-sim.md §3),
        // carried per record by the log API (`tenant_id`,
        // `correlation_id`) — the bundle just has to forward it.
        tenant: tenant ?? null,
        correlationId: correlationId ?? null,
    };

    // JSON is JS-literal-safe except the two line separators.
    const json = JSON.stringify(data)
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");

    return (
        // The real middleware, imported as a namespace. STATIC and hoisted,
        // so it loads before the entry module body — the order production
        // loaded it in, and therefore the order the module tape recorded.
        // Skipping it does not merely lose the gate's effect: the replay's
        // first import lands on the middleware's tape entry and the run
        // dies with "module tape diverged".
        (middlewarePath ? "import * as __rove_mw from " + JSON.stringify(middlewarePath) + ";\n" : "") +
        "\n;(() => {\n" +
        "  const D = " + json + ";\n" +
        // Per-run state the base prelude's `_system.*` recorders read
        // (src/replay/js/system_recorders.js). The arena wipes
        // request-arena globals between runs, but seed them explicitly so
        // the recorders never depend on that: `activationKind` gates
        // blob.receive to onHeaders, and `captured` stands down the
        // checks that need harness-seeded state a real capture never has
        // (platform.scope's instance-exists marker — the tape already
        // proves the instance resolved live).
        "  globalThis.__rove_effects = [];\n" +
        "  globalThis.__rove_fetch_seq = 0;\n" +
        "  globalThis.__rove_stream_bytes = 0;\n" +
        "  globalThis.__rove_blob_receive_used = false;\n" +
        "  globalThis.__rove_email_sends = 0;\n" +
        "  globalThis.__rove_activation_kind = D.kind;\n" +
        "  globalThis.__rove_captured = true;\n" +
        // The recorders make private bookkeeping reads under
        // `__rove_store/` — an outbound-budget marker, the admin gate, the
        // operator root token. No capture contains them (production has no
        // such keys), and replay's kv is a STRICT ordered tape, so an
        // unseeded read presents as a tape divergence and kills the run.
        // Seed them through kv, which writes the host's overlay — and the
        // overlay is consulted BEFORE the tape, so these never reach it.
        // Absent (delete) reproduces the sim's defaults: unmetered
        // outbound, no root token. `admin` is granted because the capture
        // itself proves the live call was permitted — the same reasoning
        // that lets `__rove_captured` stand down platform.scope's
        // instance-exists check.
        "  kv.delete(\"__rove_store/email_budget\");\n" +
        "  kv.delete(\"__rove_store/auth/token\");\n" +
        "  kv.set(\"__rove_store/admin\", \"1\");\n" +
        "  const miss = (what) => { throw new Error(\"REPLAY DIVERGENCE: \" + what + \" was read by the handler but is not on the capture tape — the handler observed an input the original run never read\"); };\n" +
        // The bare arena has no console; handlers that log would
        // ReferenceError. Live console output is already on the
        // LogRecord, so replay's console is a no-op sink.
        "  if (typeof console === \"undefined\") globalThis.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };\n" +
        "  const headers = {};\n" +
        "  for (const n of D.names) Object.defineProperty(headers, n, {\n" +
        "    enumerable: true, configurable: true,\n" +
        "    get() { if (!(n in D.values)) miss(\"header '\" + n + \"'\"); return D.values[n]; },\n" +
        "  });\n" +
        "  const request = { method: D.method, path: D.path, host: D.host, query: D.query, headers };\n" +
        // The uniform payload surface (handler-shape §7): bytes/text/json
        // derive from the ONE recorded payload. `request.body` stays on
        // the DRIVER (only) so records from pre-retirement deployments
        // still replay their pinned code.
        "  const __b2s = (c) => { if (typeof c === \"string\") return c; let s = \"\"; for (let i = 0; i < c.length; i++) s += String.fromCharCode(c[i]); return s; };\n" +
        "  const __rawPayload = () => {\n" +
        "    if (!D.bodyRead) miss(\"request payload (bytes/text/json/body)\");\n" +
        "    if (D.bodyB64 != null) {\n" +
        "      const bin = atob(D.bodyB64);\n" +
        "      const u = new Uint8Array(bin.length);\n" +
        "      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);\n" +
        "      return u;\n" +
        "    }\n" +
        "    const st = D.body ?? \"\";\n" +
        "    const u = new Uint8Array(st.length);\n" +
        "    for (let i = 0; i < st.length; i++) u[i] = st.charCodeAt(i) & 0xff;\n" +
        "    return u;\n" +
        "  };\n" +
        "  const __defPayload = (name, compute) => Object.defineProperty(request, name, {\n" +
        "    enumerable: true, configurable: true,\n" +
        "    get() {\n" +
        "      const v = compute();\n" +
        "      Object.defineProperty(request, name, { enumerable: true, configurable: true, writable: true, value: v });\n" +
        "      return v;\n" +
        "    } });\n" +
        "  __defPayload(\"bytes\", () => __rawPayload());\n" +
        "  __defPayload(\"text\", () => { const u = __rawPayload(); try { return decodeURIComponent(escape(__b2s(u))); } catch (_) { return __b2s(u); } });\n" +
        "  __defPayload(\"json\", () => JSON.parse(request.text));\n" +
        "  __defPayload(\"body\", () => (D.bodyB64 != null) ? __rawPayload() : (D.body ?? \"\"));\n" +
        "  Object.defineProperty(request, \"cookies\", { enumerable: true, configurable: true,\n" +
        "    get() {\n" +
        "      const out = {};\n" +
        "      if (D.names.includes(\"cookie\")) {\n" +
        "        const cv = headers.cookie;\n" +  // recorded-read check rides the header getter
        "        for (const part of cv.split(\";\")) {\n" +
        "          const eq = part.indexOf(\"=\");\n" +
        "          if (eq < 0) continue;\n" +
        "          const name = part.slice(0, eq).trim();\n" +
        "          if (name) out[name] = part.slice(eq + 1).trim();\n" +
        "        }\n" +
        "      }\n" +
        "      Object.defineProperty(request, \"cookies\", { enumerable: true, configurable: true, writable: true, value: out });\n" +
        "      return out;\n" +
        "    } });\n" +
        "  Object.defineProperty(request, \"ip\", { enumerable: true, configurable: true,\n" +
        "    get() { if (!D.ipMasked) miss(\"request.ip\"); return D.ipMasked.value || null; } });\n" +
        "  request.unmaskedIp = function () { if (!D.ipRaw) miss(\"request.unmaskedIp()\"); return D.ipRaw.value || null; };\n" +
        // The non-inbound surface: threaded ctx, the activation metadata
        // bag, and the flattened callback/fetch result. Defined only when
        // recorded, so a payload-less kind reads `undefined` exactly as it
        // does live rather than a fabricated null.
        "  if (D.hasCtx) request.ctx = D.ctx;\n" +
        "  request.activation = D.activationBag;\n" +
        "  if (D.tenant !== null) request.tenant = D.tenant;\n" +
        "  if (D.correlationId !== null) request.correlation_id = D.correlationId;\n" +
        // request.tag(key, value) — prod's validation verbatim
        // (globals.zig jsRequestTag), mirrored from the native epilogue:
        // two strings; key 1..32 BYTES of [a-z0-9_] with no leading '_';
        // value 1..64 BYTES, no control characters; at most 4 distinct
        // keys per activation, re-tagging updates in place. It is a
        // FUNCTION, so its absence is not a missing value — a handler
        // that tags its request dies on the call.
        "  const __tags = [];\n" +
        "  request.tag = function (k, v) {\n" +
        "    if (arguments.length < 2 || typeof k !== \"string\" || typeof v !== \"string\") throw new TypeError(\"request.tag(key, value) requires two string arguments\");\n" +
        "    const __enc = new TextEncoder();\n" +
        "    const kb = __enc.encode(k).length, vb = __enc.encode(v).length;\n" +
        "    if (kb < 1 || kb > 32) throw new TypeError(\"request.tag: key length must be 1..32 bytes\");\n" +
        "    if (k[0] === \"_\") throw new TypeError(\"request.tag: keys starting with '_' are reserved\");\n" +
        "    if (!/^[a-z0-9_]+$/.test(k)) throw new TypeError(\"request.tag: key must match [a-z0-9_]\");\n" +
        "    if (vb < 1 || vb > 64) throw new TypeError(\"request.tag: value length must be 1..64 bytes\");\n" +
        "    for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) < 0x20) throw new TypeError(\"request.tag: value must not contain control characters\");\n" +
        "    const hit = __tags.find((t) => t.key === k);\n" +
        "    if (hit) { hit.value = v; return undefined; }\n" +
        "    if (__tags.length >= 4) throw new TypeError(\"request.tag: at most 4 tags per activation\");\n" +
        "    __tags.push({ key: k, value: v });\n" +
        "    return undefined;\n" +
        "  };\n" +
        "  if (D.result) {\n" +
        "    for (const k of [\"status\", \"done\", \"fetchId\", \"chunkSeq\", \"bodyTruncated\"]) {\n" +
        "      if (D.result[k] !== null && D.result[k] !== undefined) request[k] = D.result[k];\n" +
        "    }\n" +
        "  }\n" +
        "  globalThis.request = request;\n" +
        "  globalThis.response = { status: 200, headers: {}, cookies: [] };\n" +
        "  const ns = __arena_entry_ns();\n" +
        // `_middlewares`' `before` runs FIRST at the trust boundary: it sees
        // globalThis.request/response, may MUTATE the request (request.auth
        // = {…}) and may SHORT-CIRCUIT by returning a response, in which
        // case the handler never runs. `typeof` guards the undeclared case.
        // Mirrors src/replay/epilogue.zig, which mirrors
        // module_execution.runMiddleware — a malformed middleware is a loud
        // 500, not a skipped gate.
        "  let __short = false;\n" +
        "  if (typeof __rove_mw !== \"undefined\" && __rove_mw) {\n" +
        "    if (typeof __rove_mw.before !== \"function\") {\n" +
        "      globalThis.response = { status: 500, headers: {}, cookies: [] };\n" +
        "      globalThis.__replay_result = \"_middlewares/index.mjs must export a `before` function\\n\";\n" +
        "      __short = true;\n" +
        "    } else {\n" +
        "      const __mwr = __rove_mw.before();\n" +
        "      if (__mwr !== undefined && __mwr !== null) { globalThis.__replay_result = __mwr; __short = true; }\n" +
        "    }\n" +
        "  }\n" +
        "  if (!__short) {\n" +
        "    if (typeof ns[D.fn] !== \"function\") throw new Error(\"replay: entry module has no '\" + D.fn + \"' export\");\n" +
        "    globalThis.__replay_result = ns[D.fn]();\n" +
        "  }\n" +
        // Park the RE-EXECUTED outcome on the host's kv side channel: kv.set
        // writes into the shell's overlay, never the tape, so the host can
        // read back what THIS run produced and compare it against what the
        // capture recorded. Written only on the success path — a handler
        // that throws leaves the key absent, which the shell reports as
        // "did not complete" rather than as a bogus match.
        "  const __res = globalThis.response || {};\n" +
        "  const __ser = (v) => { if (v === undefined || v === null) return null; if (typeof v === \"string\") return v; try { return JSON.stringify(v); } catch (_) { return String(v); } };\n" +
        "  kv.set(" + JSON.stringify(REPLAY_OUTPUT_KEY) + ", JSON.stringify({ status: __res.status === undefined ? null : __res.status, result: __ser(globalThis.__replay_result), effects: (globalThis.__rove_effects || []) }));\n" +
        "})();\n"
    );
}
