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
        // `fetch_chunk` deliberately falls to `default`, matching prod's
        // defaultExportForKind. The native driver maps it to
        // `onFetchResult` instead, which is right for an AUTHORED world
        // (the author named no export) and WRONG for a captured one: the
        // engine's baked callbacks — `__system/webhook_onresult` and
        // friends — are dispatched at their default export, so preferring
        // onFetchResult 404s them. A named `{on}` rides the record's
        // recorded export and never reaches this fallback.
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
// `.mjs` ONLY. A `.js` is not a deployable handler source anywhere in the
// pipeline — the CLI ships only `.mjs` and the compiler builds a `.js` as a
// classic script — so honouring the spelling here ran a gate offline that
// production does not have (rove#461). The worker and the offline sim both
// dropped their `.js` fallback; this is the third engine.
export const MIDDLEWARE_PATHS = ["_middlewares/index.mjs"];

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
const KV_OUTCOME_REFUSED = 3; // rtap.mjs kv entry outcome byte (v7)

function foldKvRefusals(entries) {
    const out = {};
    if (!entries) return out;
    const dec = new TextDecoder();
    for (const e of entries) {
        if (typeof e.code === "string") {
            // Pre-shaped {op, key, code}.
            out[(e.op === "delete" ? "d" : "s") + e.key] = e.code;
            continue;
        }
        if (e.outcome !== KV_OUTCOME_REFUSED) continue;
        const key = typeof e.key === "string" ? e.key : dec.decode(e.key);
        const code = typeof e.value === "string" ? e.value : dec.decode(e.value);
        // rtap KvOp: get 0, set 1, delete 2.
        out[(e.op === 2 ? "d" : "s") + key] = code;
    }
    return out;
}

export function buildRequestEpilogue({ record = {}, requestReads = null, bodyBytes = null, exportName = "default", binaryBody = false, activation = "inbound", ctx = undefined, activationBag = undefined, result = null, middlewarePath = null, tenant = null, sagaId = null, captured = true, kvRefusals = null } = {}) {
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
        // carried per record by the log API (`tenant_id`, `saga_id`) —
        // the bundle just has to forward it.
        tenant: tenant ?? null,
        sagaId: sagaId ?? null,
        // Was this world CAPTURED from a live run, or AUTHORED?
        //
        // Everything the replay posture assumes rests on the world having
        // happened: a read the tape lacks is a divergence because the original
        // run did not make it; admin is granted because the live call was
        // permitted; the retired `request.body` alias exists because the
        // capture predates its removal. None of those premises hold for a world
        // someone wrote, and applying them anyway made an authored world die on
        // an undeclared read, granted it admin it never asked for, and gave it a
        // surface production does not have (rove#436).
        //
        // Defaults TRUE: the shell only ever replays captures, so this changes
        // nothing there. The conformance suite passes false.
        captured: captured !== false,
        // Outcome-replay (rove#516): guard refusals the capture recorded,
        // keyed "s"/"d" + key → the refusal CODE. On a captured world the
        // kv wrapper throws these verbatim and decides NOTHING itself — a
        // write with no entry succeeded at capture and proceeds unguarded,
        // so rule evolution cannot manufacture a false divergence.
        refusals: foldKvRefusals(kvRefusals),
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
        // One ordered interaction log, folded into the digest AS entries
        // arrive. Order matters and cannot be recovered afterwards, so the
        // push is patched rather than the array walked at the end: the base
        // prelude's `_system.*` recorders push here, and the kv wrapper below
        // pushes reads/writes/deletes into the same list, so the sequence is
        // exactly what the handler did, in order.
        //
        // The digest mirrors the worker's grammar
        // (rove src/tape/interaction_digest.zig). Entry kinds outside that
        // grammar — logs, platform and blob calls — are recorded for the
        // timeline but NOT folded, because the worker does not fold them
        // either and a digest is only useful if both sides hash the same set.
        "  const __DG = globalThis.__interactionDigest;\n" +
        // Canonical 16-hex for a dep_id given as either a hex string or a
        // number — the worker folds the resolved u64's canonical spelling.
        "  const __depHex = (v) => { try { const n = typeof v === \"number\" ? BigInt(Math.trunc(v)) : BigInt(\"0x\" + String(v)); return n.toString(16).padStart(16, \"0\"); } catch (_) { return String(v ?? \"\"); } };\n" +
        "  const __dg = __DG ? new __DG.Digest() : null;\n" +
        "  const __foldEffect = (e) => {\n" +
        "    if (!__dg || !e) return;\n" +
        // A store-tagged entry (`store: \"r\"` / `\"i/{id}\"`) is the ONLY fold
        // point for a cross-store op. The underlying namespaced
        // `kv.get/set/delete` does NOT reach the digest: the wrapper below
        // filters every `__rove_store/…` key out of the effect log via
        // `__harness`. This used to `return` here on the theory that the
        // wrapper had already folded it, which left cross-store ops folded
        // NOWHERE while capture folds each one — rove#487.
        //
        // Fold it under the NAMESPACED key, which is what the worker folds:
        // cross-store ops get no verb of their own, so the store is data in
        // the key (globals_platform.zig namespacedKey). Keying it bare would
        // also erase the store, hashing scope(\"a\").kv.get(k) the same as
        // root.get(k) — a false agreement rather than a mismatch.
        "    const __dgKey = (x) => (x.store === undefined || x.store === null)\n" +
        "      ? x.key : \"__rove_store/\" + x.store + \"/\" + x.key;\n" +
        // The `exists` store is harness bookkeeping, not a handler write. The
        // facade seeds it when `platform.instances.create` runs so a later
        // `scope(name)` resolves; production records instance creation in the
        // ROOT WRITESET (raft) and folds nothing for it. Keyed on the store
        // tag, since the entry carries the bare key.
        "    if (e.store === \"exists\") return;\n" +
        "    if (e.key !== undefined && String(e.key).indexOf(\"__rove_store/exists/\") === 0) return;\n" +
        "    switch (e.kind) {\n" +
        "      case \"read\":\n" +
        "        if (e.op === \"prefix\") __dg.kvPrefix(__dgKey(e), true, e.count ?? 0, BigInt(\"0x\" + (e.rowsFold ?? \"0\")));\n" +
        "        else __dg.kvRead(__dgKey(e), !!e.present, e.value ?? \"\");\n" +
        "        break;\n" +
        "      case \"write\":  __dg.kvWrite(__dgKey(e), e.value ?? \"\"); break;\n" +
        "      case \"delete\": __dg.kvDelete(__dgKey(e)); break;\n" +
        "      case \"fetch\":  __dg.fetch(e.method || \"GET\", e.url || \"\", e.body ?? \"\"); break;\n" +
        "      case \"timer\":  __dg.wakeArm(\"t\", String(e.ms), e.on ?? \"\"); break;\n" +
        "      case \"kv-wake\": __dg.wakeArm(\"k\", e.prefix, e.on ?? \"\"); break;\n" +
        "      case \"stream\": __dg.streamWrite(e.data ?? \"\"); break;\n" +
        // Privileged lifecycle ops. `scope` is deliberately not folded — the id
        // it resolved is already carried by every namespaced read/write the
        // handle performs, so folding the resolve distinguishes nothing the
        // rest of the sequence does not. `releases.publish` normalizes dep_id
        // to canonical 16-hex, matching the worker: the native accepts a hex
        // string or a number for the same deployment.
        "      case \"platform\":\n" +
        "        if (e.op === \"instances.create\" || e.op === \"instances.deployStarter\")\n" +
        "          __dg.platformOp(e.op, String(e.name ?? \"\"), \"\");\n" +
        "        else if (e.op === \"releases.publish\")\n" +
        "          __dg.platformOp(e.op, String(e.tenant ?? \"\"), __depHex(e.depId));\n" +
        "        break;\n" +
        "      default: break;\n" +
        "    }\n" +
        "  };\n" +
        "  const __effectLog = [];\n" +
        "  const __rawPush = __effectLog.push.bind(__effectLog);\n" +
        "  __effectLog.push = (e) => { __foldEffect(e); return __rawPush(e); };\n" +
        "  globalThis.__rove_effects = __effectLog;\n" +
        "  globalThis.__rove_fetch_seq = 0;\n" +
        "  globalThis.__rove_stream_bytes = 0;\n" +
        "  globalThis.__rove_blob_receive_used = false;\n" +
        "  globalThis.__rove_email_sends = 0;\n" +
        "  globalThis.__rove_activation_kind = D.kind;\n" +
        "  globalThis.__rove_captured = D.captured;\n" +
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
        // Admin is granted only for a CAPTURE, where the live call having been
        // permitted is evidence. An authored world is fail-closed like the sim
        // and like production: granting it admin made every fail-closed
        // assertion pass for the wrong reason — `platformadmin` exists to pin
        // exactly that behaviour and could not test it here (rove#436).
        "  if (D.captured) kv.set(\"__rove_store/admin\", \"1\");\n" +
        // Installed AFTER the seeding writes above: those are host bookkeeping
        // the worker never performed, and folding them would put three
        // elements in the replay's digest that the capture's does not have —
        // which is precisely what the cross-engine check caught.
        //
        // Wrap kv so reads and writes land in the SAME ordered log as the
        // effects — the worker folds them into one sequence, so a replay that
        // folded them separately would hash a different order and diverge on
        // every run that interleaves them. The native binding still does the
        // work; this only observes.
        //
        // The output-key write below is issued through the NATIVE binding, not
        // this wrapper: it is the host's side channel, not something the
        // handler did, and folding it would put an element in the replay's
        // digest that the worker never had.
        "  const __kvNative = kv;\n" +
        // `__rove_store/` is a HARNESS namespace: the recorders keep their own
        // bookkeeping there (the outbound budget marker, the admin gate, the
        // root token, instance-exists markers) and it exists nowhere in the
        // worker. Recording those reads puts entries in the effect log that no
        // production run performed — and because the log's push is patched to
        // fold as entries arrive, straight into the interaction digest, where a
        // read spliced mid-sequence shifts every later ordinal. The offline sim
        // has always excluded them; this engine did not (rove#442).
        //
        // The prefix comes from the shared `_system.*` shim (rove's
        // system_recorders.js, embedded in the generated prelude), so both
        // offline engines test the same string.
        "  const __NS = globalThis.__roveStorePrefix || \"__rove_store/\";\n" +
        "  const __harness = (k) => typeof k === \"string\" && k.startsWith(__NS);\n" +
        "  const __refuse = (code, ks) => {\n" +
        "    if (code === \"reserved_key\") throw __kvErr(\"kv: '\" + ks + \"' is in a platform-reserved prefix\", code);\n" +
        "    if (code === \"key_too_large\") throw __kvErr(\"kv: key exceeds the \" + __KV_KEY_MAX + \"-byte limit\", code);\n" +
        "    if (code === \"value_too_large\") throw __kvErr(\"kv: value exceeds the \" + __KV_VAL_MAX + \"-byte limit\", code);\n" +
        "    throw __kvErr(\"kv: '\" + ks + \"' was refused at capture\", code);\n" +
        "  };\n" +
        "  globalThis.kv = {\n" +
        // A CAPTURED world is a strict read-your-tape world: a key in neither
        // the overlay nor the tape means the original run never read it, and
        // inventing a value would be replaying a different request. An AUTHORED
        // world is a CLOSED world instead — `world.zig` defines a key not in
        // the map as `not_found`, never a divergence, and the sim implements
        // that. Applying the captured posture to an authored world killed the
        // run on the ordinary shape of testing a not-found branch (rove#436).
        "    get(k) {\n" +
        "      let v;\n" +
        "      try { v = __kvNative.get(k); }\n" +
        "      catch (e) { if (String(e && e.message).includes(\"recording has no entry\")) { if (D.captured) miss(\"kv '\" + k + \"'\"); v = null; } else { throw e; } }\n" +
        "      const present = v !== undefined && v !== null;\n" +
        // A not-found read carries no value — the sim omits the field rather
        // than spelling it `""`, and an entry that differs only in how it
        // spells absence reads as a divergence while the digest (which folds
        // `value ?? ""`) says the two runs did the same thing.
        "      if (!__harness(k)) globalThis.__rove_effects.push(present\n" +
        "        ? { kind: \"read\", key: k, present: true, value: v }\n" +
        "        : { kind: \"read\", key: k, present: false });\n" +
        "      return v;\n" +
        "    },\n" +
        // The kv write guardrails. The RULES are the engine's own, shared
        // verbatim: `__kvGuardWrite` comes from the generated arena prelude,
        // which splices rove's `src/replay/js/kv_guards.js` and the data it
        // needs (rove#502). This arena had none of them, so a handler writing
        // a platform-reserved key threw in prod and in the sim and succeeded
        // here — replay more permissive than prod, which makes a run look
        // successful where the real one refused.
        //
        // The guard runs BEFORE the effect is recorded: a refused write never
        // happened, so it must not appear in the log the digest folds.
        // `__harness` keys are the shell's own bookkeeping and skip it, which
        // is the same carve-out the sim makes for its store namespace.
        // Outcome-replay on a captured world: coercion still decides (it is
        // value-shape, reproduced by re-execution) but the RULES never run —
        // a taped refusal throws the recorded code verbatim, and a write
        // with no entry succeeded at capture and proceeds unguarded, so rule
        // evolution cannot manufacture a false divergence (rove#516). An
        // authored world decides live via the shared rules, exactly the
        // native engines' decides() split.
        "    set(k, v) { if (__harness(k)) return __kvNative.set(k, v); let ks; if (D.captured) { ks = __kvCoerce(k, \"key\"); __kvCoerce(v, \"value\"); const r = D.refusals[\"s\" + ks]; if (r !== undefined) __refuse(r, ks); } else { ks = __kvGuardWrite(k, true, v); } globalThis.__rove_effects.push({ kind: \"write\", key: ks, value: v }); return __kvNative.set(ks, v); },\n" +
        "    delete(k) { if (__harness(k)) return __kvNative.delete(k); let ks; if (D.captured) { ks = __kvCoerce(k, \"key\"); const r = D.refusals[\"d\" + ks]; if (r !== undefined) __refuse(r, ks); } else { ks = __kvGuardWrite(k, false); } globalThis.__rove_effects.push({ kind: \"delete\", key: ks }); return __kvNative.delete(ks); },\n" +
        "    prefix(p, cursor, limit) {\n" +
        "      let raw;\n" +
        "      try { raw = __kvNative.prefix(p, cursor, limit) || []; }\n" +
        "      catch (e) { if (String(e && e.message).includes(\"recording has no entry\")) { if (D.captured) miss(\"kv.prefix '\" + p + \"'\"); raw = []; } else { throw e; } }\n" +
        // A harness-namespace scan is the recorders' own, and is neither
        // recorded nor filtered. A TENANT scan must not see another store's
        // keys — prod has none to see — so they are stripped from the rows
        // before the handler or the digest observes them.
        "      if (__harness(p)) return raw;\n" +
        "      const rows = raw.filter((r) => !__harness(r.key));\n" +
        "      const enc = globalThis.__interactionDigest;\n" +
        "      let fold = \"0\";\n" +
        "      if (enc) { let acc = \"\"; for (const r of rows) acc += r.key + \"=\" + enc.foldValue(r.value) + \";\"; fold = enc.foldValue(acc); }\n" +
        "      globalThis.__rove_effects.push({ kind: \"read\", op: \"prefix\", key: p, count: rows.length, rowsFold: fold });\n" +
        "      return rows;\n" +
        "    },\n" +
        "  };\n" +

        // An off-tape read POISONS the run and returns absent — nothing is
        // thrown, so nothing a handler can catch to keep running on fiction
        // invisibly (rove#510). The verdict rides the parked output
        // (post-run); the first divergence wins, like the native host's.
        // Until the in-tree wasm the flag lives in VM JS — a handler could
        // clear it, which only deceives its own debugging tool.
        "  const miss = (what) => { if (!globalThis.__rove_diverged) globalThis.__rove_diverged = \"REPLAY DIVERGENCE: \" + what + \" was read by the handler but is not on the capture tape — the handler observed an input the original run never read\"; return undefined; };\n" +
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
        // `request.body` is a RETIRED surface kept for captured worlds, whose
        // handlers predate its removal. An authored world mirrors the live
        // surface, where the property does not exist — so `"body" in request`
        // answers the same offline as in production.
        "  if (D.captured) __defPayload(\"body\", () => (D.bodyB64 != null) ? __rawPayload() : (D.body ?? \"\"));\n" +
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
        "    get() { if (!D.ipMasked) { miss(\"request.ip\"); return null; } return D.ipMasked.value || null; } });\n" +
        "  request.unmaskedIp = function () { if (!D.ipRaw) { miss(\"request.unmaskedIp()\"); return null; } return D.ipRaw.value || null; };\n" +
        // The non-inbound surface: threaded ctx, the activation metadata
        // bag, and the flattened callback/fetch result. Defined only when
        // recorded, so a payload-less kind reads `undefined` exactly as it
        // does live rather than a fabricated null.
        "  if (D.hasCtx) request.ctx = D.ctx;\n" +
        "  request.activation = D.activationBag;\n" +
        "  if (D.tenant !== null) request.tenant = D.tenant;\n" +
        "  if (D.sagaId !== null) request.sagaId = D.sagaId;\n" +
        // request.tag(key, value) — prod's validation verbatim
        // (globals.zig jsRequestTag), mirrored from the native epilogue:
        // two strings; key 1..32 BYTES of [a-z0-9_] with no leading '_';
        // value 1..64 BYTES, no control characters; at most 4 distinct
        // keys per activation, re-tagging updates in place. It is a
        // FUNCTION, so its absence is not a missing value — a handler
        // that tags its request dies on the call.
        "  const __tags = [];\n" +
        "  request.tag = function (k, v) {\n" +
        // The RULES come from the generated arena prelude, which splices
        // rove's `src/replay/js/tag_guards.js` and the limits generated from
        // the Zig (rove#505). They used to be hand-copied here, and had
        // already drifted: this file said "at most 4 tags per activation"
        // where prod and the sim say "too many tags (max 4 per request)", so
        // a handler catching the error read different text depending on which
        // engine ran it.
        "    __tagGuardPair(k, v, arguments.length);\n" +
        "    const hit = __tags.find((t) => t.key === k);\n" +
        "    if (hit) { hit.value = v; globalThis.__rove_effects.push({ kind: \"tag\", key: k, value: v }); return undefined; }\n" +
        "    __tagGuardCapacity(__tags.length);\n" +
        "    __tags.push({ key: k, value: v });\n" +
        // The sim records an accepted tag as an effect and this engine did
        // not, so any world that tagged diverged on `effects` before the
        // comparison ever reached a message.
        "    globalThis.__rove_effects.push({ kind: \"tag\", key: k, value: v });\n" +
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
        // A missing export has THREE dispositions in prod
        // (module_execution.zig), none of them a throw: disconnect is a
        // no-op because cleanup is optional; the inbound_headers /
        // inbound_chunk probes fall back to the buffered default
        // dispatch; anything else is a 404. Throwing instead stops the
        // timeline where production carried on.
        "  if (!__short) {\n" +
        "    const __fn = ns[D.fn];\n" +
        "    if (typeof __fn === \"function\") {\n" +
        "      globalThis.__replay_result = __fn();\n" +
        "    } else if (D.kind === \"disconnect\") {\n" +
        "      /* prod: optional cleanup, no response */\n" +
        "    } else if ((D.kind === \"inbound_headers\" || D.kind === \"inbound_chunk\") && typeof ns[\"default\"] === \"function\") {\n" +
        "      globalThis.__replay_result = ns[\"default\"]();\n" +
        "    } else {\n" +
        "      globalThis.response = { status: 404, headers: {}, cookies: [] };\n" +
        "      globalThis.__replay_result = 'module export \"' + D.fn + '\" not found or not a function\\n';\n" +
        "    }\n" +
        "  }\n" +
        // Park the RE-EXECUTED outcome on the host's kv side channel: kv.set
        // writes into the shell's overlay, never the tape, so the host can
        // read back what THIS run produced and compare it against what the
        // capture recorded. Written only on the success path — a handler
        // that throws leaves the key absent, which the shell reports as
        // "did not complete" rather than as a bogus match.
        "  const __res = globalThis.response || {};\n" +
        "  const __ser = (v) => { if (v === undefined || v === null) return null; if (typeof v === \"string\") return v; try { return JSON.stringify(v); } catch (_) { return String(v); } };\n" +
        // Close the digest with the run's own result — the last element.
        //
        // NOT for a PARK. `next(...)` holds the connection and has no response
        // yet, and the worker reflects that by returning `.continuation` /
        // `.stream` from finishResponse BEFORE it folds anything; the offline
        // sim skips it for the same reason. Folding one here closed every held
        // activation with an element the other two engines do not have, so
        // their digests disagreed on every parked hop even when the interaction
        // logs were identical (rove#442).
        //
        // A held chain still gets a digest per activation — it just ends at the
        // last interaction rather than at a response that has not happened.
        "  const __parked = globalThis.__replay_result && typeof globalThis.__replay_result === \"object\" &&\n" +
        "    globalThis.__replay_result.__rove_disposition === \"next\";\n" +
        "  if (__dg && !__parked) __dg.response(__res.status === undefined ? 200 : __res.status, __ser(globalThis.__replay_result) ?? \"\");\n" +
        "  __kvNative.set(" + JSON.stringify(REPLAY_OUTPUT_KEY) + ", JSON.stringify({ status: __res.status === undefined ? null : __res.status, result: __ser(globalThis.__replay_result), effects: __effectLog, digest: __dg ? __dg.hex() : null, divergence: globalThis.__rove_diverged || null }));\n" +
        "})();\n"
    );
}
