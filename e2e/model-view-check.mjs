// The Model-view logic behind the replay's "state at playhead" pane.
//
// Why this exists: the pane makes claims about what a handler could
// SEE at a point in a past execution. Those claims are unfalsifiable
// by eye — nobody can check them against production — so the rules
// that produce them (a write shadows a read; an absent read is a fact;
// harness bookkeeping is not customer state; an effect is only shown
// where the stop confirms it ran) are pinned here rather than trusted.
//
// Pure functions, no browser: run with `node e2e/model-view-check.mjs`.

import {
    foldModelView, cutInteractionLog, pendingEffects, isInternalKey, durableEffectFor,
} from "../replay/_static/model-view.mjs";

const KV_GET = 0, KV_PREFIX = 3;
const failures = [];
const check = (label, ok, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
    if (!ok) failures.push(label);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("=== replay: the handler's view of the Model ===");

// ── what the handler can see ──────────────────────────────────────
{
    const kvEntries = [
        { op: KV_GET, outcome: 0, key: "cart/1", value: "7" },
        { op: KV_GET, outcome: 1, key: "cart/2", value: "" },      // absent
        { op: KV_PREFIX, outcome: 0, key: "items/", results: [
            { key: "items/a", value: "1" }, { key: "items/b", value: "2" },
        ] },
    ];

    // Before anything ran, the handler has seen nothing — NOT "the
    // store is empty".
    check("a stop before the first read shows no state",
        eq(foldModelView({ kvEntries, reads: [] }), []));

    const afterOne = foldModelView({ kvEntries, reads: ["cart/1"] });
    check("a served read appears with the value the handler got",
        afterOne.length === 1 && afterOne[0].key === "cart/1" &&
        afterOne[0].value === "7" && afterOne[0].origin === "read",
        JSON.stringify(afterOne));

    const afterTwo = foldModelView({ kvEntries, reads: ["cart/1", "cart/2"] });
    const absent = afterTwo.find((r) => r.key === "cart/2");
    check("a read that found nothing is a fact, not an omission",
        absent && absent.state === "absent" && absent.value === null, JSON.stringify(absent));

    const afterScan = foldModelView({ kvEntries, reads: ["cart/1", "cart/2", "items/"] });
    check("a prefix scan contributes every row it returned",
        afterScan.some((r) => r.key === "items/a") && afterScan.some((r) => r.key === "items/b"),
        JSON.stringify(afterScan.map((r) => r.key)));

    // The engine consults the overlay before the tape, so the view must
    // too — otherwise the pane shows a stale value the handler could
    // not possibly have read back.
    const shadowed = foldModelView({
        kvEntries, reads: ["cart/1", "cart/2", "items/"], writes: new Map([["cart/1", "5"]]),
    });
    const cart1 = shadowed.find((r) => r.key === "cart/1");
    check("a write shadows the read of the same key, and is marked as yours",
        cart1.value === "5" && cart1.origin === "you", JSON.stringify(cart1));

    const deleted = foldModelView({ kvEntries, reads: ["cart/1"], writes: new Map([["cart/1", null]]) });
    check("a delete reads as deleted, not as absent-from-view",
        deleted[0].state === "deleted" && deleted[0].origin === "you", JSON.stringify(deleted[0]));

    // Harness bookkeeping is seeded THROUGH kv and lands in the same
    // overlay; showing it would present engine machinery as the
    // customer's data.
    const noise = foldModelView({
        kvEntries: [], reads: [],
        writes: new Map([["__rove_store/auth/token", null], ["__replay_output__", "{}"], ["real/k", "v"]]),
    });
    check("harness bookkeeping never appears as customer state",
        noise.length === 1 && noise[0].key === "real/k", JSON.stringify(noise));
    check("isInternalKey names the machinery",
        isInternalKey("__rove_store/x") && isInternalKey("__replay_output__") && !isInternalKey("a/b"));
}

// ── where the log is cut ──────────────────────────────────────────
{
    const log = [
        { kind: "read", key: "cart/1", value: "7" },
        { kind: "fetch", url: "https://x.test/a", method: "POST" },
        { kind: "write", key: "cart/1", value: "8" },
        { kind: "read", key: "cart/1", value: "8" },   // read-your-write: off-tape
        { kind: "timer", ms: 5000 },
        { kind: "read", key: "other", value: "z" },
        { kind: "write", key: "done", value: "1" },
    ];

    // Stop after the first read: one tape entry consumed, no writes.
    // The fetch that FOLLOWS it is not claimed — nothing at this stop
    // witnesses it, and inventing a promise the handler has not made is
    // the one error this pane must not make.
    let c = cutInteractionLog(log, { reads: ["cart/1"], writes: new Map() });
    check("an effect after the last confirmed point is not claimed to have run",
        c.confident && c.cut === 1, JSON.stringify(c));

    // Stop after the first write: the overlay pins it past the read.
    c = cutInteractionLog(log, { reads: ["cart/1"], writes: new Map([["cart/1", "8"]]) });
    check("a write moves the cut past it — the overlay is the witness",
        c.confident && c.cut === 4, JSON.stringify(c));

    // The read-your-write at index 3 consumes no tape entry, so the
    // cursor must NOT be expected to advance for it.
    c = cutInteractionLog(log, { reads: ["cart/1", "other"], writes: new Map([["cart/1", "8"]]) });
    check("a read served from the handler's own write does not move the cursor",
        c.confident && c.cut === 6, JSON.stringify(c));

    c = cutInteractionLog(log, { reads: ["cart/1", "other"], writes: new Map([["cart/1", "8"], ["done", "1"]]) });
    check("the last confirmed prefix wins", c.confident && c.cut === 7, JSON.stringify(c));

    // A stop neither signal can pin must SAY so rather than assert a
    // position — the pane then shows the hop's effects unpositioned.
    c = cutInteractionLog(log, { reads: ["nope", "nope2", "nope3"], writes: new Map() });
    check("an unpinnable stop is reported, not guessed", c.confident === false, JSON.stringify(c));
}

// ── what is pending ───────────────────────────────────────────────
{
    const log = [
        { kind: "read", key: "a", value: "1" },
        { kind: "fetch", url: "https://x.test/a", method: "POST" },
        { kind: "timer", ms: 5000 },
        { kind: "stream", bytes: 12 },
    ];
    const eff = pendingEffects(log, 3);
    check("only effects before the cut are pending",
        eff.length === 2 && eff[0].label === "http.fetch" && eff[1].label === "after.ms",
        JSON.stringify(eff.map((e) => e.label)));
    check("an effect carries what it will do",
        eff[0].detail === "POST https://x.test/a" && eff[1].detail === "5000 ms",
        JSON.stringify(eff.map((e) => e.detail)));

    // Durable verbs have no private queue — they ARE kv rows, so the
    // pane surfaces those rows as the promises they are.
    const durable = pendingEffects([], 0, new Map([
        ["_send/owed/wh_84c1", "{}"],
        ["_sched/by_id/abc", "{}"],
        ["ordinary/key", "v"],
    ]));
    check("a durable send shows as a pending effect, from its own row",
        durable.some((e) => e.label === "send owed" && e.detail === "wh_84c1"),
        JSON.stringify(durable));
    check("a scheduled wake likewise",
        durable.some((e) => e.label === "scheduled" && e.detail === "abc"), JSON.stringify(durable));
    check("an ordinary write is not an effect", durable.length === 2, JSON.stringify(durable));
    check("durableEffectFor names only the reserved prefixes",
        durableEffectFor("_send/owed/x") !== null && durableEffectFor("cart/1") === null);
}

// ── regressions ───────────────────────────────────────────────────
{
    // rtap returns a plain ARRAY per channel. Reading `.entries` off it
    // yields `Array.prototype.entries` — a function, and truthy, so a
    // `|| []` fallback never fires and the fold threw on every render.
    // The pane showed nothing for its entire first life; the tests
    // could not catch it because they hand-built the array.
    const asArray = [{ op: KV_GET, outcome: 0, key: "k", value: "v" }];
    check("the tape is an ARRAY of entries, and the fold takes it as one",
        foldModelView({ kvEntries: asArray, reads: ["k"] }).length === 1);
    // Degrading means: no throw, and the read is reported as
    // unrecorded — never silently rendered as a value or as absent.
    const degraded = foldModelView({ kvEntries: asArray.entries, reads: ["k"] });
    check("a non-array tape degrades to 'unrecorded' instead of throwing",
        degraded.length === 1 && degraded[0].state === "unrecorded", JSON.stringify(degraded));

    // A read the recorded inputs cannot answer must not be dressed up
    // as `absent` — that asserts something about tenant data the
    // capture does not contain.
    const un = foldModelView({ kvEntries: [], reads: ["ghost"] });
    check("a read with no recorded input says so, rather than 'absent'",
        un.length === 1 && un[0].state === "unrecorded", JSON.stringify(un));

    // Outcomes are ok / not_found / err / refused — flattening the last
    // two into "absent" states a fact the tape never recorded.
    const errRow = foldModelView({
        kvEntries: [{ op: KV_GET, outcome: 2, key: "e", value: "" }], reads: ["e"],
    })[0];
    check("a read that ERRORED is not reported as absent",
        errRow.state === "error", JSON.stringify(errRow));
    const refRow = foldModelView({
        kvEntries: [{ op: KV_GET, outcome: 3, key: "r", value: "" }], reads: ["r"],
    })[0];
    check("a REFUSED read is not reported as absent",
        refRow.state === "refused", JSON.stringify(refRow));

    // A cross-store op logs a BARE key while the write lands namespaced
    // under `__rove_store/` (stripped from the overlay comparison), so
    // simulating it would freeze the cut for the rest of the log.
    const xs = cutInteractionLog([
        { kind: "write", store: "acme", key: "k", value: "1" },
        { kind: "write", key: "real", value: "2" },
    ], { reads: [], writes: new Map([["real", "2"]]) });
    check("a cross-store op does not freeze the cut",
        xs.confident && xs.cut === 2 && xs.complete, JSON.stringify(xs));

    // The cut stops at the last CONFIRMED kv entry, so a trailing
    // effect is withheld — the caller must be able to tell the list is
    // short rather than labelling it complete.
    const partial = cutInteractionLog([
        { kind: "write", key: "a", value: "1" },
        { kind: "fetch", url: "https://x.test", method: "GET" },
    ], { reads: [], writes: new Map([["a", "1"]]) });
    check("a withheld trailing effect is reported as incomplete",
        partial.confident && partial.cut === 1 && partial.complete === false,
        JSON.stringify(partial));
}

if (failures.length) {
    console.log(`\nFAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nPASS — the Model view holds its rules");
