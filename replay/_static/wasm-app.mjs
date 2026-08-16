// rewind.js replay shell — WASM-driven.
//
// Runs at `replay.{public_suffix}/`. The dashboard's Replay button
// opens this URL in a popup and posts a `replay:bundle` message
// once we send back `replay:ready`.
//
// Pipeline:
//   1. Receive `replay:bundle` from the dashboard.
//   2. Parse captured tape blobs via rtap.mjs (mirrors
//      src/tape/root.zig encoding rule-for-rule).
//   3. Boot arenajs-WASM once.
//   4. Drive the run through CursorEngine.materialise() (one drill
//      pass, caches events + sidecar indexes).
//   5. Render the shell from `mat` + `playhead`. Re-rendering is
//      cheap; everything we need is O(1) addressable in `mat`.
//
// What's wired this pass:
//   ✓ appbar identity + outcome badge
//   ✓ modules rail with path-prefix + basename
//   ✓ source viewport (entry by default; click switches; current line
//     tracks the playhead)
//   ✓ event stream (past/current/future styling based on playhead)
//   ✓ scrubber ticks for scan events; playhead chip
//   ✓ stack breadcrumb derived from events up to playhead
//   ✓ next-error count
//
// Still stubbed (controls disabled — coming next pass):
//   ✗ step buttons / play
//   ✗ scrubber drag
//   ✗ variables drawer (needs engine.inspectAt — wired in phase C)

import { buildTapesFromBlobs } from "./rtap.mjs";
import { buildRequestEpilogue, exportForActivation, deriveActivationSurface, resolveMiddleware, MIDDLEWARE_PATHS, REPLAY_OUTPUT_KEY } from "./request-replay.mjs";
import { SYSTEM_MODULES } from "./arena-system-modules.js";
import { CursorEngine } from "./cursor.mjs";
import getArenaJs from "./qjs_arena_wasm.js";

// The JS engine version of the arenajs WASM bundled with this replayer
// (`qjs_arena_wasm.{js,wasm}`). MUST track the server-side
// `qjs/version.zig` `JS_ENGINE_VERSION` of the same arenajs pin
// (format-versioning-audit.md §4). A capture stamped with a different
// version can't be faithfully replayed by this build until per-version
// engine fetch ships (Phase 3); we surface a clear error instead of
// replaying on the wrong interpreter. Bump in lockstep with the Zig
// constant when the WASM is rebuilt from a semantics-affecting pin.
const REPLAY_ENGINE_VERSION = 1;

// ── DOM refs (lookup once at module load) ────────────────────────────
const $ = {
    crumb:           document.getElementById("appbar-crumb"),
    meta:            document.getElementById("appbar-meta"),
    stack:           document.getElementById("stack-frames"),
    nextErrorBtn:    document.getElementById("next-error-btn"),
    nextErrorLabel:  document.getElementById("next-error-label"),
    modTree:         document.getElementById("mod-tree"),
    sourceHeader:    document.getElementById("source-header"),
    sourceState:     document.getElementById("source-state"),
    sourceCode:      document.getElementById("source-code"),
    stream:          document.getElementById("event-stream"),
    scrubberTicks:   document.getElementById("scrubber-ticks"),
    scrubberPlayed:  document.getElementById("scrubber-played"),
    scrubberPlayhead: document.getElementById("scrubber-playhead"),
    transportTime:   document.getElementById("transport-time"),
};

// Transport buttons by aria-label. The HTML names them via aria-label
// instead of ids because the natural reading is "the button labelled
// Step over" — these JS-side bindings are the implementation of that
// affordance.
function btn(label) {
    return document.querySelector(`.transport__controls button[aria-label="${label}"]`);
}
const T = {
    jumpStart: btn("Jump to start"),
    stepBack:  btn("Step back"),
    play:      btn("Step forward"),    // ▶ — now the forward sibling of ◀
    stepOver:  btn("Step over"),
    stepIn:    btn("Step into"),
    stepOut:   btn("Step out"),
    stepLine:  btn("Step line"),
    jumpEnd:   btn("Jump to end"),
};
const $scrubber = document.querySelector(".scrubber");

// ── JavaScript syntax tokenizer ──────────────────────────────────────
// Per-line regex tokenizer for source highlighting. Maps to the
// canonical `tok-*` classes in rewind.css: tok-kw / tok-str /
// tok-num / tok-comm. Identifiers and punctuation render neutrally.

const TOK_PATTERNS = [
    { type: "comment", re: /^\/\/.*/ },
    { type: "comment", re: /^\/\*[\s\S]*?\*\// },
    { type: "string",  re: /^"(?:[^"\\]|\\.)*"/ },
    { type: "string",  re: /^'(?:[^'\\]|\\.)*'/ },
    { type: "string",  re: /^`(?:[^`\\]|\\.)*`/ },
    { type: "number",  re: /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/ },
    { type: "keyword", re: /^(?:const|let|var|function|async|await|return|throw|new|if|else|for|while|of|in|import|export|from|class|extends|try|catch|finally|typeof|instanceof|break|continue|switch|case|default|null|true|false|undefined|this|do|delete|void|yield|static|get|set)\b/ },
    { type: "ident",   re: /^[a-zA-Z_$][a-zA-Z0-9_$]*/ },
    { type: "punc",    re: /^[+\-*/%=<>!&|^~?:.,;()[\]{}]+/ },
    { type: "space",   re: /^\s+/ },
];

const TOK_CLASS = {
    keyword: "tok-kw",
    string:  "tok-str",
    number:  "tok-num",
    comment: "tok-comm",
};

function tokenize(src) {
    const tokens = [];
    let pos = 0;
    while (pos < src.length) {
        let matched = false;
        const rest = src.slice(pos);
        for (const { type, re } of TOK_PATTERNS) {
            const m = rest.match(re);
            if (m && m.index === 0) {
                tokens.push({ type, text: m[0] });
                pos += m[0].length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            tokens.push({ type: "other", text: src[pos] });
            pos++;
        }
    }
    return tokens;
}

function appendTokenized(parent, lineSrc) {
    for (const tok of tokenize(lineSrc)) {
        const cls = TOK_CLASS[tok.type];
        if (cls) {
            const span = document.createElement("span");
            span.className = cls;
            span.textContent = tok.text;
            parent.appendChild(span);
        } else {
            parent.appendChild(document.createTextNode(tok.text));
        }
    }
}

// ── Small helpers ────────────────────────────────────────────────────

function el(tag, opts = {}) {
    const e = document.createElement(tag);
    if (opts.className) e.className = opts.className;
    if (opts.text != null) e.textContent = String(opts.text);
    if (opts.title) e.title = opts.title;
    if (opts.style) Object.assign(e.style, opts.style);
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
    return e;
}

function splitPath(p) {
    const i = p.lastIndexOf("/");
    return i < 0 ? { dir: "", base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

function shortHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0").slice(0, 4);
}

function badgeKindFor(status) {
    if (status == null) return "";
    if (status >= 200 && status < 300) return "badge--ok";
    if (status >= 300 && status < 400) return "badge--info";
    if (status >= 400 && status < 500) return "badge--warn";
    return "badge--error";
}

// ── Bundle acquisition: opener handshake + reload cache ──────────────
//
// The dashboard opens this page with the record's identity in the URL
// fragment (#/{instance}/{request_id}) and posts the composed bundle
// via postMessage. The received bundle is cached in sessionStorage
// under that fragment, so a browser refresh — or a duplicated tab,
// which copies sessionStorage — boots the same record with no opener.
// A tab with neither opener nor cache cannot compose the bundle itself
// (record access is the dashboard's session, not this origin's), so it
// gets pointed back at the dashboard's page for this record.

function expectedDashboardOrigin() {
    return window.location.origin.replace("://replay.", "://app.");
}

function bundleCacheKey() {
    return "replay:bundle:" + (window.location.hash || "#");
}

function cachedBundle() {
    try {
        const raw = sessionStorage.getItem(bundleCacheKey());
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function cacheBundle(bundle) {
    // Best-effort: a bundle past the sessionStorage quota simply isn't
    // cached — the tab still works, only its refresh loses state and
    // shows the reopen guidance.
    try { sessionStorage.setItem(bundleCacheKey(), JSON.stringify(bundle)); }
    catch { /* quota exceeded */ }
}

function awaitBundle() {
    const cached = cachedBundle();
    if (cached) return Promise.resolve(cached);
    if (!window.opener) {
        const m = window.location.hash.match(/^#\/([^/]+)\/./);
        const back = m
            ? `${expectedDashboardOrigin()}/#/instance/${m[1]}`
            : expectedDashboardOrigin() + "/";
        return Promise.reject(new Error(
            "no replay state in this tab — reopen this record from the dashboard: " + back));
    }
    const expectedOrigin = expectedDashboardOrigin();
    window.opener.postMessage({ kind: "replay:ready" }, expectedOrigin);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            window.removeEventListener("message", onMsg);
            reject(new Error("bundle timeout (10s)"));
        }, 10_000);
        function onMsg(e) {
            if (e.origin !== expectedOrigin) return;
            if (e.source !== window.opener) return;
            if (e.data?.kind !== "replay:bundle") return;
            clearTimeout(timer);
            window.removeEventListener("message", onMsg);
            cacheBundle(e.data.bundle);
            resolve(e.data.bundle);
        }
        window.addEventListener("message", onMsg);
    });
}

// ── Bundle helpers ───────────────────────────────────────────────────

function resolveEntry(bundle) {
    // A callback activation ran a baked builtin, NOT the tenant's entry —
    // and the bundle's `entry_path` is composed from the tenant's deployed
    // handlers, so it names index.mjs regardless. Prefer what actually ran
    // (rove#236); without this the shell compiled the wrong module and the
    // module tape diverged on the first import.
    const sys = activationEntryFor(bundle);
    if (sys) return sys;
    if (bundle.entry_path) return bundle.entry_path;
    const idx = (bundle.modules || []).find(m => m.path === "index.mjs");
    if (idx) return idx.path;
    throw new Error("bundle has no entry_path and no index.mjs");
}

function buildModuleSources(bundle) {
    // The engine's baked `__system/*` handlers underlie everything the
    // bundle carries: they live in the worker binary, so no tenant's
    // deployment sources can supply them (rove#236). They go in FIRST so a
    // tenant file of the same name would win — a tenant cannot actually
    // own that namespace, but source-of-truth should follow the bundle.
    const out = { ...SYSTEM_MODULES };
    for (const m of (bundle.modules || [])) out[m.path] = m.source;
    return out;
}

// The module a CALLBACK activation ran. For these the log record's `path`
// is the module it dispatched to, not a URL — the discriminator is the
// leading slash, which every inbound URL has and no module path does
// (`__system/webhook_onresult`, `v1/deploy/cut/index`). The resolver
// appends `.mjs` exactly as it does for tenant modules.
//
// Inbound records are NOT covered and cannot be: production resolves the
// entry from its router (`route.module_base`), and the resolved module is
// recorded nowhere, so a route-modular tenant's inbound records replay
// against the wrong module. See rove#249 surface S4.
const INBOUND_KINDS = new Set(["inbound", "inbound_headers", "inbound_chunk"]);

function activationEntryFor(bundle) {
    const p = bundle.request?.path || "";
    if (!p || p.startsWith("/")) return null;          // a URL, not a module
    if (INBOUND_KINDS.has(bundle.activation)) return null;
    return p.endsWith(".mjs") || p.endsWith(".js") ? p : p + ".mjs";
}

function rewriteImportSpecifiers(moduleSources, bundle) {
    const pkgByHash = {};
    for (const p of (bundle.packages || [])) pkgByHash[p.pkg_hash] = p;
    const mapFor = (path) => {
        const m = /^\/pkg\/([0-9a-f]{64})\//.exec(path);
        if (!m) return bundle.app_imports || {};
        return pkgByHash[m[1]]?.imports || {};
    };
    const out = {};
    for (const [path, src] of Object.entries(moduleSources)) {
        let s = src;
        for (const [spec, hash] of Object.entries(mapFor(path))) {
            // A bare package specifier resolves to the package's entry
            // file — index.mjs by the package-layout convention.
            const virt = "/pkg/" + hash + "/index.mjs";
            s = s.split('"' + spec + '"').join('"' + virt + '"')
                 .split("'" + spec + "'").join("'" + virt + "'");
        }
        out[path] = s;
    }
    return out;
}

// ── Derived helpers over materialised data ───────────────────────────
//
// `mat.events` is the full drill stream (FUNC_ENTER / FUNC_EXIT /
// LINE / THROW). Most rendering is parameterised on a `playhead`
// index into this array.

// ── Frame provenance ─────────────────────────────────────────────────
//
// The trace stream records every JS frame the engine executed — which
// includes the replay shell's own machinery: the generated
// arena-prelude shims and the interaction-digest mirror run as
// base-arena code whose file the engine reports as "<arena-base>", and
// a kv-heavy handler sprays dozens of those frames per request. They
// are the engine's frames, not the customer's: the timeline, the
// scrubber ticks, and the source highlight speak customer code only.
// The full stream stays intact in mat.events (step-parity, the digest,
// and the vars passes all index into it); provenance is a presentation
// index over it, not a filter of it.
//
// "Customer" = the file is a module shipped in the bundle. Anything
// else — the base arena, a synthetic eval name, a module the capture
// did not ship — is an engine frame.
function isCustomerFile(file) {
    return !!file && state.modulePaths != null && state.modulePaths.has(file);
}

// The epilogue is APPENDED to the entry module's source before the run
// (request-replay.mjs), so its frames wear the customer's filename —
// with line numbers past the end of the file the bundle actually
// shipped. Provenance is therefore a (file, line) question: customer
// code is a bundle file at a line the bundle's source contains. Line
// 0 / missing line info counts as in-file (exits carry no line).
function isCustomerLoc(file, line) {
    if (!isCustomerFile(file)) return false;
    if (!line) return true;
    const count = state.moduleLineCounts?.get(file);
    return count == null || line <= count;
}

// A frame whose bytecode carries no name (arrow functions, function
// expressions the compiler didn't name) reaches the host as atom 0 and
// renders as "<atom:0>" — noise dressed as data. Show "(anonymous)";
// the file:line beside it is the identity that matters.
function displayName(name) {
    return /^<atom:\d+>$/.test(name ?? "") ? "(anonymous)" : name;
}

// Per-event provenance, one O(events) walk, cached on the materialised:
//   prov[i].own           — the event itself executes customer code
//   prov[i].customerFrame — innermost stack frame in bundle code at
//                           this moment ({file, line}), or null
// mat._provHasCustomer records whether ANY event is customer-owned; a
// record with none (sources missing from the bundle) degrades to the
// unfiltered behaviour rather than an unwalkable timeline.
function provenanceIndex(mat) {
    if (mat._prov) return mat._prov;
    const prov = new Array(mat.events.length);
    const stack = [];
    let hasCustomer = false;
    // Rail geometry (see pctForEventIdx): the ordered customer-owned
    // event indices, plus each raw index's position in that order.
    const ownIdx = [];
    const ownPos = new Int32Array(mat.events.length);
    for (let i = 0; i < mat.events.length; i++) {
        const e = mat.events[i];
        if (e.kind === "FUNC_ENTER") {
            const customer = isCustomerLoc(e.file, e.line);
            stack.push({
                file: e.file, line: e.line, customer,
                // Last line of THIS frame that sits inside the bundle's
                // source — the entry <eval> frame spans both the
                // customer's module body and the appended epilogue, and
                // the highlight must not chase it past the file's end.
                custLine: customer ? e.line : null,
            });
        } else if (e.kind === "FUNC_EXIT") {
            stack.pop();
        } else if (e.kind === "LINE" && stack.length > 0) {
            const top = stack[stack.length - 1];
            top.line = e.line;
            if (top.customer && isCustomerLoc(top.file, e.line)) top.custLine = e.line;
        }
        // FUNC_EXIT "executes" in the frame it returns into.
        const own = e.kind === "FUNC_EXIT"
            ? (stack.length > 0 && stack[stack.length - 1].customer
               && isCustomerLoc(stack[stack.length - 1].file, stack[stack.length - 1].line))
            : isCustomerLoc(e.file, e.line);
        let customerFrame = null;
        for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].customer) {
                customerFrame = {
                    file: stack[s].file,
                    line: stack[s].custLine ?? stack[s].line,
                };
                break;
            }
        }
        if (own) { hasCustomer = true; ownIdx.push(i); }
        ownPos[i] = ownIdx.length > 0 ? ownIdx.length - 1 : 0;
        prov[i] = { own, customerFrame };
    }
    mat._prov = prov;
    mat._provHasCustomer = hasCustomer;
    mat._ownIdx = hasCustomer ? ownIdx : null;
    mat._ownPos = hasCustomer ? ownPos : null;
    return prov;
}

// The ordered customer-owned event indices — the rail's coordinate
// space. Null when the record has no customer-owned events (raw space
// applies there).
function ownEventIndex(mat) {
    provenanceIndex(mat);
    return mat._ownIdx;
}

// Stack snapshot at the moment the playhead event fired. Cheap to
// recompute (one O(events) walk) — and once we have mat.stackSnapshots
// from materialise() this becomes O(stackSnapshotStep). For now we
// walk linearly, which is fine for handler-scale traces.
function stackAtPlayhead(mat, playhead) {
    const stack = [];
    let throwInfo = null;
    for (let i = 0; i <= playhead && i < mat.events.length; i++) {
        const e = mat.events[i];
        if (e.kind === "FUNC_ENTER") {
            stack.push({ name: e.name, file: e.file, line: e.line });
        } else if (e.kind === "FUNC_EXIT") {
            stack.pop();
        } else if (e.kind === "LINE" && stack.length > 0) {
            stack[stack.length - 1].line = e.line;
        } else if (e.kind === "THROW") {
            throwInfo = { file: e.file, line: e.line, message: e.message };
            // Throws don't pop frames on their own.
        }
    }
    return { stack, throwInfo };
}

// (file, line) for the source viewport based on the current playhead.
// The viewport shows CUSTOMER code: while the playhead traverses an
// engine frame (a shim or digest helper the handler's kv call entered),
// the highlight stays on the innermost bundle frame that got us there —
// the line the customer can actually read — instead of going blank on a
// file the bundle doesn't carry.
function currentSourceForPlayhead(mat, playhead) {
    const { stack, throwInfo } = stackAtPlayhead(mat, playhead);
    if (throwInfo && playhead === mat.events.length - 1
        && isCustomerLoc(throwInfo.file, throwInfo.line)) {
        return { file: throwInfo.file, line: throwInfo.line };
    }
    const prov = provenanceIndex(mat);
    const p = prov[Math.min(playhead, prov.length - 1)];
    if (p) {
        const e = mat.events[Math.min(playhead, mat.events.length - 1)];
        if (p.own && e.kind !== "FUNC_EXIT" && e.file) {
            return { file: e.file, line: e.line };
        }
        if (p.customerFrame) return { ...p.customerFrame };
    }
    if (stack.length > 0 && !mat._provHasCustomer) {
        // No bundle-owned frames anywhere (sources missing from the
        // capture): degrade to the raw top-of-stack rather than blank.
        const top = stack[stack.length - 1];
        return { file: top.file, line: top.line };
    }
    // Outside any frame: fall back to the last customer event seen.
    for (let i = Math.min(playhead, mat.events.length - 1); i >= 0; i--) {
        const e = mat.events[i];
        if (e.file && (isCustomerLoc(e.file, e.line) || !mat._provHasCustomer)) {
            return { file: e.file, line: e.line };
        }
    }
    return { file: null, line: null };
}

// "Visible scan" events — the events we show on the scrubber and as
// cards in the event stream. cursor.mjs's `scanOrdinal` counts every
// engine-side scan record (ENTER + EXIT + THROW), but FUNC_EXIT
// doesn't earn a tick or a card in the UI per the scrub-vs-step rule
// (function boundaries are walkable but not scrubber-jumpable). So we
// maintain our own derived index over (ENTER + THROW) and use it
// consistently for tick positions, the chip, the transport time, and
// the past/current/future styling on the stream.
//
// Returns { items, current }:
//   items[i] = { event, eventIdx } — i-th visible event in document order
//   current  = index in items of the most recent visible event at or
//              before `playhead` (-1 if playhead is before any
//              visible event)
// Engine frames (see provenance above) don't earn cards or ticks
// either: a digest-fold helper entering is not an event the customer
// did. THROW stays visible regardless of where it fired — a throw is
// an outcome, and hiding it because the frame was foreign would hide
// the run's ending.
function visibleScans(mat, playhead) {
    const prov = provenanceIndex(mat);
    const items = [];
    let current = -1;
    for (let i = 0; i < mat.events.length; i++) {
        const e = mat.events[i];
        if (e.kind !== "FUNC_ENTER" && e.kind !== "THROW") continue;
        if (e.kind === "FUNC_ENTER" && mat._provHasCustomer && !prov[i].own) continue;
        if (i <= playhead) current = items.length;
        items.push({ event: e, eventIdx: i });
    }
    return { items, current };
}

// ── Rendering ────────────────────────────────────────────────────────

function renderAppbar(bundle) {
    const req = bundle.request || {};
    const res = bundle.response || {};

    const tenant = (req.host || "").split(".")[0] || req.host || "—";
    const recId = bundle.recording_id || bundle.deployment_id || "—";

    $.crumb.replaceChildren(
        el("span", { text: tenant }),
        el("span", { className: "crumb__sep", text: "/" }),
        el("span", { text: "recordings" }),
        el("span", { className: "crumb__sep", text: "/" }),
        el("span", { className: "c-brand t-mono", text: String(recId).slice(0, 14) }),
    );

    $.meta.replaceChildren();
    if (res.status != null) {
        $.meta.appendChild(el("span", {
            className: "badge " + badgeKindFor(res.status),
            text: String(res.status),
        }));
    }
    if (req.method || req.path) {
        $.meta.appendChild(el("span", {
            className: "t-mono",
            text: `${req.method || "?"} ${req.path || "?"}`,
        }));
    }
    if (res.outcome) {
        $.meta.appendChild(el("span", { className: "t-mute", text: "·" }));
        $.meta.appendChild(el("span", { text: res.outcome }));
    }
}

function renderModulesRail(bundle, currentPath, onSelect) {
    const modules = bundle.modules || [];
    $.modTree.replaceChildren();
    if (modules.length === 0) {
        $.modTree.appendChild(el("li", {
            className: "t-meta t-dim",
            text: "(no modules in bundle)",
            style: { padding: "var(--sp-2) var(--sp-4)" },
        }));
        return;
    }
    for (const m of modules) {
        const li = el("li", {
            className: "mod-tree__item" + (m.path === currentPath ? " is-current" : ""),
        });
        const { dir, base } = splitPath(m.path);
        const file = el("span", { className: "mod-tree__file t-mono" });
        if (dir) file.appendChild(el("span", { className: "mod-tree__dir", text: dir }));
        file.appendChild(document.createTextNode(base));
        li.appendChild(file);
        li.appendChild(el("span", {
            className: "mod-tree__hash t-dimmer t-mono-sm",
            text: shortHash(m.source || ""),
            title: "Content fingerprint — same value means byte-identical source",
        }));
        li.addEventListener("click", () => onSelect(m.path));
        $.modTree.appendChild(li);
    }
}

function renderSourceView(bundle, modulePath, highlightLine) {
    const mod = (bundle.modules || []).find(m => m.path === modulePath);
    const src = mod?.source || "";

    const { dir, base } = splitPath(modulePath);
    $.sourceHeader.replaceChildren();
    if (dir) $.sourceHeader.appendChild(el("span", { className: "t-dim", text: dir }));
    $.sourceHeader.appendChild(el("span", { className: "c-info", text: base }));
    if (highlightLine != null) {
        $.sourceHeader.appendChild(el("span", { className: "t-dim", text: " · line" }));
        $.sourceHeader.appendChild(el("span", { className: "c-brand", text: " " + highlightLine }));
    }

    const lines = src.split("\n");
    $.sourceCode.replaceChildren();
    const gutter = el("div", { className: "code__gutter" });
    const body   = el("div", { className: "code__body" });
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        gutter.appendChild(el("span", { className: "ln", text: String(lineNo) }));
        const lineSpan = el("span", {
            className: "line" + (lineNo === highlightLine ? " is-current" : ""),
        });
        appendTokenized(lineSpan, lines[i]);
        lineSpan.appendChild(document.createTextNode("\n"));
        body.appendChild(lineSpan);
    }
    $.sourceCode.appendChild(gutter);
    $.sourceCode.appendChild(body);
}

// Event stream: render visible-scan events as cards, mark past /
// current / future based on the playhead's visible index.
function renderEventStream(mat, playhead) {
    $.stream.replaceChildren();
    if (mat.events.length === 0) {
        $.stream.appendChild(el("li", {
            className: "stream__empty t-meta t-dim",
            text: "(no events captured — handler exited at module load?)",
        }));
        return;
    }
    const { items, current } = visibleScans(mat, playhead);
    if (items.length === 0) {
        $.stream.appendChild(el("li", {
            className: "stream__empty t-meta t-dim",
            text: "(no function calls or throws — handler had no observable scan events)",
        }));
        return;
    }

    items.forEach((item, i) => {
        const e = item.event;
        const cls = i === current ? "ev--current"
                  : i <  current ? "ev--past"
                  :                "ev--future";
        const li = el("li", { className: "ev " + cls });

        const rail = el("div", { className: "ev__rail" });
        rail.appendChild(el("span", {
            className: "ev__dot " + (e.kind === "THROW" ? "c-error" : "c-info"),
            attrs: { "aria-hidden": "true" },
        }));
        if (cls === "ev--current") {
            rail.appendChild(el("span", {
                className: "ev__playhead",
                attrs: { "aria-hidden": "true" },
            }));
        }
        li.appendChild(rail);

        const body = el("div", { className: "ev__body" });
        const head = el("div", { className: "ev__head" });
        head.appendChild(el("span", {
            className: "t-mono-sm " + (e.kind === "THROW" ? "c-error" : "c-info"),
            text: e.kind === "THROW" ? "throw" : "fn enter",
        }));
        head.appendChild(el("span", {
            className: "ev__t t-mono-sm "
                + (cls === "ev--current" ? "c-brand" : "t-dimmer"),
            text: String(i + 1),
        }));
        body.appendChild(head);

        if (e.kind === "FUNC_ENTER") {
            body.appendChild(el("div", {
                className: "t-mono-sm t-dim",
                text: displayName(e.name),
            }));
            body.appendChild(el("div", {
                className: "ev__detail t-mono-sm t-dimmer",
                text: e.file + ":" + e.line,
            }));
        } else if (e.kind === "THROW") {
            body.appendChild(el("div", {
                className: "t-mono-sm c-error",
                text: e.message || "(no message)",
            }));
            body.appendChild(el("div", {
                className: "ev__detail t-mono-sm t-dimmer",
                text: e.file + ":" + e.line,
            }));
        }
        li.appendChild(body);
        $.stream.appendChild(li);
    });
}

// Scrubber rail in CUSTOMER-event space: the rail represents the
// ordered customer-owned events (frame provenance above). Raw
// event-index space is dominated by engine events — the epilogue setup
// and the digest tail are routinely 90%+ of a drill — so a rail in raw
// space compresses everything the handler did into a sliver where a
// single source line is sub-pixel and a drag can never land on it (a
// handler's `return` line is one event of hundreds). In customer space
// every line the handler executed owns a draggable region of the rail.
// Ticks stay irregularly spaced within it (clusters during tight
// loops); a record with no customer-owned events keeps raw space.
//
// The chip + transport time stay in visible-scan grain — the
// rail-position is "where am I in the handler's run," the chip is
// "which named scan event am I past."
function pctForEventIdx(mat, eventIdx) {
    const e0 = Math.max(0, Math.min(mat.events.length - 1, eventIdx));
    const own = ownEventIndex(mat);
    if (own) {
        if (own.length <= 1) return 50;
        return (mat._ownPos[e0] / (own.length - 1)) * 100;
    }
    const total = mat.events.length;
    if (total <= 1) return 50;
    return (e0 / (total - 1)) * 100;
}

function renderScrubber(mat, playhead) {
    $.scrubberTicks.replaceChildren();
    const { items, current } = visibleScans(mat, playhead);

    items.forEach(({ event: e, eventIdx }, i) => {
        const pct = pctForEventIdx(mat, eventIdx);
        const tick = el("span", {
            className: "scrubber__tick" + (e.kind === "THROW" ? " scrubber__tick--big" : ""),
            style: {
                left: pct.toFixed(3) + "%",
                background: e.kind === "THROW" ? "var(--c-error)" : "var(--c-info)",
            },
            title: `${i + 1} · ${e.kind === "THROW" ? "throw" : "fn enter " + (displayName(e.name) ?? "")}`,
        });
        $.scrubberTicks.appendChild(tick);
    });

    const pct = pctForEventIdx(mat, playhead);
    $.scrubberPlayed.style.width = pct.toFixed(3) + "%";
    $.scrubberPlayhead.style.display = "";
    $.scrubberPlayhead.style.left = pct.toFixed(3) + "%";

    const shown = current < 0 ? 0 : current;
    const n = items.length || 1;
    const chip = $.scrubberPlayhead.querySelector(".scrubber__playhead-chip");
    if (chip) chip.textContent = `${shown + 1} / ${n}`;

    $.transportTime.replaceChildren(
        el("span", { className: "c-brand", text: "event " + (shown + 1) }),
        el("span", { className: "t-dim", text: " of " + n }),
    );
}

// Stack breadcrumb at the playhead. Replaces the previous "snapshot
// at throw or end" rendering — now we know the stack at any event.
function renderStackBreadcrumb(mat, playhead) {
    const { stack, throwInfo } = stackAtPlayhead(mat, playhead);
    $.stack.replaceChildren();

    if (stack.length === 0) {
        const ev = mat.events[playhead];
        let msg;
        if (throwInfo && ev?.kind === "THROW") {
            msg = "(throw at module top-level — no frames to walk)";
        } else if (playhead >= mat.events.length - 1) {
            // Playhead is at end of run, no throw, all frames exited.
            msg = "(handler exited cleanly — mid-run frames need stepping)";
        } else {
            msg = "(outside any frame)";
        }
        $.stack.appendChild(el("span", {
            className: "t-meta t-dim",
            text: msg,
            style: { padding: "0 var(--sp-2)" },
        }));
        return;
    }

    // Collapse runs of engine frames (shims, digest helpers — code the
    // bundle doesn't carry) into one dimmed chip; the walkable crumbs
    // are the customer's frames. Mid-epilogue the whole stack can be
    // engine frames — still collapse (one honest chip beats a raw
    // ":157" into code the reader can't see). Only a record with no
    // customer frames ANYWHERE keeps its raw stack — a fully-dimmed
    // breadcrumb explains nothing there.
    provenanceIndex(mat);
    const collapse = mat._provHasCustomer;
    const shown = [];
    for (const frame of stack) {
        if (!collapse || isCustomerLoc(frame.file, frame.line)) {
            shown.push({ frame, engineCount: 0 });
        } else {
            const last = shown[shown.length - 1];
            if (last && last.engineCount > 0) last.engineCount++;
            else shown.push({ frame: null, engineCount: 1 });
        }
    }

    for (let i = 0; i < shown.length; i++) {
        const { frame, engineCount } = shown[i];
        const isLast = i === shown.length - 1;
        if (i > 0) {
            $.stack.appendChild(el("span", {
                className: "stack__chev",
                text: "›",
                attrs: { "aria-hidden": "true" },
            }));
        }
        if (engineCount > 0) {
            $.stack.appendChild(el("span", {
                className: "stack__frame stack__frame--engine t-dimmer",
                text: `engine ×${engineCount}`,
                title: `${engineCount} replay-engine frame(s) — shim/`
                    + "digest machinery, not part of the deployed bundle",
            }));
            continue;
        }
        const btn = el("button", {
            className: "stack__frame" + (isLast ? " is-current" : ""),
        });
        btn.appendChild(el("span", {
            className: "stack__frame-file t-mono-sm t-dim",
            text: frame.file,
        }));
        btn.appendChild(el("span", {
            className: "stack__frame-fn t-mono",
            text: displayName(frame.name),
        }));
        if (isLast) {
            const errOnTop = throwInfo && mat.events[playhead]?.kind === "THROW"
                && isCustomerLoc(throwInfo.file, throwInfo.line);
            btn.appendChild(el("span", {
                className: "stack__frame-line t-mono-sm" + (errOnTop ? " c-error" : ""),
                text: ":" + (errOnTop ? throwInfo.line : frame.line),
            }));
        }
        $.stack.appendChild(btn);
    }
}

function renderNextError(mat, playhead) {
    const throwsTotal = mat.events.filter(e => e.kind === "THROW").length;
    if (throwsTotal === 0) {
        $.nextErrorBtn.disabled = true;
        $.nextErrorLabel.textContent = "No throws in this recording";
        $.nextErrorBtn.title = "No throws in this recording.";
        return;
    }
    // Always enable if there are throws in the recording. The button's
    // click handler (phase B) jumps to the next throw after the
    // playhead, wrapping to the first throw if past all of them.
    $.nextErrorBtn.disabled = false;
    $.nextErrorLabel.textContent = `Next throw · ${throwsTotal}`;
    $.nextErrorBtn.title = `${throwsTotal} throw(s) in this recording (E)`;
}

function renderError(err) {
    $.meta.replaceChildren(
        el("span", { className: "badge badge--error", text: "load error" }),
        el("span", { className: "t-mono", text: err.message || String(err) }),
    );
    if ($.sourceState) $.sourceState.textContent = "failed";
}

// ── Stepping actions ─────────────────────────────────────────────────
//
// All step verbs converge on setPlayhead(); rendering is a function of
// (mat, playhead), so a single setter is enough. Granularity falls out
// of which verb the user invoked (per the scrub-vs-step memory rule).

function setPlayhead(idx) {
    if (!state.mat) return;
    const n = state.mat.events.length;
    if (n === 0) return;
    const clamped = Math.max(0, Math.min(n - 1, idx));
    if (clamped === state.playhead) return;
    state.playhead = clamped;
    renderAll();
    inspectAndRenderVars(clamped);
}

function jumpStart() { setPlayhead(0); }
function jumpEnd()   { if (state.mat) setPlayhead(state.mat.events.length - 1); }

// Single-event steppers move in customer grain: an event inside an
// engine frame is not a place the playhead rests (the source pane
// would have nothing of the customer's to show for it). Falls back to
// raw ±1 when the record has no customer-owned events at all.
function stepToward(dir) {
    if (!state.mat) return;
    const prov = provenanceIndex(state.mat);
    if (!state.mat._provHasCustomer) {
        setPlayhead(state.playhead + dir);
        return;
    }
    const n = state.mat.events.length;
    for (let i = state.playhead + dir; i >= 0 && i < n; i += dir) {
        if (prov[i].own) { setPlayhead(i); return; }
    }
}
function stepLine()  { stepToward(+1); }
function stepBack()  { stepToward(-1); }

// step-over: advance to the next event in the playhead's OWN frame,
// skipping over (descending into and emerging from) any nested
// function calls that happen in between. Stops on whichever comes
// first: the next LINE / THROW back in the original frame, or the
// FUNC_EXIT that ends the original frame.
//
// Walks events tracking a depth offset (0 at start). FUNC_ENTERs in
// between drive it positive; FUNC_EXITs bring it back. depth < 0
// signals "we just exited the original frame" — that's our stop.
// depth === 0 LINE/THROW means "back in the original frame, this is
// the next thing that happens here" — also a stop.
function stepOver() {
    if (!state.mat) return;
    const events = state.mat.events;
    const n = events.length;
    let depth = 0;
    for (let i = state.playhead + 1; i < n; i++) {
        const e = events[i];
        if (e.kind === "FUNC_ENTER") {
            depth++;
        } else if (e.kind === "FUNC_EXIT") {
            depth--;
            if (depth < 0) {
                setPlayhead(i);
                return;
            }
        } else if (depth === 0) {
            setPlayhead(i);
            return;
        }
    }
    setPlayhead(n - 1);
}

// step-in: jump to the next customer FUNC_ENTER after the playhead —
// stepping "into" a digest helper or shim is never what the verb meant.
function stepIn() {
    if (!state.mat) return;
    const events = state.mat.events;
    const prov = provenanceIndex(state.mat);
    for (let i = state.playhead + 1; i < events.length; i++) {
        if (events[i].kind === "FUNC_ENTER"
            && (!state.mat._provHasCustomer || prov[i].own)) {
            return setPlayhead(i);
        }
    }
    setPlayhead(events.length - 1);
}

// step-out: jump to the matching FUNC_EXIT of the frame containing the
// playhead. If we're not inside a frame, advance to end.
function stepOut() {
    if (!state.mat) return;
    const events = state.mat.events;
    // Walk back to find the most recent unmatched FUNC_ENTER.
    let depth = 0;
    let enterIdx = -1;
    for (let i = state.playhead; i >= 0; i--) {
        const e = events[i];
        if (e.kind === "FUNC_EXIT") depth++;
        else if (e.kind === "FUNC_ENTER") {
            if (depth === 0) { enterIdx = i; break; }
            depth--;
        }
    }
    if (enterIdx < 0) return setPlayhead(events.length - 1);
    const exitIdx = state.mat.matchingExit[enterIdx];
    if (exitIdx > 0) setPlayhead(exitIdx);
    else             setPlayhead(events.length - 1);
}

// next-error: jump to the next THROW after the playhead; wrap to the
// first throw if past all of them.
function nextError() {
    if (!state.mat) return;
    const events = state.mat.events;
    for (let i = state.playhead + 1; i < events.length; i++) {
        if (events[i].kind === "THROW") return setPlayhead(i);
    }
    for (let i = 0; i < events.length; i++) {
        if (events[i].kind === "THROW") return setPlayhead(i);
    }
}

// Forward / back pair: ◀ and ▶ are symmetric single-event steppers.
// Autoplay had its day and got retired — the model is keyframes, not
// wall-clock time, so "play at 300 ms/event" was neither obvious nor
// useful. Keyboard Space mirrors the ▶ button.

// Wire transport button clicks + a click on the scrubber track that
// snaps to the nearest scan event.
function wireTransport() {
    if (T.jumpStart) T.jumpStart.addEventListener("click", jumpStart);
    if (T.stepBack)  T.stepBack .addEventListener("click", stepBack);
    if (T.play)      T.play     .addEventListener("click", stepLine);
    if (T.stepOver)  T.stepOver .addEventListener("click", stepOver);
    if (T.stepIn)    T.stepIn   .addEventListener("click", stepIn);
    if (T.stepOut)   T.stepOut  .addEventListener("click", stepOut);
    if (T.stepLine)  T.stepLine .addEventListener("click", stepLine);
    if (T.jumpEnd)   T.jumpEnd  .addEventListener("click", jumpEnd);
    if ($.nextErrorBtn) $.nextErrorBtn.addEventListener("click", nextError);

    // Scrubber drag — mousedown anywhere on the rail, drag continuously
    // through event-index space. Each pixel maps to an event index,
    // not a visible-scan tick. The variables drawer + source viewport
    // follow live; the playhead chip text (visible-scan grain) ticks
    // only when crossing a tick.
    if ($scrubber) {
        let dragging = false;

        // Drag maps pixels through the same customer-event space the
        // rail is drawn in (pctForEventIdx) — each customer event owns
        // an equal slice, so every executed line is reachable by drag.
        const eventIdxAt = (clientX) => {
            const rect = $scrubber.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const own = ownEventIndex(state.mat);
            if (own && own.length > 0) {
                return own[Math.round(frac * (own.length - 1))];
            }
            const total = state.mat.events.length;
            if (total <= 1) return 0;
            return Math.round(frac * (total - 1));
        };

        $scrubber.addEventListener("mousedown", (ev) => {
            if (!state.mat) return;
            dragging = true;
            ev.preventDefault();
            setPlayhead(eventIdxAt(ev.clientX));
        });
        window.addEventListener("mousemove", (ev) => {
            if (!dragging || !state.mat) return;
            setPlayhead(eventIdxAt(ev.clientX));
        });
        window.addEventListener("mouseup", () => { dragging = false; });
    }

    // Keyboard. Skip when typing in inputs.
    window.addEventListener("keydown", (ev) => {
        const tag = ev.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (ev.metaKey || ev.ctrlKey) return;
        switch (ev.key) {
            case " ":          ev.preventDefault(); stepLine();  break;
            case "ArrowRight": ev.preventDefault(); stepLine();  break;
            case "ArrowLeft":  ev.preventDefault(); stepBack();  break;
            case "Home":       ev.preventDefault(); jumpStart(); break;
            case "End":        ev.preventDefault(); jumpEnd();   break;
            case "F10":        ev.preventDefault(); stepOver();  break;
            case "F11":        ev.preventDefault();
                                ev.shiftKey ? stepOut() : stepIn();
                                break;
            case "b": case "B": stepBack(); break;
            case "e": case "E": nextError(); break;
        }
    });
}

// Enable / disable transport based on whether the playhead can go
// further in each direction. Called from renderAll().
function renderTransport(mat, playhead) {
    const last = mat.events.length - 1;
    const atStart = playhead <= 0;
    const atEnd   = playhead >= last;
    if (T.jumpStart) T.jumpStart.disabled = atStart;
    if (T.stepBack)  T.stepBack .disabled = atStart;
    if (T.play)      T.play     .disabled = mat.events.length === 0;
    if (T.stepOver)  T.stepOver .disabled = atEnd;
    if (T.stepIn)    T.stepIn   .disabled = atEnd;
    if (T.stepOut)   T.stepOut  .disabled = atEnd;
    if (T.stepLine)  T.stepLine .disabled = atEnd;
    if (T.jumpEnd)   T.jumpEnd  .disabled = atEnd;
}

// ── Variables drawer ─────────────────────────────────────────────────
//
// engine.inspectAt(mat, playhead, { cluster: 0 }) re-runs the replay
// bounded to one event and snapshots the live stack via the v0.1.0
// `_arena_host_state` reactor. Result shape per frame:
//
//   [{ func, file, line, vars: { name: <json>, ... } }, ...]
//
// Top-of-stack last. We render the deepest frame's vars by default —
// that's the "where am I" inspection the user almost always wants.
// Switching to ancestor frames via the stack-breadcrumb buttons is a
// follow-up.

const $vars         = document.querySelector(".vars");
const $varsBody     = document.querySelector(".vars__body");
const $bottomResize = document.querySelector(".bottom-resize");
let inspectSeq = 0;  // serialise rapid stepping; drop stale results

// ── Bottom-region resize ─────────────────────────────────────────────
//
// The .bottom-resize handle sits in its own row of the page grid,
// just above the transport bar. Dragging it adjusts the
// .vars__body height — the transport is fixed and rides along, the
// 1fr main grid absorbs the change. Height persists in localStorage
// so the preference sticks across reloads.

const VARS_HEIGHT_STORAGE_KEY = "rewind.replay.varsHeight";
const VARS_MIN_HEIGHT = 80;
function varsMaxHeight() { return Math.floor(window.innerHeight * 0.7); }

function setVarsHeight(px, { persist = true } = {}) {
    if (!$varsBody) return;
    const clamped = Math.max(VARS_MIN_HEIGHT, Math.min(varsMaxHeight(), Math.round(px)));
    $varsBody.style.height = clamped + "px";
    if (persist) {
        try { localStorage.setItem(VARS_HEIGHT_STORAGE_KEY, String(clamped)); }
        catch { /* private mode etc — fine */ }
    }
}

// Restore saved height on load.
try {
    const saved = parseInt(localStorage.getItem(VARS_HEIGHT_STORAGE_KEY) ?? "", 10);
    if (!Number.isNaN(saved) && saved >= VARS_MIN_HEIGHT) {
        setVarsHeight(saved, { persist: false });
    }
} catch { /* localStorage blocked — keep CSS default */ }

// Restore + persist the drawer's open/closed state. HTML default is
// open; the toggle event fires whenever the user clicks the summary
// to open or close.
const VARS_OPEN_STORAGE_KEY = "rewind.replay.varsOpen";
try {
    const saved = localStorage.getItem(VARS_OPEN_STORAGE_KEY);
    if (saved === "0") $vars.open = false;
    else if (saved === "1") $vars.open = true;
    // null/undefined → leave HTML default (open)
} catch { /* localStorage blocked — keep HTML default */ }
if ($vars) {
    $vars.addEventListener("toggle", () => {
        try { localStorage.setItem(VARS_OPEN_STORAGE_KEY, $vars.open ? "1" : "0"); }
        catch { /* fine */ }
    });
}

if ($bottomResize) {
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    $bottomResize.addEventListener("mousedown", (e) => {
        dragging = true;
        startY = e.clientY;
        startHeight = $varsBody.getBoundingClientRect().height;
        $bottomResize.classList.add("is-dragging");
        e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        // Drag UP (clientY decreases) grows the bottom region.
        setVarsHeight(startHeight + (startY - e.clientY));
    });
    window.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        $bottomResize.classList.remove("is-dragging");
    });
}

// ── Modules / events column width resizes ──────────────────────────
//
// Two horizontal handles flanking the source viewport. Both drive a
// CSS custom property on .replay__main so the grid columns respond
// instantly. Persisted under rewind.replay.{modulesWidth,eventsWidth}.

const $replayMain    = document.querySelector(".replay__main");
const $modulesResize = document.querySelector(".modules-resize");
const $eventsResize  = document.querySelector(".events-resize");

function clampColWidth(px, min, max) {
    return Math.max(min, Math.min(max, Math.round(px)));
}

// `cfg` describes one resizable column. `direction` is "right" for
// columns that grow when the mouse drags RIGHT (modules rail, on the
// left of the source), or "left" for columns that grow when the
// mouse drags LEFT (events stream, on the right of the source).
function wireColResize({
    handle,
    measureEl,            // DOM element whose current width is the start
    cssVar,               // custom property name on .replay__main
    storageKey,
    min,
    maxFrac,              // fraction of window.innerWidth
    direction,            // "right" | "left"
}) {
    if (!handle || !$replayMain || !measureEl) return;

    const apply = (px, { persist = true } = {}) => {
        const max = Math.floor(window.innerWidth * maxFrac);
        const clamped = clampColWidth(px, min, max);
        $replayMain.style.setProperty(cssVar, clamped + "px");
        if (persist) {
            try { localStorage.setItem(storageKey, String(clamped)); }
            catch { /* fine */ }
        }
    };

    try {
        const saved = parseInt(localStorage.getItem(storageKey) ?? "", 10);
        if (!Number.isNaN(saved) && saved >= min) apply(saved, { persist: false });
    } catch { /* fine */ }

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener("mousedown", (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = measureEl.getBoundingClientRect().width;
        handle.classList.add("is-dragging");
        e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const delta = direction === "right" ? (e.clientX - startX) : (startX - e.clientX);
        apply(startWidth + delta);
    });
    window.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("is-dragging");
    });
}

wireColResize({
    handle:    $modulesResize,
    measureEl: document.querySelector(".replay__modules"),
    cssVar:    "--modules-width",
    storageKey: "rewind.replay.modulesWidth",
    min:       140,
    maxFrac:   0.4,
    direction: "right",
});
wireColResize({
    handle:    $eventsResize,
    measureEl: document.querySelector(".stream"),
    cssVar:    "--events-width",
    storageKey: "rewind.replay.eventsWidth",
    min:       200,
    maxFrac:   0.6,
    direction: "left",
});

// Find the nearest varSnapshot at or before `eventIdx`. Binary search
// since varSnapshots is sorted by eventOrdinal.
function nearestVarSnapshot(mat, eventIdx) {
    const snaps = mat.varSnapshots;
    if (!snaps || snaps.length === 0) return null;
    let lo = 0, hi = snaps.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (snaps[mid].eventOrdinal <= eventIdx) lo = mid + 1;
        else hi = mid;
    }
    return lo > 0 ? snaps[lo - 1] : null;
}

async function inspectAndRenderVars(eventOrdinal) {
    if (!state.engine || !state.mat) return;
    const ev = state.mat.events[eventOrdinal];
    // No frame is alive at the trailing FUNC_EXIT. Show an empty-state
    // and skip the engine round-trip.
    if (!ev || (ev.kind === "FUNC_EXIT" && eventOrdinal === state.mat.events.length - 1)) {
        renderVariablesEmpty("(no frame alive)");
        return;
    }

    const seq = ++inspectSeq;

    // Layer 1: exact hit in the inspectCache (a previous inspectAt
    // landed on this event). O(1), no round-trip, exact values.
    const cached = state.mat.inspectCache.get(eventOrdinal);
    if (cached && cached.frames && cached.frames.length > 0) {
        renderVariablesFrames(cached.frames);
        return;
    }

    // Layer 2: nearest varSnapshot from materialise's pre-computed
    // pass — painted instantly for scrub feedback, but treated as an
    // APPROXIMATION only. The coarse pass snapshots at every event, and
    // `arena_snapshot_here` isn't reliable at that density (it can miss
    // the deep call frames — e.g. at a throw inside a nested call it
    // captures only the outer epilogue frame), so we never trust it as
    // the final answer: Layer 3's windowed `inspectAt` always refines
    // the settled playhead below. (During a fast drag the seq guard
    // drops stale refinements, so the coarse paint is what the user
    // sees mid-drag; the exact frames land when the playhead settles.)
    const snap = nearestVarSnapshot(state.mat, eventOrdinal);
    if (snap && snap.frames && snap.frames.length > 0) {
        renderVariablesFrames(snap.frames);
    } else {
        renderVariablesLoading();
    }

    // Layer 3: engine round-trip for the exact answer. Fires async;
    // result replaces the snapshot render when it lands. Stale calls
    // (newer step fired) drop via the seq counter.
    let snapshots;
    try {
        snapshots = await state.engine.inspectAt(state.mat, eventOrdinal, { cluster: 0 });
    } catch (err) {
        if (seq !== inspectSeq) return;
        if (!snap) renderVariablesEmpty("(inspect failed: " + (err.message || err) + ")");
        return;
    }
    if (seq !== inspectSeq) return;
    const exact = snapshots.find(s => s.eventOrdinal === eventOrdinal) || snapshots[0];
    if (exact && exact.frames && exact.frames.length > 0) {
        renderVariablesFrames(exact.frames);
    } else if (!snap) {
        renderVariablesEmpty("(no frames)");
    }
}

function renderVariablesLoading() {
    $varsBody.replaceChildren(el("div", {
        className: "t-meta t-dim",
        text: "loading…",
    }));
}

function renderVariablesEmpty(msg) {
    $varsBody.replaceChildren(el("div", {
        className: "t-meta t-dim",
        text: msg,
    }));
}

// Render one frame's vars as a kv block. The snapshot's `frames`
// array runs top-of-stack first (deepest frame at index 0, root
// caller at the end) — that's the order qjs-arena-trace.c walks
// via top_frame() + prev_frame(). The deepest frame is the
// "current" frame the user is inspecting.
function renderVariablesFrames(frames) {
    // Engine frames (shims, the digest machinery) carry locals like
    // __foldEffect / __effectLog — the shell's plumbing, not the
    // handler's state. Show the innermost CUSTOMER frame; fall back to
    // the raw top only when no frame is customer code at all.
    let topIdx = frames.findIndex(f => isCustomerLoc(f.file, f.line));
    if (topIdx < 0 && state.mat?._provHasCustomer) {
        // Every live frame is the engine's (the epilogue wind-down at
        // the run's tail). Plumbing locals would masquerade as handler
        // state — say where we are instead.
        renderVariablesEmpty("(engine wind-down — step back to reach handler frames)");
        return;
    }
    const skipped = topIdx < 0 ? 0 : topIdx;
    if (topIdx < 0) topIdx = 0;
    const top = frames[topIdx];
    $varsBody.replaceChildren();

    const section = el("div", { className: "vars__section" });
    section.appendChild(el("span", {
        className: "t-eyebrow vars__section-title",
        text: (displayName(top.func) || "<frame>") + " · " + (top.file || "?") + ":" + (top.line || "?"),
    }));
    if (skipped > 0) {
        section.appendChild(el("span", {
            className: "t-meta t-dimmer",
            text: ` (inside ${skipped} engine frame${skipped === 1 ? "" : "s"})`,
        }));
    }
    const kv = el("div", { className: "kv" });
    const vars = top.vars || {};
    const names = Object.keys(vars);
    if (names.length === 0) {
        kv.appendChild(el("span", {
            className: "t-meta t-dim",
            text: "(no locals at this point)",
            style: { gridColumn: "1 / -1" },
        }));
    } else {
        for (const name of names) {
            kv.appendChild(el("span", { className: "kv__k", text: name }));
            kv.appendChild(el("span", {
                className: "kv__v " + varValueClass(vars[name]),
                text: formatValue(vars[name]),
            }));
        }
    }
    section.appendChild(kv);
    $varsBody.appendChild(section);

    // If there are deeper frames, append a hint row pointing at the
    // stack breadcrumb. Switching which frame's vars are shown
    // (clicking a non-current breadcrumb frame) is a follow-up.
    const ancestors = frames.length - topIdx - 1;
    if (ancestors > 0) {
        $varsBody.appendChild(el("div", {
            className: "t-meta t-dim",
            text: `(${ancestors} ancestor frame${ancestors === 1 ? "" : "s"} above — click in the stack breadcrumb to inspect them, coming next)`,
            style: { marginTop: "var(--sp-4)" },
        }));
    }
}

// Classify a JSON-decoded var value for color hinting. The snapshot
// JSON uses bracketed-string placeholders for non-serialisable values
// (`[undefined]`, `[uninitialized]`, `[function]`, …). Plain strings
// from the source render as c-read, numbers as c-write — matches the
// design system's semantic color cues.
function varValueClass(v) {
    if (v === null) return "t-dim";
    const t = typeof v;
    if (t === "string") {
        if (v.startsWith("[") && v.endsWith("]")) return "t-dimmer";
        return "c-read";
    }
    if (t === "number" || t === "bigint" || t === "boolean") return "c-write";
    return "";
}

function formatValue(v) {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "string") return v;  // includes the [placeholder] forms
    if (t === "number" || t === "boolean") return String(v);
    if (t === "object") {
        if (Array.isArray(v)) return `Array(${v.length})`;
        return "Object";
    }
    return String(v);
}

// ── App state + entry ────────────────────────────────────────────────

const state = {
    bundle: null,
    mat: null,
    engine: null,
    playhead: 0,
    currentModule: null,
    // Provenance authority (see isCustomerLoc): a trace event is
    // customer code iff its file is a bundle module AND its line is
    // inside that module's shipped source — the appended epilogue runs
    // under the entry module's filename at lines past its end.
    modulePaths: null,
    moduleLineCounts: null,
};

function renderAll() {
    if (!state.mat) return;
    const src = currentSourceForPlayhead(state.mat, state.playhead);
    // Auto-follow source: when the playhead lands in a module other
    // than the one the user is browsing, switch to it. Click in the
    // modules rail to break auto-follow for the current module (we
    // re-follow on the next step that lands in a different file).
    if (src.file && src.file !== state.currentModule) {
        state.currentModule = src.file;
        renderModulesRail(state.bundle, state.currentModule, selectModule);
    }
    renderSourceView(state.bundle, state.currentModule, src.line);
    renderStackBreadcrumb(state.mat, state.playhead);
    renderEventStream(state.mat, state.playhead);
    renderScrubber(state.mat, state.playhead);
    renderNextError(state.mat, state.playhead);
    renderTransport(state.mat, state.playhead);
}

function selectModule(path) {
    state.currentModule = path;
    renderModulesRail(state.bundle, state.currentModule, selectModule);
    // Don't reach into the playhead's line when the user is browsing
    // a non-current module; show the file without a line highlight.
    const src = currentSourceForPlayhead(state.mat || { events: [] }, state.playhead);
    const lineForView = (path === src.file) ? src.line : null;
    renderSourceView(state.bundle, path, lineForView);
}

// Compare the re-executed outcome against the recorded one. The verdict
// is what makes a replay trustworthy: a timeline that renders beautifully
// while ending on a different status than production is worse than no
// replay, because it looks authoritative.
//
// `verdict`:
//   "match"      — re-ran and produced the capture's status
//   "mismatch"   — re-ran and produced a DIFFERENT status (the capture is
//                  fine; the replay's inputs or environment are not)
//   "incomplete" — the run never reached the end (threw, or was stopped),
//                  so there is nothing to compare
//   "unknown"    — the capture carries no status to compare against
function readFidelity(bundle, mat) {
    const capturedStatus = bundle.response?.status ?? null;
    const threw = (mat.events || []).some(e => e.kind === "THROW");
    // Harvested by the engine at the end of its one complete pass — the
    // overlay itself is reset by every later pass (cursor.mjs).
    const replayed = mat.outcome ?? null;

    let verdict;
    if (replayed == null) verdict = "incomplete";
    else if (capturedStatus == null) verdict = "unknown";
    else verdict = Number(replayed.status) === Number(capturedStatus) ? "match" : "mismatch";

    // The interaction digest is the stronger claim: the status says the run
    // ENDED the same, the digest says it DID the same — same reads served,
    // same writes and effects emitted, in the same order.
    //
    // `unverified` is a first-class outcome, not a pass. A record captured
    // before the worker computed digests carries none, and treating that as
    // agreement would report confidence about every historical record that
    // nothing has actually checked.
    const capturedDigest = bundle.interaction_digest ?? null;
    const replayedDigest = replayed?.digest ?? null;
    let digestVerdict;
    if (!capturedDigest) digestVerdict = "unverified";        // capture predates digests
    else if (!replayedDigest) digestVerdict = "unverified";   // run did not finish
    else digestVerdict = capturedDigest === replayedDigest ? "match" : "mismatch";

    return {
        verdict,
        threw,
        capturedStatus,
        replayedStatus: replayed ? replayed.status : null,
        replayedResult: replayed ? replayed.result : null,
        digestVerdict,
        capturedDigest,
        replayedDigest,
        // How the run ended. An "incomplete" verdict is only actionable
        // with this: rc 0 means the handler simply never reached the end,
        // a nonzero rc without a throw means the engine cut it short, and
        // `oom` names the commonest such cut (an exhausted request arena
        // emits no throw event, so the timeline looks complete).
        run: mat.runStatus ?? null,
    };
}

function renderFidelity(f) {
    if (!f || !$.meta) return;
    // Only speak up when the replay is NOT a clean reproduction — a
    // matching run needs no badge, the existing status already says it.
    // A digest mismatch is worth saying even when the status matched — that is
    // exactly the case a status check cannot see.
    if (f.verdict === "match" && f.digestVerdict !== "mismatch") return;
    const label = f.digestVerdict === "mismatch" && f.verdict === "match"
        ? "same response, different behaviour (digest)"
        :
        f.verdict === "mismatch" ? `replayed ${f.replayedStatus} ≠ captured ${f.capturedStatus}` :
        f.verdict === "incomplete" ? (
            f.run?.oom ? `did not complete — arena exhausted (${f.run.oomUsed}/${f.run.oomLimit} bytes)` :
            f.threw ? "did not complete (threw)" :
            f.run?.rc ? `did not complete (engine rc=${f.run.rc})` :
            "did not complete") :
        "no captured status to compare";
    $.meta.appendChild(el("span", { className: "t-mute", text: "·" }));
    // Deliberately NOT `badge--error`: that class is the shell's
    // load-failure signal (and the captured 5xx status badge), and a
    // divergent replay is a different fact from a shell that failed to
    // load. `#fidelity[data-verdict]` is the stable hook for both a
    // reader and the e2e fidelity gate.
    $.meta.appendChild(el("span", {
        className: "badge " + (f.verdict === "mismatch" ? "badge--diverged" : "badge--warn"),
        text: label,
        title: "the replay did not reproduce the recorded response",
        attrs: { id: "fidelity", "data-verdict": f.verdict },
    }));
}

async function main() {
    let bundle;
    try {
        bundle = await awaitBundle();
    } catch (err) {
        renderError(err);
        return;
    }
    state.bundle = bundle;
    state.modulePaths = new Set((bundle.modules || []).map(m => m.path));
    state.moduleLineCounts = new Map((bundle.modules || []).map(
        m => [m.path, (m.source || "").split("\n").length]));

    renderAppbar(bundle);

    let entryPath;
    try {
        entryPath = resolveEntry(bundle);
    } catch (err) {
        renderError(err);
        return;
    }
    state.currentModule = entryPath;
    renderModulesRail(bundle, state.currentModule, selectModule);
    renderSourceView(bundle, state.currentModule, null);

    $.sourceState.textContent = "booting WASM…";

    let Module;
    try {
        Module = await getArenaJs();
    } catch (err) {
        renderError(new Error("WASM load failed: " + err.message));
        return;
    }

    const arena_init_open = Module.cwrap("arena_init_open", "number", ["number","number"]);
    const arena_eval_base = Module.cwrap("arena_eval_base", "number", ["string"]);
    const arena_freeze    = Module.cwrap("arena_freeze",    null,     []);
    const arena_destroy   = Module.cwrap("arena_destroy",   null,     []);

    // Engine-shim prelude: the pure compute globals prod compiles into the
    // worker (URLSearchParams / TextEncoder / atob / base64url / time).
    // `arena-prelude.js` is GENERATED from the engine's own shim sources
    // (rove scripts/ops/gen_replay_prelude.py, the replay tenant's manifest
    // `generate` hook) and evaled into the OPEN arena base — pre-freeze,
    // before any run, outside every drill trace — so a replayed handler
    // sees the same compute surface the live run had. Fail LOUD on a
    // missing or broken prelude: a bare arena replays a faithful capture
    // with a spurious THROW (rove#227).
    let preludeSrc;
    try {
        const resp = await fetch(new URL("arena-prelude.js", import.meta.url));
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        preludeSrc = await resp.text();
    } catch (err) {
        renderError(new Error("arena-prelude.js fetch failed: " + err.message));
        return;
    }

    if (arena_init_open(8192, 8192) !== 0) {
        renderError(new Error("arena_init_open failed"));
        return;
    }
    if (arena_eval_base(preludeSrc) !== 0) {
        renderError(new Error("arena_eval_base(prelude) failed — see the browser console for the engine's exception dump"));
        arena_destroy();
        return;
    }
    arena_freeze();

    let tapes;
    try {
        tapes = buildTapesFromBlobs(bundle.tape_blobs || {});
    } catch (err) {
        renderError(new Error("tape parse failed: " + err.message));
        arena_destroy();
        return;
    }

    // Diagnostic hook (like __mat_varSnapshots_count__): the decoded tapes,
    // so a divergence can be read against what was actually recorded
    // without rebuilding the shell.
    window.__replay_tapes__ = tapes;

    const moduleSources = rewriteImportSpecifiers(buildModuleSources(bundle), bundle);
    const middlewarePath = resolveMiddleware(moduleSources, bundle.activation || "inbound");
    const entrySrc = moduleSources[entryPath];
    if (!entrySrc) {
        renderError(new Error("entry source not in bundle: " + entryPath));
        arena_destroy();
        return;
    }

    // Read-taping: rebuild `request` from the recorded reads and
    // invoke the activation's export — appended, so the original
    // source's line numbers stay intact for the trace timeline.
    // Before this the shell only evaluated the module body and never
    // called the handler at all.
    // Rebuild the non-inbound surface from the tapes before the epilogue
    // is built: a callback activation's body is its RESULT's bytes, not
    // the inbound request body (rove#230).
    const surface = deriveActivationSurface({
        activation: bundle.activation,
        tapes,
        activationBytes: bundle.activation_bytes ?? null,
    });

    // Diagnostic hook, like __replay_tapes__: what the tapes yielded for
    // the non-inbound surface.
    window.__replay_surface__ = surface;
    window.__replay_bundle_activation__ = bundle.activation;
    // Diagnostic hook: the composed bundle itself, so a "nothing to
    // replay" failure can be read as composition-vs-shell without a
    // rebuild (rove#249 surface S4).
    window.__replay_bundle__ = bundle;

    const epilogue = buildRequestEpilogue({
        record: bundle.request || {},
        requestReads: tapes.request_reads,
        // Outcome-replay (rove#516): the capture's guard refusals ride the
        // kv tape (outcome=refused, value=code); the wrapper throws them
        // verbatim and decides nothing itself.
        kvRefusals: tapes.kv,
        bodyBytes: surface.bodyBytes ?? bundle.request?.body_bytes ?? null,
        ctx: surface.ctx,
        activationBag: surface.activation,
        result: surface.result,
        // Prefer the export the run ACTUALLY dispatched to, recorded on
        // the log record (`bundle.entry_fn`, from record.tapes.export —
        // the `{to}` override / onFetchResult|Chunk|Done). Fall back to
        // deriving it from the activation kind when the record didn't
        // carry one (a plain inbound `default`, or a pre-export capture).
        exportName: bundle.entry_fn || exportForActivation(bundle.activation),
        binaryBody: bundle.activation === "inbound_chunk" || bundle.activation === "fetch_chunk",
        // Gates the per-run recorder state (blob.receive is onHeaders-only).
        activation: bundle.activation || "inbound",
        // The tenant's `_middlewares`, when this activation crosses the
        // trust boundary. Production loads it before the handler, so its
        // module-tape entries come first — a replay that skips it diverges
        // on its very first import, never mind losing the gate's effect.
        middlewarePath,
        tenant: bundle.tenant_id ?? null,
        sagaId: bundle.saga_id ?? null,
    });
    const entrySrcWithEpilogue = entrySrc + epilogue;

    // Surface engine output in case the handler prints / errors.
    const captured = [];
    const origPrint = Module.print, origErr = Module.printErr;
    Module.print    = (s) => { captured.push(s); origPrint?.(s); };
    Module.printErr = (s) => { captured.push("[stderr] " + s); origErr?.(s); };

    $.sourceState.textContent = "running…";
    state.engine = new CursorEngine(Module);

    // Pick varSnapshot density to roughly match the scrubber's pixel
    // width, so drag-scrubbing has near-snapshot-per-pixel resolution
    // and the variables drawer can render instantly from
    // mat.varSnapshots without an inspectAt round-trip mid-drag. Cap
    // at 800 to bound the pathological deep-stack × many-events case;
    // small recordings end up with one snapshot per event (cheap).
    const railWidth = Math.max(200, Math.floor($scrubber?.getBoundingClientRect().width ?? 800));
    const targetSnapshots = Math.min(railWidth, 800);

    // §9 seed-not-draws + fold-in: the bundle carries two
    // per-request scalars — `seed` (u64) and `timestamp_ns` (i64).
    // `CursorEngine._installReplay` calls
    // `arena_set_random_seed(lo, hi)` + `arena_set_date_now(lo,
    // hi)` so `Math.random` / `crypto.*` / `Date.now()` /
    // `new Date()` reproduce the original request's sequences.
    const seed = bundle.seed != null ? BigInt(bundle.seed) : 0n;
    const timestamp_ns = bundle.timestamp_ns != null ? BigInt(bundle.timestamp_ns) : 0n;

    // The JS engine version that produced the captured request
    // (format-versioning-audit.md §4). Today there is exactly one engine, so
    // the bundled WASM always matches and selection is a no-op — we only read
    // it to surface a clear error if a future capture demands an engine this
    // build doesn't ship. When we publish per-version engines (Phase 3), this
    // is where the driver fetches `qjs_wasm_{version}.wasm` instead.
    // The engine word's high bit (0x8000) = the request completed under
    // the GC arena regime (rove qjs/version.zig ENGINE_ARENA_GC_BIT);
    // bits 0-14 are the engine version proper.
    const engineWord = bundle.js_engine_version ?? 0;
    const captureEngine = engineWord & 0x7fff;
    const captureArenaGc = (engineWord & 0x8000) !== 0;
    if (captureEngine !== 0 && captureEngine !== REPLAY_ENGINE_VERSION) {
        renderError(new Error(
            `this capture ran on JS engine v${captureEngine}, but this replayer ` +
            `bundles engine v${REPLAY_ENGINE_VERSION}; per-version engine fetch ` +
            `is not shipped yet (format-versioning-audit.md §4 Phase 3)`));
        return;
    }
    // captureArenaGc (the engine word's high bit) is honored per run by
    // CursorEngine._installReplay via arena_set_request_mode — the
    // engine artifact ships the export (arenajs >= 0.3.2).

    let mat;
    try {
        mat = await state.engine.materialise(
            { entry: { name: entryPath, src: entrySrcWithEpilogue }, tapes, module_sources: moduleSources, seed, timestamp_ns, js_engine_version: engineWord, outputKey: REPLAY_OUTPUT_KEY },
            { targetSnapshots },
        );
    } catch (err) {
        renderError(new Error("materialise failed: " + err.message));
        arena_destroy();
        return;
    }

    state.mat = mat;
    // Diagnostic hook for the playwright smoke (and anyone poking
    // around in DevTools): the smoke can assert that varSnapshots
    // was actually populated by materialise() without us having to
    // expose `state.mat` itself on window.
    window.__mat_varSnapshots_count__ = mat.varSnapshots ? mat.varSnapshots.length : 0;

    // Fidelity: did re-running the handler reproduce what the capture
    // recorded? Read the epilogue's outcome off the kv overlay NOW —
    // every later engine call (inspectAt) re-runs the module and resets
    // the overlay, and a stopped run leaves no outcome at all.
    state.fidelity = readFidelity(bundle, mat);
    window.__replay_fidelity__ = state.fidelity;

    // Park the playhead at the throw if there is one, else at the
    // end. The user can step / scrub from anywhere.
    const throwIdx = mat.events.findIndex(e => e.kind === "THROW");
    state.playhead = throwIdx >= 0 ? throwIdx : Math.max(0, mat.events.length - 1);
    wireTransport();
    renderAll();
    renderFidelity(state.fidelity);
    inspectAndRenderVars(state.playhead);

    $.sourceState.textContent = `completed · ${mat.events.length} event(s)`;
}

main();
