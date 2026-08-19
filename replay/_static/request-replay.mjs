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

import { READ_KIND_HEADER_NAMES, READ_KIND_HEADER_VALUE, READ_KIND_BODY_READ, READ_KIND_IP_MASKED, READ_KIND_IP_RAW, poolRefIsNone } from "./rtap.mjs";

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

// The activation kinds whose Msg IS the inbound request body. Every other
// kind takes its payload from somewhere else (a callback envelope, a fetch
// chunk, a WS frame), so the trigger channel is not its body.
const INBOUND_KINDS = new Set(["inbound", "inbound_headers", "inbound_chunk"]);

/// What the body door's verdict MEANS, in one sentence a reader can act on.
/// The status is the verdict — a resolution never comes back as an empty
/// 200 — so each one gets its own sentence rather than a generic failure.
function doorReason(r) {
    const why = {
        0: "the resolution request never reached the dashboard",
        400: "the payload address was malformed",
        403: "this session may not read that tenant's payloads",
        404: "the record, or that entry of its tape, is not in the log",
        409: "the payload was recorded as nothing — the capture kept no bytes",
        410: "the referenced bytes are no longer in storage",
        413: "the payload is larger than the resolution ceiling",
        422: "the recorded reference is malformed",
        503: "no content store is configured, so the reference is unreachable",
    }[r.status];
    const detail = String(r.error || "").split("\n")[0].trim();
    return (why || `the body door answered ${r.status}`) + (detail ? ` (${detail})` : "");
}

/// Where ONE tape entry's payload actually is. Mirrors rove's
/// `body_ref.locate` (src/log_server/body_ref.zig) — the same four answers
/// off the same fields, because the browser and the door must agree on
/// what a given entry claims before they can agree on what it holds.
///
/// `resolvedBodies` is the bundle's `{channel}/{index}` → door verdict map,
/// addressed by RAW tape ordinal: the door resolves by ordinal, so an index
/// taken from a filtered list names a different entry than the one asked
/// about.
///
/// Returns `{bytes, source}` where source is `carried` (the bytes rode the
/// tape), the door's own source (`pool` / `content`), `empty` (the entry
/// genuinely had no payload), or `unresolved` — which carries a `reason`
/// and is the one answer a caller must never turn into an empty body.
export function locatePayload(entry, index, channel, resolvedBodies) {
    if (entry?.inline_bytes?.length) return { bytes: entry.inline_bytes, source: "carried" };
    const r = resolvedBodies ? resolvedBodies[channel + "/" + index] : undefined;
    if (r && r.status === 200 && r.bytes?.length) {
        return { bytes: r.bytes, source: r.source || "resolved" };
    }
    // No bytes here and none resolved. Did the entry CLAIM a payload? A
    // pool object, a content hash, or a non-zero reference length each
    // say bytes existed; all three absent is a genuinely empty event (a
    // terminal-only fetch chunk), which is not a failure to report.
    const claimed = !!entry && (
        !poolRefIsNone(entry.pool_ref) ||
        String(entry.content_hash || "").length > 0 ||
        (entry.ref_len ?? 0) > 0);
    if (!claimed) return { bytes: null, source: "empty" };
    return {
        bytes: null,
        source: "unresolved",
        status: r ? r.status : null,
        reason: r ? doorReason(r)
            : "the bundle carries no resolution for this payload — reopen the record from the dashboard",
    };
}

export function deriveActivationSurface({ activation = "inbound", tapes = {}, activationBytes = null, resolvedBodies = null } = {}) {
    // Prod installs `request.activation = {kind, ...payload}` on EVERY
    // activation, inbound included (globals_request.zig) — a handler that
    // branches on `request.activation.kind` is doing the documented thing.
    // So the bag always exists; only its extras vary by kind.
    const out = {
        ctx: undefined,
        activation: { kind: ACTIVATION_KIND[activation] ?? activation },
        result: null,
        bodyBytes: null,
        // Set when this activation's Msg was recorded by reference and
        // nothing could turn that reference back into bytes. It is the
        // whole point of the field that it is NOT a null body: a missing
        // input must reach the run as a refusal, never as a plausible
        // empty value.
        payloadUnresolved: null,
    };
    const triggerEntries = tapes.trigger_payload || [];
    const fetches = tapes.fetch_responses || [];

    // The activation's Msg is the first trigger entry that has, or claims,
    // a payload — walked by RAW ORDINAL. A pre-filtered list renumbers the
    // entries, and the body door addresses by ordinal, so a filtered index
    // asks about a different entry than the one being replayed.
    let trigger = null;
    for (let i = 0; i < triggerEntries.length; i++) {
        const p = locatePayload(triggerEntries[i], i, "trigger_payload", resolvedBodies);
        if (p.source === "empty") continue;
        trigger = { index: i, ...p };
        break;
    }
    if (trigger && !trigger.bytes) {
        out.payloadUnresolved = {
            channel: "trigger_payload", index: trigger.index,
            status: trigger.status ?? null, reason: trigger.reason,
        };
    }

    // The threaded ctx rides a synthesized `{"ctx": …}` envelope.
    let envelope = null;
    if (trigger?.bytes) {
        try { envelope = JSON.parse(_decoder.decode(trigger.bytes)); }
        catch (_) { envelope = null; }
    }
    if (envelope && "ctx" in envelope) out.ctx = envelope.ctx;

    // An inbound activation's Msg IS the request body. Only a payload the
    // RECORD did not carry inline is taken from here: a body under the
    // inline cap already rides `request_body_b64`, which the shell hands
    // to the epilogue directly, and re-deriving it would be one more way
    // for the two to disagree.
    if (INBOUND_KINDS.has(activation) && trigger?.bytes && trigger.source !== "carried") {
        out.bodyBytes = trigger.bytes;
    }

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
    // terminal status; its bytes are the activation's body. A chunk over
    // the inline cap left its bytes in content-addressed storage and the
    // entry holds only the reference — resolve it by the chunk's own
    // ordinal, and refuse rather than serve an empty chunk when it cannot
    // be resolved.
    if (activation === "fetch_chunk" && fetches.length) {
        const lastIdx = fetches.length - 1;
        const last = fetches[lastIdx];
        out.result = {
            status: last.final ? last.terminal_status : null,
            done: last.final,
            fetchId: last.fetch_id || null,
            chunkSeq: last.seq ?? null,
            bodyTruncated: last.body_truncated ?? null,
        };
        const p = locatePayload(last, lastIdx, "fetch_responses", resolvedBodies);
        if (p.bytes) out.bodyBytes = p.bytes;
        else if (p.source === "unresolved") {
            out.payloadUnresolved = {
                channel: "fetch_responses", index: lastIdx,
                status: p.status ?? null, reason: p.reason,
            };
        }
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
///   bodyBytes    — Uint8Array | null: the activation's payload bytes.
///                  Only consulted when the tape says the handler read
///                  the body. ≤16 KB read bodies ride inline in the
///                  record; larger ones live behind the trigger_payload
///                  BodyRef and are resolved into the bundle through the
///                  body door before this is built.
///   payloadUnresolved — the `deriveActivationSurface` marker for a
///                  payload recorded BY REFERENCE that nothing could
///                  resolve. Present ⇒ the epilogue refuses the payload
///                  instead of serving "": a handler reading a body the
///                  replay does not have is reading fiction, and an empty
///                  string is the most convincing fiction there is.
///   exportName   — the export the activation invokes ("default",
///                  "onChunk", "onHeaders", ...). Defaults "default".
///   binaryBody   — true for chunk activations (`inbound_chunk` /
///                  `fetch_chunk`): live `request.body` is a
///                  Uint8Array of arbitrary bytes (the chunk IS the
///                  Msg, always recorded — never read-elided), so the
///                  replay body must be byte-exact binary too.
const KV_OUTCOME_REFUSED = 3; // rtap.mjs kv entry outcome byte

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

/// Derive the response production would have put ON THE WIRE from what the
/// re-executed handler produced. The replay's `globalThis.response` and its
/// return value are the handler's RAW intent; the worker applies emit-side
/// rules to both before anything reaches a socket, so the raw pair is not the
/// response and must never be shown or digested as one.
///
/// The rules mirrored here, all from the serving path:
///
///   - status coercion + 100..599 clamp (`worker_dispatch`);
///   - header vetting — pseudo-names, token-invalid names, hop-by-hop and
///     platform-managed names, `x-rewind-*` / `x-rove-internal-*`, non-string
///     or CR/LF/NUL values are dropped; survivors lowercase, first 32 only
///     (`response_building.isEmittableHeaderName` / `isCleanHeaderValue`);
///   - cookie sanitization — strings only, first 32, `Domain=` stripped so a
///     handler cannot push a cookie onto the parent domain
///     (`response_building.sanitizeSetCookie`);
///   - body derivation — a string is raw, a `Uint8Array` is RAW BYTES, an
///     undefined/null return is empty, anything else is `JSON.stringify` and
///     auto-stamps `content-type: application/json` unless the handler set its
///     own (`response_building.bodyFromReturn` + `dispatcher`);
///   - buffered `stream.write` chunks ship AHEAD of the body on a first-hop
///     HTTP terminal (`dispatcher.prependStreamChunks`).
///
/// `thrown` is the exception's ToString when the handler (or its middleware)
/// threw. Prod's throw path does not go through any of the rules above: the
/// worker discards the handler-set head entirely and serves 500 with
/// `handler threw: {ToString}\n` and NO headers at all
/// (`worker_dispatch` → `response_builder.setSimpleResponse`, whose body comes
/// from the same `response_building.thrownBody` the digest folds). Buffered
/// stream chunks do not prepend either — that only happens on the success
/// path. Deriving a thrown response through the ordinary rules would invent a
/// status, headers and a body prod never sent.
///
/// `held` is `next(...)`: the connection stays open and prod ships nothing
/// yet, so there is no wire response for this hop — the vetted status and
/// headers are returned anyway because they are what the handler set and
/// prod discarded, which is worth seeing.
///
/// `body` is the live value (string or `Uint8Array`) — the digest folds it
/// directly, exactly as the worker folds `pending.body`. `bodyB64` carries the
/// same bytes through JSON for a binary body.
///
/// Self-contained by construction: the epilogue embeds this function's own
/// source into the arena run (`deriveWireResponse.toString()`), so it may not
/// close over anything in this module. That is also what makes it directly
/// unit-testable from node (`e2e/replay-response-check.mjs`).
export function deriveWireResponse(result, responseGlobal, effects, activationKind, thrown) {
    if (thrown !== undefined && thrown !== null) {
        // `thrownBody`'s empty-exception fallback, verbatim: a failed format
        // must still produce a stable, non-empty body rather than a silent
        // 500 with nothing in it.
        const msg = String(thrown);
        return {
            held: false, threw: true, status: 500, headers: {}, cookies: [],
            body: msg.length ? "handler threw: " + msg + "\n" : "handler threw\n",
            bodyB64: null, binary: false, isJson: false,
        };
    }

    const raw = responseGlobal || {};

    let status = raw.status;
    status = (status === undefined || status === null) ? 200 : (status | 0);
    if (status < 100) status = 100;
    else if (status > 599) status = 599;

    const RESERVED = ["connection", "transfer-encoding", "upgrade", "keep-alive", "te",
        "trailer", "proxy-authenticate", "proxy-authorization", "set-cookie", "content-length"];
    const emittable = (n) => {
        if (!n.length || n[0] === ":") return false;
        for (let i = 0; i < n.length; i++) {
            const c = n.charCodeAt(i);
            if (c <= 0x20 || c === 0x7f) return false;
        }
        const l = n.toLowerCase();
        if (RESERVED.indexOf(l) >= 0) return false;
        if (l.indexOf("x-rewind-") === 0 || l.indexOf("x-rove-internal-") === 0) return false;
        return true;
    };
    const cleanVal = (v) => {
        for (let i = 0; i < v.length; i++) {
            const c = v.charCodeAt(i);
            if (c === 13 || c === 10 || c === 0) return false;
        }
        return true;
    };
    const headers = {};
    const hsrc = (raw.headers && typeof raw.headers === "object") ? raw.headers : {};
    for (const k of Object.keys(hsrc).slice(0, 32)) {
        if (!emittable(k)) continue;
        const v = hsrc[k];
        if (typeof v !== "string" || !cleanVal(v)) continue;
        headers[k.toLowerCase()] = v;
    }

    const cookies = [];
    const csrc = Array.isArray(raw.cookies) ? raw.cookies : [];
    for (let i = 0; i < Math.min(csrc.length, 32); i++) {
        const c0 = csrc[i];
        if (typeof c0 !== "string" || !c0.length) continue;
        const segs = c0.split(";");
        let cout = segs[0].trim();
        for (let j = 1; j < segs.length; j++) {
            const seg = segs[j].trim();
            if (!seg.length) continue;
            const eq = seg.indexOf("=");
            const an = (eq < 0 ? seg : seg.slice(0, eq)).trim().toLowerCase();
            if (an === "domain") continue;
            cout += "; " + seg;
        }
        if (cout.length) cookies.push(cout);
    }

    const held = !!(result && typeof result === "object" && result.__rove_disposition === "next");
    if (held) {
        return { held: true, threw: false, status, headers, cookies, body: null, bodyB64: null, binary: false, isJson: false };
    }

    const isBytes = result instanceof Uint8Array;
    let isJson = false;
    let text = null;
    if (typeof result === "string") text = result;
    else if (result === undefined || result === null || isBytes) text = null;
    else {
        const j = JSON.stringify(result);
        if (j !== undefined) { text = j; isJson = true; }
    }
    if (isJson && !("content-type" in headers)) headers["content-type"] = "application/json";

    // First-hop HTTP terminals only — a WS frame went to the socket and a
    // resume's chunks are already on the open stream.
    const frames = (activationKind === "inbound" || activationKind === "inbound_headers")
        ? (effects || []).filter(e => e && e.kind === "stream" && !e.rolledBack && !e.dropped)
            .map(e => e.data == null ? "" : e.data)
        : [];

    const utf8 = (s) => {
        const out = [];
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
            else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
                const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
                i++;
                out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
            } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return new Uint8Array(out);
    };
    const b64 = (u) => {
        const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let s = "";
        for (let i = 0; i < u.length; i += 3) {
            const b0 = u[i], b1 = i + 1 < u.length ? u[i + 1] : 0, b2 = i + 2 < u.length ? u[i + 2] : 0;
            s += A[b0 >> 2] + A[((b0 & 3) << 4) | (b1 >> 4)]
               + (i + 1 < u.length ? A[((b1 & 15) << 2) | (b2 >> 6)] : "=")
               + (i + 2 < u.length ? A[b2 & 63] : "=");
        }
        return s;
    };

    let body;
    if (isBytes && frames.length) {
        const head = utf8(frames.join(""));
        const all = new Uint8Array(head.length + result.length);
        all.set(head, 0);
        all.set(result, head.length);
        body = all;
    } else if (isBytes) {
        body = result;
    } else if (frames.length) {
        body = frames.join("") + (text === null ? "" : text);
    } else {
        body = text === null ? "" : text;
    }

    const binary = body instanceof Uint8Array;
    return {
        held: false,
        threw: false,
        status,
        headers,
        cookies,
        body,
        bodyB64: binary ? b64(body) : null,
        binary,
        isJson,
    };
}

export function buildRequestEpilogue({ record = {}, requestReads = null, bodyBytes = null, exportName = "default", binaryBody = false, activation = "inbound", ctx = undefined, activationBag = undefined, result = null, middlewarePath = null, tenant = null, sagaId = null, captured = true, kvRefusals = null, payloadUnresolved = null } = {}) {
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
        // The capture recorded a payload BY REFERENCE and nothing could
        // resolve it. `bodyRead` above is true whenever the handler read
        // the body, so without this the payload accessors would hand back
        // "" — a lost input wearing the shape of an empty one, which is
        // the failure this field exists to make impossible.
        payloadGone: payloadUnresolved
            ? String(payloadUnresolved.reason || "the recorded payload could not be resolved")
            : null,
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
        // `kv` IS the native common binding — rove's Zig, compiled into this
        // wasm (rove#508): coercion, guards, refusal shapes, effect entries,
        // the harness carve-out, outcome-replay and the host-side poison all
        // run in-module, identical bytes to the worker and the sim. The
        // epilogue's only job is handing the delegate its per-run knobs:
        // `__rove_captured` (set above) and the taped-refusal map.
        "  globalThis.__rove_refusals = D.refusals;\n" +

        // An off-tape read POISONS the run and returns absent — nothing is
        // thrown, so nothing a handler can catch to keep running on fiction
        // invisibly (rove#510). The verdict is HOST-SIDE now (`__rove_poison`
        // → module linear memory, unreachable from VM JS), the interrupt
        // brakes on it, and the parked output carries it post-run via
        // `__rove_divergence()`. First divergence wins, like the native
        // host's.
        "  const miss = (what) => { __rove_poison(what); return undefined; };\n" +
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
        // Refusal, not silence. The handler DID read this payload live;
        // the replay simply does not have it, so serving "" would put a
        // value production never saw in front of every line downstream.
        // Poisoning is the same verdict an off-tape read gets, for the
        // same reason: everything after it is the replay's own invention.
        "    if (D.payloadGone) miss(\"request payload — \" + D.payloadGone);\n" +
        "    else if (!D.bodyRead) miss(\"request payload (bytes/text/json/body)\");\n" +
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
        // A continuation's ctx rides the same envelope as its payload, so
        // an unresolvable envelope loses the ctx too. An absent `ctx` is a
        // legitimate state for an inbound and for the first hop of a
        // chain, so only a resume that LOST its envelope refuses here —
        // otherwise the lost thread reads as "this hop threaded nothing".
        "  else if (D.payloadGone && D.kind !== \"inbound\" && D.kind !== \"inbound_headers\" && D.kind !== \"inbound_chunk\")\n" +
        "    Object.defineProperty(request, \"ctx\", { enumerable: true, configurable: true,\n" +
        "      get() { miss(\"request.ctx — \" + D.payloadGone); return undefined; } });\n" +
        "  request.activation = D.activationBag;\n" +
        "  if (D.tenant !== null) request.tenant = D.tenant;\n" +
        "  if (D.sagaId !== null) request.sagaId = D.sagaId;\n" +
        // request.tag — the native common binding (rove-binding.Tag over the
        // arena delegate, compiled into this wasm): arity gate, pair rules,
        // capacity and refusal shapes are ONE implementation with the worker
        // and the sim; each accepted call lands a {kind:"tag"} effect. It is
        // a FUNCTION, so its absence is not a missing value — a handler that
        // tags its request dies on the call.
        "  request.tag = __rove_request_tag;\n" +
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
        // The handler runs INSIDE a try. A JS exception is an outcome prod
        // serves (500 + `handler threw: …`), not an outcome that stops the
        // replay: without this the run parked nothing, so the shell reported
        // "did not complete" and no digest — on exactly the records people
        // replay most. The offline sim has always caught; this is the third
        // engine catching up.
        //
        // It cannot swallow a REPLAY DIVERGENCE. That verdict is HOST-side
        // (`__rove_poison` → module linear memory) and brakes the run through
        // the runtime's interrupt, which unwinds uncatchably — no JS `catch`,
        // this one included, ever sees it. So a poisoned run still dies with
        // nothing parked, which is exactly how an undeclared read is meant to
        // surface.
        "  let __short = false;\n" +
        "  let __threw = null;\n" +
        "  try {\n" +
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
        "  } catch (e) {\n" +
        // `message` is the exception's ToString, not its `.message` — prod's
        // spelling. The worker's `takeExceptionMessage` records `Error: boom`
        // on the log record and in the wire body; a bare `boom` would drop the
        // error CLASS, which is often the whole diagnosis (SyntaxError vs
        // TypeError vs a thrown string).
        "    __threw = { message: String(e), stack: String((e && e.stack) || \"\") };\n" +
        "    globalThis.__replay_result = null;\n" +
        // Prod rolls the txn back on a throw, so the handler's writes and
        // effects never happened. Mark them — reads and console lines are not
        // outputs, and stream frames may already be on the wire (prod flushes
        // eagerly), so those stay. This does NOT unfold them from the digest,
        // and must not: the fold happens at push time here exactly as the
        // worker folds each interaction as the handler performs it, so a
        // rolled-back write is in prod's digest too.
        "    for (const __e of __effectLog) {\n" +
        "      if (__e.kind !== \"read\" && __e.kind !== \"log\" && __e.kind !== \"stream\") __e.rolledBack = true;\n" +
        "    }\n" +
        "  }\n" +
        // Park the RE-EXECUTED outcome on the host's kv side channel: kv.set
        // writes into the shell's overlay, never the tape, so the host can
        // read back what THIS run produced and compare it against what the
        // capture recorded.
        "  const __ser = (v) => { if (v === undefined || v === null) return null; if (typeof v === \"string\") return v; try { return JSON.stringify(v); } catch (_) { return String(v); } };\n" +
        // The WIRE response — what prod would have shipped, not the handler's
        // raw intent. Both the digest and the shell's response panel read it,
        // and they must read the SAME derivation: a panel showing a body one
        // byte off from the one digested would present a divergence as a
        // faithful reproduction. `deriveWireResponse` is embedded by source
        // because the arena run cannot import this module.
        "  const __deriveWire = " + deriveWireResponse.toString() + ";\n" +
        "  const __wire = __deriveWire(globalThis.__replay_result, globalThis.response, __effectLog, D.kind, __threw && __threw.message);\n" +
        // Close the digest with the run's own wire response — the last element.
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
        "  if (__dg && !__wire.held) __dg.response(__wire.status, __wire.body);\n" +
        // Parks through the native door (the guarded binding refuses the
        // sentinel key exactly as prod does); the divergence verdict comes
        // from module memory, where nothing in the run could touch it.
        //
        // `result` stays alongside the wire body: the body is what the socket
        // received, the result is what the handler returned, and they differ
        // whenever prod transformed one into the other (JSON-stringified,
        // byte-passed, stream-prefixed).
        "  __rove_park_output(JSON.stringify({ status: __wire.status, held: __wire.held, threw: __wire.threw, error: __threw, headers: __wire.headers, cookies: __wire.cookies, body: __wire.binary ? null : __wire.body, bodyB64: __wire.bodyB64, binary: __wire.binary, isJson: __wire.isJson, result: __ser(globalThis.__replay_result), effects: __effectLog, digest: __dg ? __dg.hex() : null, divergence: __rove_divergence() }));\n" +
        "})();\n"
    );
}
