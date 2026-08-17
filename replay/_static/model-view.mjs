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
/// `kvEntries` are the parsed kv tape entries (rtap), `readCursor` how
/// many of them the run consumed, `writes` the overlay snapshot
/// (key → value, `null` = deleted).
///
/// Rows carry WHERE the value came from, because that distinction is
/// the whole diagnostic value: `you` means this handler put it there,
/// `read` means the handler was served it and someone else owns it.
export function foldModelView({ kvEntries = [], readCursor = 0, writes = new Map() }) {
    const rows = new Map();

    // Reads first: the values the handler was served, in the order it
    // asked. A prefix scan contributes every row it returned — those
    // are keys the handler saw.
    const consumed = kvEntries.slice(0, Math.max(0, readCursor));
    for (const e of consumed) {
        if (e.op === KV_OP_PREFIX) {
            for (const r of e.results || []) {
                if (isInternalKey(r.key)) continue;
                rows.set(r.key, { key: r.key, value: r.value, origin: "read", deleted: false });
            }
            continue;
        }
        if (e.op !== KV_OP_GET || isInternalKey(e.key)) continue;
        // outcome != ok means the handler was served "absent", which is
        // itself a fact it acted on.
        const absent = e.outcome !== 0;
        rows.set(e.key, {
            key: e.key,
            value: absent ? null : e.value,
            origin: "read",
            deleted: absent,
        });
    }

    // Writes shadow reads — the engine's own precedence.
    for (const [k, v] of writes) {
        if (isInternalKey(k)) continue;
        rows.set(k, { key: k, value: v, origin: "you", deleted: v === null });
    }

    return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
///   · the read cursor — the number of tape-consuming reads. A read of
///     a key the handler already wrote consumes NOTHING (the engine
///     answers it from the overlay, and capture elides it from the
///     tape for the same reason), so the simulation skips those too.
///
/// The last prefix that satisfies BOTH is the cut. If nothing
/// satisfies both — a shape neither signal can pin, e.g. a hop that
/// neither read nor wrote — the caller is told (`confident: false`)
/// so it can say the position is unknown rather than assert one.
export function cutInteractionLog(log = [], { readCursor = 0, writes = new Map() } = {}) {
    const real = new Map();
    for (const [k, v] of writes) if (!isInternalKey(k)) real.set(k, v);

    const sim = new Map();
    let taped = 0;
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
    if (taped === readCursor && matches()) cut = 0;

    for (let i = 0; i < log.length; i++) {
        const e = log[i] || {};
        if (!KV_LOG_KINDS.has(e.kind)) {
            // A non-kv effect moves neither signal, so nothing here can
            // confirm it ran. It is included only when a LATER kv entry
            // is confirmed (everything before a confirmed point ran) —
            // never on its own. Claiming a trailing effect had fired
            // would be the pane inventing a promise the handler has not
            // made yet, which is the one error that matters here.
            continue;
        }
        if (e.kind === "read") {
            if (isInternalKey(e.key)) continue;
            // Read-your-write: served from the overlay, off-tape.
            if (!sim.has(e.key)) {
                if (taped >= readCursor) break; // this read has not run yet
                taped++;
            }
        } else if (!isInternalKey(e.key)) {
            sim.set(e.key, e.kind === "delete" ? null : e.value);
        }
        if (taped === readCursor && matches()) cut = i + 1;
    }

    if (cut < 0) return { cut: log.length, confident: false };
    return { cut, confident: true };
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
