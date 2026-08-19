// The kv read budget's browser half (rove#430 §3).
//
// Why this exists: the capture drops a read's VALUE when an activation's kv
// tape would grow past the budget that keeps the readset inside a raft frame,
// and records the read as `elided` with the lost byte count. Every reader has
// to treat that as a REFUSAL. In this shell two readers see it — the RTAP
// decoder (which must carry the new outcome and the prefix entry's trailing
// byte count) and the Model pane (which must not render a dropped value as
// absent, a claim about the tenant's data the capture does not contain).
//
// Pure functions, no browser: run with `node e2e/kv-budget-check.mjs`.

import {
    serializeTape, parseTapeBlob, CHANNEL_KV, RTAP_VERSION,
} from "../replay/_static/rtap.mjs";
import { foldModelView } from "../replay/_static/model-view.mjs";

const KV_GET = 0, KV_PREFIX = 3;
const KV_OK = 0, KV_ELIDED = 4;

const failures = [];
const check = (label, ok, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
    if (!ok) failures.push(label);
};

console.log("=== replay: a value the kv budget dropped ===");

// ── the wire: v9 carries the outcome and the elided page's lost bytes ──
{
    check("RTAP_VERSION is the version that knows `elided`", RTAP_VERSION === 9, String(RTAP_VERSION));

    const blob = serializeTape(CHANNEL_KV, [
        { op: KV_GET, outcome: KV_OK, key: "user/jess", value: "{\"n\":1}" },
        { op: KV_GET, outcome: KV_ELIDED, key: "big/blob", value: "900000" },
        // An elided page carries NO rows — all-or-nothing, because a partial
        // page would replay as a complete, shorter one.
        { op: KV_PREFIX, outcome: KV_ELIDED, key: "feed/", cursor: "", limit: 100, results: [], value: "400000" },
    ]);
    const { channel, entries } = parseTapeBlob(blob);
    check("kv channel round-trips", channel === CHANNEL_KV && entries.length === 3, `${channel}/${entries.length}`);
    check("an ordinary read still carries its value", entries[0].value === "{\"n\":1}", entries[0].value);
    check("an elided get carries the lost byte count",
        entries[1].outcome === KV_ELIDED && entries[1].value === "900000",
        JSON.stringify(entries[1]));
    check("an elided page carries no rows and its lost byte count",
        entries[2].outcome === KV_ELIDED && entries[2].results.length === 0 && entries[2].value === "400000",
        JSON.stringify(entries[2]));
}

// ── the pane: `elided` is its own word, never `absent` ──
{
    const rows = foldModelView({
        kvEntries: [
            { op: KV_GET, outcome: KV_OK, key: "cart/1", value: "7" },
            { op: KV_GET, outcome: KV_ELIDED, key: "big/blob", value: "900000" },
        ],
        reads: ["cart/1", "big/blob"],
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const cut = byKey.get("big/blob");
    check("a dropped value renders as `elided`, not `absent`",
        cut && cut.state === "elided", JSON.stringify(cut));
    check("and carries no value to mistake for the real one",
        cut && cut.value === null, JSON.stringify(cut));
    check("an ordinary read is unaffected",
        byKey.get("cart/1")?.state === "ok", JSON.stringify(byKey.get("cart/1")));
}

if (failures.length) {
    console.log(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nPASS — an elided read survives the wire and reads as a refusal, never as absence.");
