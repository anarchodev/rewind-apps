// The handler's view of the Model at a point in the replay, and the
// effects it has queued by that point.
//
// This is the question a human actually asks while scrubbing: *what
// can this handler see right now, and what has it promised to do?*
// Both are answerable exactly, because the replay is a stopped run:
//
//   · WRITES — the host's kv overlay, captured at the stop. The engine
//     consults it BEFORE the tape on every read, so a write shadows a
//     read of the same key exactly as it did live.
//   · READS  — the kv tape, consumed in order; the stop's cursor says
//     how far. Each entry carries the value the handler was SERVED.
//   · EFFECTS — the epilogue's ordered interaction log, cut at the
//     stop (see `cutInteractionLog`).
//
// The one thing this is NOT is the tenant's database. A replay only
// knows keys the handler touched, so a key it never read has no
// recorded value and must render as unknown — never as absent. That
// limit is the point, not a gap: determinism says the handler's view
// is what decided the outcome.

// Bookkeeping the harness seeds through kv so the recorders' private
// reads never reach the strict tape (see the epilogue's `__rove_store/`
// seeding). Production has no such keys; they are not customer state
// and must not appear in a view of it.
const HARNESS_PREFIX = "__rove_store/";
// The channel the epilogue parks its outcome on — machinery, not state.
const OUTPUT_KEY = "__replay_output__";

const KV_OP_GET = 0, KV_OP_PREFIX = 3;
// Read outcomes (src/tape/root.zig `KvOutcome`, mirrored in rtap).
// `not_found` is a different fact from `err`/`refused`, and the pane
// must not flatten them into one word.
const KV_OK = 0, KV_NOT_FOUND = 1, KV_REFUSED = 3;

export function isInternalKey(k) {
    return typeof k !== "string" || k === OUTPUT_KEY || k.startsWith(HARNESS_PREFIX);
}

// Durable effects have no private queue: `webhook.send` and `schedule`
// write ordinary kv rows, because durability has exactly one home
// (effect-algebra L1). So a pending durable effect IS a key under one
// of these prefixes — the same fact seen from the Model side.
const DURABLE_PREFIXES = [
    { prefix: "_send/owed/", label: "send owed" },
    { prefix: "_sched/by_id/", label: "scheduled" },
];

export function durableEffectFor(key) {
    for (const d of DURABLE_PREFIXES) {
        if (key.startsWith(d.prefix)) {
            return { label: d.label, id: key.slice(d.prefix.length) };
        }
    }
    return null;
}

/// Fold the handler's view of the Model at a stop.
///
/// `kvEntries` is the kv tape (rtap returns a plain ARRAY of entries —
/// it has no `.entries` property, and reading one silently yields
/// `Array.prototype.entries`), `reads` the keys the run has read so
/// far in order, `writes` the overlay snapshot (key → value, `null` =
/// deleted).
///
/// Rows carry WHERE the value came from, because that distinction is
/// the whole diagnostic value: `you` means this handler put it there,
/// `read` means the handler was served it and someone else owns it.
export function foldModelView({ kvEntries = [], reads = [], writes = new Map() }) {
    const rows = new Map();

    // Index the recorded inputs the way the HOST does — by key, first
    // occurrence wins — because that is what a read was actually
    // served.
    const byKey = new Map();
    const prefixByKey = new Map();
    for (const e of Array.isArray(kvEntries) ? kvEntries : []) {
        if (!e || isInternalKey(e.key)) continue;
        if (e.op === KV_OP_PREFIX) {
            if (!prefixByKey.has(e.key)) prefixByKey.set(e.key, e);
        } else if (e.op === KV_OP_GET && !byKey.has(e.key)) {
            byKey.set(e.key, e);
        }
    }

    // Reads first, in the order the handler asked. A prefix scan
    // contributes every row it returned — those are keys it saw.
    for (const key of Array.isArray(reads) ? reads : []) {
        if (typeof key !== "string" || isInternalKey(key)) continue;
        const scan = prefixByKey.get(key);
        if (scan) {
            for (const r of scan.results || []) {
                if (isInternalKey(r.key)) continue;
                rows.set(r.key, { key: r.key, value: r.value, origin: "read", state: "ok" });
            }
            continue;
        }
        const e = byKey.get(key);
        // A read the recorded inputs cannot answer. Saying so is the
        // point: the alternative is rendering it as absent, which
        // asserts something about the tenant's data that the capture
        // does not contain.
        if (!e) {
            rows.set(key, { key, value: null, origin: "read", state: "unrecorded" });
            continue;
        }
        // The outcome is itself the fact the handler acted on — and
        // "not found" is a different claim from "the read failed".
        const state = e.outcome === KV_OK ? "ok"
            : e.outcome === KV_NOT_FOUND ? "absent"
            : e.outcome === KV_REFUSED ? "refused"
            : "error";
        rows.set(e.key, {
            key: e.key,
            value: state === "ok" ? e.value : null,
            origin: "read",
            state,
        });
    }

    // Writes shadow reads — the engine's own precedence.
    for (const [k, v] of writes) {
        if (isInternalKey(k)) continue;
        rows.set(k, { key: k, value: v, origin: "you", state: v === null ? "deleted" : "ok" });
    }

    return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/// Who wrote the value this hop was served for `key` — the blame half
/// of "I read 5, who wrote 5?".
///
/// `seam` is the interference scan of the seam IMMEDIATELY BEFORE the
/// hop in view, and only that seam. It is the one whose probe is this
/// hop's own read set, so within it "the last activation that wrote
/// this key" is the last writer before the hop, full stop. An earlier
/// seam's scan was probed against a DIFFERENT hop's reads, so a write
/// that happened between then and now can be missing from it entirely —
/// reaching back would let a stale writer outrank a real one, which is
/// the one mistake a blame link must never make.
///
/// Only `wrote` participates. An activation that merely READ the key
/// observed the value; naming it the writer would invent the very fact
/// the link exists to establish.
///
/// The four answers are deliberately distinct, because "nothing wrote
/// it" and "nothing looked" are different claims:
///
///   · `found`     — this activation wrote it, and is the last that did.
///   · `none`      — the seam was scanned in full and nothing in it
///                   wrote this key, so the value predates the seam.
///   · `capped`    — the scan hit its cap, so no conclusion is
///                   available: an unexamined candidate may have
///                   written it.
///   · `unscanned` — there is no scan to consult at all.
export function blameForKey(seam, key) {
    if (!seam || !Array.isArray(seam.interacting)) return { status: "unscanned", row: null };
    // Ascending by tape position, so the LAST match is the last writer.
    let found = null;
    for (const row of seam.interacting) {
        if (!Array.isArray(row?.wrote)) continue;
        if (row.wrote.includes(key)) found = row;
    }
    if (found) return { status: "found", row: found };
    return { status: seam.scan_truncated ? "capped" : "none", row: null };
}

const KV_LOG_KINDS = new Set(["read", "write", "delete"]);

/// Cut the ordered interaction log at the stop.
///
/// The log is assembled inside the arena as entries arrive, so its
/// ORDER is exact — but it is only handed out at end-of-run, so the
/// cut has to be recovered from what the stop does expose. Two
/// independent signals pin it:
///
///   · the overlay — replaying the log's writes/deletes must reproduce
///     it exactly;
///   · the reads — the keys the run has actually read, in order. A read
///     of a key the handler already wrote reaches no recorded input
///     (the engine answers it from the overlay, and capture elides it
///     for the same reason), so the simulation skips those too.
///
/// The last prefix that satisfies BOTH is the cut. If nothing
/// satisfies both — a shape neither signal can pin — the caller is
/// told (`confident: false`) so it can say the position is unknown
/// rather than assert one.
///
/// `complete` says the cut reached the end of the log, i.e. every
/// effect the hop ever emitted is included. It matters because the cut
/// stops at the last CONFIRMED kv entry: trailing effects after it are
/// deliberately withheld (claiming a promise the handler has not made
/// is the one error worth avoiding here), so a caller must not label a
/// short list as "everything queued by now".
export function cutInteractionLog(log = [], { reads = [], writes = new Map(), end = false } = {}) {
    // At the END of the run nothing is in doubt: the handler has
    // finished, so every logged entry has run. The conservative
    // mid-run cut below would withhold a trailing effect here and the
    // pane would report 'none queued' for a hop that queued one.
    if (end) return { cut: log.length, confident: true, complete: true };
    const real = new Map();
    for (const [k, v] of writes) if (!isInternalKey(k)) real.set(k, v);
    const readKeys = (Array.isArray(reads) ? reads : []).filter((k) => !isInternalKey(k));

    const sim = new Map();
    let served = 0;
    let cut = -1;

    const matches = () => {
        if (sim.size !== real.size) return false;
        for (const [k, v] of sim) {
            if (!real.has(k)) return false;
            if (real.get(k) !== v) return false;
        }
        return true;
    };

    // The empty prefix is a candidate too: a stop before anything ran.
    if (served === readKeys.length && matches()) cut = 0;

    for (let i = 0; i < log.length; i++) {
        const e = log[i] || {};
        if (!KV_LOG_KINDS.has(e.kind)) continue;
        // A cross-store op (`platform.scope(x).kv`) logs a BARE key
        // while the write lands namespaced under `__rove_store/` — which
        // the overlay comparison strips. Simulating it would put a key
        // in `sim` that `real` can never contain, freezing the cut for
        // the rest of the log.
        if (e.store) continue;
        if (isInternalKey(e.key)) continue;
        if (e.kind === "read") {
            // Read-your-write: served from the overlay, off-tape.
            if (!sim.has(e.key)) {
                if (served >= readKeys.length) break; // has not run yet
                served++;
            }
        } else {
            sim.set(e.key, e.kind === "delete" ? null : e.value);
        }
        if (served === readKeys.length && matches()) cut = i + 1;
    }

    if (cut < 0) return { cut: log.length, confident: false, complete: false };
    return { cut, confident: true, complete: cut >= log.length };
}

const EFFECT_LABELS = {
    fetch: "http.fetch",
    subscribe: "subscribe",
    "kv-wake": "after.kv",
    timer: "after.ms",
    stream: "stream.write",
    blob: "blob",
    platform: "platform",
};

/// The effects this handler has queued by the cut — the Cmd half of
/// the activation, none of which has fired: they are released only
/// after the writes commit, which is exactly why "pending" is the
/// honest word for them mid-run.
export function pendingEffects(log = [], cut = 0, writes = new Map()) {
    const out = [];
    for (const e of log.slice(0, cut)) {
        if (!e || KV_LOG_KINDS.has(e.kind)) continue;
        const label = EFFECT_LABELS[e.kind];
        if (!label) continue;
        out.push({
            kind: e.kind,
            label,
            detail: effectDetail(e),
        });
    }
    // The durable verbs decompose into kv rows rather than a private
    // queue, so surface those rows AS the effects they are — the same
    // promise, seen from the Model side.
    for (const [k, v] of writes) {
        if (typeof k !== "string" || v === null) continue;
        const d = durableEffectFor(k);
        if (d) out.push({ kind: "durable", label: d.label, detail: d.id, key: k });
    }
    return out;
}

function effectDetail(e) {
    switch (e.kind) {
        case "fetch": return `${e.method || "GET"} ${e.url || ""}`;
        case "subscribe": return e.url || "";
        case "kv-wake": return e.prefix || "";
        case "timer": return `${e.ms} ms`;
        case "stream": return `${e.bytes} byte${e.bytes === 1 ? "" : "s"}`;
        case "blob": return e.op || "";
        case "platform": return e.op || "";
        default: return "";
    }
}
