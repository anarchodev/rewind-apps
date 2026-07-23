// registry — the @rewind package registry app (rewind-apps issue #1, P-Reg).
//
// A NORMAL operator tenant (like auth/docs — no `platform.*`). It is the
// store-of-record for package source + a version index, and it serves the
// publish / resolve / discovery HTTP API the customer `rewind` CLI (P-CLI,
// rove-side) drives. A package is NOT a tenant: it has no host and answers no
// requests — it is an index row + content-addressed source blobs here, whose
// bytecode is baked into each *consumer's* deployment at deploy time.
//
// Scope of this slice (R0): drives the already-shipped "B" per-tenant deploy
// path — the registry stores + resolves SOURCE and never compiles. Package
// bytecode is compiled server-side at the consumer's deploy (rove's
// /v1/deploy/pkgfile → platform.compile, admin-only), so the registry needs
// no admin privilege and no rove changes. The A-cutover (publish-time compile
// into the shared __packages__ store) and the genesis seed are later phases.
//
// This file is intentionally ONE self-contained module (like admin/index.mjs)
// — the offline `rewind test` harness can't resolve module imports yet
// (rove#19(c)). The pure cores below (pkg-hash / gates / resolve) are written
// side-effect-free and clearly bannered so that once rove#19 lands they lift
// out verbatim into pkg_hash.mjs / gates.mjs / resolve.mjs with export/import
// and gain direct unit tests. Keep them pure — the impure shell (kv, auth,
// response) is only the router + storage section at the bottom.
//
// ── kv layout (this tenant's own home store) ────────────────────────────
//   pkg/src/{source_hash}        raw source bytes (content-addressed, deduped)
//   pkg/ver/{spec}/{version}     immutable version record (JSON, see makeRecord)
//   pkg/hash/{pkg_hash}          same record, keyed by content identity (resolve)
//   pkg/idx/{spec}               JSON [{version, pkg_hash}, ...] (discovery + resolve)
// The `spec` (`@rewind/jwt`) contains a '/', which kv keys allow (rove 6513ce0).

// ════════════════════════════════════════════════════════════════════════
// ==== pkg_hash.mjs (pure) — the canonical package content identity (D2) ====
// PERMANENT cross-publisher wire contract: independent implementations MUST
// agree byte-for-byte. Encoding = RFC-8785-style canonical JSON (sorted keys,
// minified) over SOURCE hashes (never bytecode — identity must be
// engine-version-independent) plus the frozen dep `imports` (encapsulation).
// The engine treats pkg_hash as opaque (rove manifest_json.zig only requires
// 64 lowercase hex); this formula is ours to own.
// ════════════════════════════════════════════════════════════════════════

// Canonical JSON: object keys sorted, no whitespace, standard JSON string
// escaping. Inputs here are only strings/arrays/objects.
function canonJSON(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "[" + v.map(canonJSON).join(",") + "]";
    if (typeof v === "object") {
        return "{" + Object.keys(v).sort().map(
            (k) => JSON.stringify(k) + ":" + canonJSON(v[k])
        ).join(",") + "}";
    }
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

// pkg_hash = sha256(canonical-JSON({spec, version, files, imports})) → 64 hex.
//   files:   [{path, source_hash}]   sorted by path
//   imports: [[specifier, dep_pkg_hash]]   sorted by specifier
function computePkgHash(spec, version, files, imports) {
    const sortedFiles = files.slice()
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((f) => ({ path: f.path, source_hash: f.source_hash }));
    const importPairs = Object.keys(imports || {}).sort()
        .map((k) => [k, imports[k]]);
    return crypto.sha256(canonJSON({
        spec: spec, version: version, files: sortedFiles, imports: importPairs,
    }));
}

// ════════════════════════════════════════════════════════════════════════
// ==== gates.mjs (pure) — publish-time gates + capability extraction ====
// Mirrors the engine's deploy-time gates so the registry rejects at publish
// what rove would reject at deploy (fail early, clear error).
// ════════════════════════════════════════════════════════════════════════

function isIdentChar(c) {
    return c >= "a" && c <= "z" || c >= "A" && c <= "Z"
        || c >= "0" && c <= "9" || c === "_" || c === "$";
}

// Whole-identifier search. `rightBoundary` false ⇒ prefix match (the trailing
// char may be an ident char). Left boundary is always required.
function findsIdent(src, needle, rightBoundary) {
    let i = 0;
    for (;;) {
        const idx = src.indexOf(needle, i);
        if (idx < 0) return false;
        const before = idx === 0 ? "" : src[idx - 1];
        const after = src[idx + needle.length] || "";
        const leftOk = before === "" || !isIdentChar(before);
        const rightOk = !rightBoundary || after === "" || !isIdentChar(after);
        if (leftOk && rightOk) return true;
        i = idx + 1;
    }
}

// The static privileged-surface reject — mirror of rove's
// deploy_thread.zig referencesPrivilegedSurface: `_system` as an exact
// identifier, or any identifier starting with `__rove`. A blunt lexical
// backstop (matches inside comments/strings too, deliberately); the real
// boundary is the engine natives' self-gate.
function referencesPrivilegedSurface(src) {
    return findsIdent(src, "_system", true) || findsIdent(src, "__rove", false);
}

// The capability-bearing ambient primitives a package may compose over. A
// heuristic whole-word grep (the plan's "grep of imports/free identifiers");
// the declared set is recorded per package and unioned up the dep graph.
const CAP_TOKENS = ["kv", "crypto", "webhook", "wake", "http", "blob", "after", "stream"];

function extractCapabilities(files) {
    const found = {};
    for (const f of files) {
        for (const tok of CAP_TOKENS) {
            if (!found[tok] && findsIdent(f.source, tok, true)) found[tok] = true;
        }
    }
    return Object.keys(found).sort();
}

// ════════════════════════════════════════════════════════════════════════
// ==== semver + resolve.mjs (pure) — dedup-by-default lockfile resolution ====
// Pure over an index *snapshot* (spec → [{version, pkg_hash}]) and the
// per-hash records — no kv access. The impure shell hands it snapshots.
// ════════════════════════════════════════════════════════════════════════

function parseVer(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ""));
    return m ? [+m[1], +m[2], +m[3]] : null;
}
// A possibly-partial version like "1", "1.2", "1.2.3" → [maj, min|null, pat|null].
function parseParts(s) {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(s || "").trim());
    return m ? [+m[1], m[2] == null ? null : +m[2], m[3] == null ? null : +m[3]] : null;
}
function cmpVer(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}
// Minimal semver range: `*`/`latest`/empty (any), exact `x.y.z`, `^`
// (compatible-within-leftmost-non-zero), `~` (patch-level), and bare x-ranges
// (`1`, `1.2`). Ranges may be partial (`^1.9`, `~1.2`). Computes a
// [lower, upper) window and tests containment. No prerelease/OR/comparators.
function satisfies(version, range) {
    const v = parseVer(version);
    if (!v) return false;
    range = String(range || "").trim();
    if (range === "" || range === "*" || range === "x" || range === "latest") return true;
    let op = "";
    let body = range;
    if (range[0] === "^" || range[0] === "~") { op = range[0]; body = range.slice(1); }
    const p = parseParts(body);
    if (!p) return false;
    const maj = p[0], min = p[1], pat = p[2];
    const lower = [maj, min || 0, pat || 0];
    if (cmpVer(v, lower) < 0) return false;
    let upper;
    if (op === "^") {
        if (maj > 0) upper = [maj + 1, 0, 0];
        else if ((min || 0) > 0) upper = [0, min + 1, 0];
        else upper = [0, 0, (pat || 0) + 1];
    } else if (op === "~") {
        upper = min == null ? [maj + 1, 0, 0] : [maj, min + 1, 0];
    } else if (min == null) {
        upper = [maj + 1, 0, 0];            // "1"   → >=1.0.0 <2.0.0
    } else if (pat == null) {
        upper = [maj, min + 1, 0];          // "1.2" → >=1.2.0 <1.3.0
    } else {
        return cmpVer(v, [maj, min, pat]) === 0; // exact
    }
    return cmpVer(v, upper) < 0;
}

// Highest published version of `spec` satisfying `range`, or null.
function pickVersion(versions, range) {
    let best = null;
    for (const e of versions || []) {
        if (!satisfies(e.version, range)) continue;
        if (!best || cmpVer(parseVer(e.version), parseVer(best.version)) > 0) best = e;
    }
    return best;
}

// Resolve the app dependency set into the manifest-v2 Resolution wire shape:
//   { packages: [{spec, version, pkg_hash, files, imports, capabilities, private}],
//     app_imports: { specifier: pkg_hash } }
// - `index(spec)`   → [{version, pkg_hash}]  (published versions)
// - `record(hash)`  → the version record for a pkg_hash
// Dedup-by-default: one version per spec on the app surface; a package that
// appears only via another package's frozen `imports` (a different hash) is
// kept as a nested `private` copy. `overrides` pins an app-surface spec to an
// exact version. NOTE: the per-file `bytecode_hash` is intentionally absent —
// it is filled server-side at the consumer's deploy (source-only ingestion).
// The asymmetric auto-pin of undeclared @rewind/* (plan §1.D.12) is a P-CLI
// concern (manifest mutation) and is deliberately NOT done here.
function resolveGraph(deps, overrides, index, record) {
    overrides = overrides || {};
    const appImports = {};
    const closure = {};
    const work = [];

    for (const spec of Object.keys(deps || {})) {
        let chosen;
        if (overrides[spec]) {
            const list = index(spec) || [];
            chosen = list.filter((e) => e.version === overrides[spec])[0] || null;
        } else {
            chosen = pickVersion(index(spec), deps[spec]);
        }
        if (!chosen) {
            return { error: { code: "unresolved", spec: spec, range: overrides[spec] || deps[spec] } };
        }
        appImports[spec] = chosen.pkg_hash;
        if (!closure[chosen.pkg_hash]) {
            const rec = record(chosen.pkg_hash);
            if (!rec) return { error: { code: "missing_record", pkg_hash: chosen.pkg_hash } };
            closure[chosen.pkg_hash] = rec;
            work.push(chosen.pkg_hash);
        }
    }

    // Transitive closure over frozen dep hashes (already content-pinned).
    while (work.length) {
        const rec = closure[work.pop()];
        for (const dh of Object.values(rec.imports || {})) {
            if (closure[dh]) continue;
            const drec = record(dh);
            if (!drec) return { error: { code: "missing_dep_hash", pkg_hash: dh } };
            closure[dh] = drec;
            work.push(dh);
        }
    }

    const appHashes = {};
    for (const h of Object.values(appImports)) appHashes[h] = true;
    const packages = Object.keys(closure).sort().map((h) => {
        const r = closure[h];
        return {
            spec: r.spec, version: r.version, pkg_hash: r.pkg_hash,
            files: r.files, imports: r.imports || {},
            capabilities: r.capabilities || [], private: !appHashes[h],
        };
    }).sort((a, b) => {
        if (a.spec !== b.spec) return a.spec < b.spec ? -1 : 1;
        if (a.version !== b.version) return a.version < b.version ? -1 : 1;
        return a.pkg_hash < b.pkg_hash ? -1 : a.pkg_hash > b.pkg_hash ? 1 : 0;
    });
    return { packages: packages, app_imports: appImports };
}

// ════════════════════════════════════════════════════════════════════════
// ==== router + storage-of-record (impure shell) ====
// The only section that touches kv / request / response / oidc.
// ════════════════════════════════════════════════════════════════════════

const SPEC_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const RESERVED_SCOPE = "@rewind/"; // v1: only first-party @rewind is published

function jsonError(status, message, extra) {
    response.status = status;
    return Object.assign({ error: message }, extra || {});
}

function parseBody() {
    try { return JSON.parse(request.text || "{}") || {}; } catch (_) { return {}; }
}
function parseQuery(qs) {
    const out = {};
    for (const part of (qs || "").split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const k = eq === -1 ? part : part.slice(0, eq);
        out[k] = eq === -1 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, "%20"));
    }
    return out;
}

// ── storage accessors (the impure snapshot providers resolve() consumes) ──
function readIndex(spec) {
    const raw = kv.get("pkg/idx/" + spec);
    if (raw == null) return [];
    try { return JSON.parse(raw) || []; } catch (_) { return []; }
}
function readRecordByHash(hash) {
    const raw = kv.get("pkg/hash/" + hash);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}
function readRecord(spec, version) {
    const raw = kv.get("pkg/ver/" + spec + "/" + version);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

// ── publish (operator-only): source in, gated, immutable ──────────────────
function publish(body) {
    const spec = body.spec, version = body.version;
    if (!SPEC_RE.test(String(spec || ""))) return jsonError(400, "invalid spec");
    if (!parseVer(version)) return jsonError(400, "invalid version (want x.y.z)");
    // v1: only the reserved first-party scope is published (third-party
    // self-serve + scope ownership is post-v1; the field is reserved).
    if (String(spec).indexOf(RESERVED_SCOPE) !== 0) {
        return jsonError(400, "only " + RESERVED_SCOPE + "* is published in v1 (third-party reserved)");
    }
    const files = Array.isArray(body.files) ? body.files : null;
    if (!files || !files.length) return jsonError(400, "files[] required (source-only)");
    for (const f of files) {
        if (typeof f.path !== "string" || typeof f.source !== "string") {
            return jsonError(400, "each file needs {path, source}");
        }
        if (referencesPrivilegedSurface(f.source)) {
            return jsonError(400, "package source must not reference the privileged surface (_system / __rove)", { path: f.path });
        }
    }

    // Freeze this package's OWN deps to concrete dep pkg_hashes (encapsulation).
    const deps = body.dependencies || {};
    const imports = {};
    for (const dspec of Object.keys(deps)) {
        const chosen = pickVersion(readIndex(dspec), deps[dspec]);
        if (!chosen) return jsonError(400, "unresolved dependency", { dependency: dspec, range: deps[dspec] });
        imports[dspec] = chosen.pkg_hash;
    }

    // Content-address each file's source; build the record's files[].
    const recFiles = files.map((f) => ({ path: f.path, source_hash: crypto.sha256(f.source) }));

    // Capabilities: this package's own referenced primitives ∪ its deps'.
    const caps = {};
    for (const c of extractCapabilities(files)) caps[c] = true;
    for (const dh of Object.values(imports)) {
        const drec = readRecordByHash(dh);
        for (const c of (drec && drec.capabilities) || []) caps[c] = true;
    }
    const capabilities = Object.keys(caps).sort();

    const pkg_hash = computePkgHash(spec, version, recFiles, imports);

    // Immutability: a published spec@version is frozen. Re-publishing identical
    // content is idempotent; different content is a conflict.
    const existing = readRecord(spec, version);
    if (existing) {
        if (existing.pkg_hash === pkg_hash) {
            response.status = 200;
            return { spec: spec, version: version, pkg_hash: pkg_hash, capabilities: existing.capabilities || [], imports: existing.imports || {}, idempotent: true };
        }
        return jsonError(409, "version already published with different content", { pkg_hash: existing.pkg_hash });
    }

    const record = {
        spec: spec, version: version, pkg_hash: pkg_hash,
        files: recFiles, imports: imports, capabilities: capabilities,
        private: false, published_at: Date.now(),
        published_by: (request.auth && request.auth.sub) || null,
    };

    // Store: source blobs (deduped), the version record (twice-keyed), index.
    for (let i = 0; i < files.length; i++) kv.set("pkg/src/" + recFiles[i].source_hash, files[i].source);
    const recJson = JSON.stringify(record);
    kv.set("pkg/ver/" + spec + "/" + version, recJson);
    kv.set("pkg/hash/" + pkg_hash, recJson);
    const idx = readIndex(spec);
    if (!idx.some((e) => e.version === version)) idx.push({ version: version, pkg_hash: pkg_hash });
    kv.set("pkg/idx/" + spec, JSON.stringify(idx));

    response.status = 201;
    return { spec: spec, version: version, pkg_hash: pkg_hash, capabilities: capabilities, imports: imports };
}

// ── resolve (public): dep ranges → manifest-v2 Resolution lockfile ────────
function resolve(body) {
    const out = resolveGraph(body.dependencies || {}, body.overrides || {}, readIndex, readRecordByHash);
    if (out.error) {
        return jsonError(out.error.code === "unresolved" ? 422 : 500, "resolve failed", out.error);
    }
    response.status = 200;
    return out;
}

// ── discovery (public) ────────────────────────────────────────────────────
function listPackages() {
    const rows = kv.prefix("pkg/idx/", "", 1000);
    const packages = rows.map((row) => {
        const spec = row.key.slice("pkg/idx/".length);
        let versions = [];
        try { versions = JSON.parse(row.value) || []; } catch (_) {}
        versions = versions.map((e) => e.version).sort((a, b) => cmpVer(parseVer(a), parseVer(b)));
        return { spec: spec, versions: versions, latest: versions[versions.length - 1] || null };
    }).sort((a, b) => (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
    response.status = 200;
    return { packages: packages };
}
function getPackage(spec) {
    const idx = readIndex(spec);
    if (!idx.length) return jsonError(404, "package not found", { spec: spec });
    const versions = idx.map((e) => {
        const rec = readRecordByHash(e.pkg_hash) || {};
        return { version: e.version, pkg_hash: e.pkg_hash, capabilities: rec.capabilities || [], published_at: rec.published_at || null };
    }).sort((a, b) => cmpVer(parseVer(a.version), parseVer(b.version)));
    response.status = 200;
    return { spec: spec, versions: versions, latest: versions[versions.length - 1] || null };
}
function getVersion(spec, version) {
    const rec = readRecord(spec, version);
    if (!rec) return jsonError(404, "version not found", { spec: spec, version: version });
    response.status = 200;
    return rec;
}
function getBlob(hash) {
    const src = kv.get("pkg/src/" + hash);
    if (src == null) return jsonError(404, "blob not found", { source_hash: hash });
    response.status = 200;
    response.headers = { "content-type": "text/plain; charset=utf-8" };
    return src;
}

// ── route table + dispatch ────────────────────────────────────────────────
// authz: "open" = public; "publish" = operator (is_root) only.
const ROUTES = [
    ["POST", "/v1/packages",                    "publish", (c) => publish(c.body)],
    ["GET",  "/v1/packages",                    "open",    () => listPackages()],
    ["GET",  "/v1/packages/:scope/:name",       "open",    (c) => getPackage(c.params.scope + "/" + c.params.name)],
    ["GET",  "/v1/packages/:scope/:name/:version", "open", (c) => getVersion(c.params.scope + "/" + c.params.name, c.params.version)],
    ["POST", "/v1/resolve",                     "open",    (c) => resolve(c.body)],
    ["GET",  "/v1/blobs/:hash",                 "open",    (c) => getBlob(c.params.hash)],
];

function matchRoute(method, path) {
    const segs = path.split("/");
    for (const route of ROUTES) {
        if (route[0] !== method) continue;
        const pat = route[1].split("/");
        const params = {};
        let ok = true;
        if (pat.length !== segs.length) continue;
        for (let i = 0; i < pat.length; i++) {
            if (pat[i].charCodeAt(0) === 58 /* ':' */) params[pat[i].slice(1)] = decodeURIComponent(segs[i]);
            else if (pat[i] !== segs[i]) { ok = false; break; }
        }
        if (!ok) continue;
        return { authz: route[2], thunk: route[3], params: params };
    }
    return null;
}

function routeAuthz(cls) {
    if (cls === "open") return null;
    const a = request.auth || {};
    if (cls === "publish") {
        if (!a.sub && !a.is_root) return jsonError(401, "unauthenticated");
        if (!a.is_root) return jsonError(403, "operator only");
        return null;
    }
    return jsonError(403, "forbidden");
}

// Single entry point. `_middlewares` runs first and sets request.auth (best
// effort — public routes need no session).
export default function () {
    const fullPath = request.path;
    const qi = fullPath.indexOf("?");
    const path = qi === -1 ? fullPath : fullPath.slice(0, qi);
    const qs = qi === -1 ? "" : fullPath.slice(qi + 1);
    const m = matchRoute(request.method, path);
    if (!m) { response.status = 404; return { error: "not found" }; }
    const denied = routeAuthz(m.authz);
    if (denied) return denied;
    return m.thunk({ params: m.params, query: parseQuery(qs), body: parseBody(), qs: qs, path: path });
}
