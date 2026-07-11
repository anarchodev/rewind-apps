// The deploy surface: the per-file workspace deploy (reset / file / cut) and the
// cross-tenant source-read saga. Deploy ops go through the M2M door (a Bearer root
// token via _middlewares, or a session that owns the tenant), gated by deployGate;
// they use platform.scope(t) stores and lower each door op to a bound after.fetch.
//
// The deploy doors — platform.compile → onFileStaged and deploy.stampManifest → onCut —
// deliver their RESULT on request.ctx ({ok, results, app} / {ok, dep_id}); the sim drives
// them with node.compile().staged(...) / node.stampManifest().cut(...) (rove 3f36f0a). The
// source-read saga (onManifest → onModuleSource loop) reads its result off request.text.
import { scenario, expect } from "rewind:test";

const RP_CONFIG = {
  issuer: "https://auth.rewindjs.com",
  client_id: "admin-dashboard",
  redirect_uri: "https://app.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000;
const sess = (sub, is_root) => JSON.stringify({ sub, is_root, exp: FAR });
const j = JSON.stringify;
const wsEntry = (o) => j(o);

const s = scenario({
  admin: true,
  rootToken: "rt",
  now: "2026-07-01T00:00:00Z",
  kv: {
    "_config/oidc/rp/default": RP_CONFIG,
    "_rp/sess/op": sess("ops@rewindjs.com", true),   // operator (is_root)
    "_rp/sess/jess": sess("jess@x.com", false),      // non-owner
  },
  instances: {
    acme: {
      kv: {
        "_workspace/index.mjs": wsEntry({ kind: "handler", source_hex: "aa", bytecode_hex: "bb" }),
        "_workspace/logo.png": wsEntry({ kind: "static", content_type: "image/png", source_hex: "cc" }),
        "_deploy/current": "cafe",
      },
    },
  },
});

const BEARER = { authorization: "Bearer rt" };
// deploy ops are POST with a JSON string body (deployGate JSON.parses request.text)
const deploy = (op, bodyObj, opts = {}) => s.inbound({
  method: "POST", path: "/v1/deploy/" + op, host: "app.rewindjs.com",
  body: bodyObj === undefined ? "" : j(bodyObj),
  headers: opts.headers || {}, session: opts.sid ? { id: opts.sid } : undefined,
});

// ── deployGate — the shared auth/validation gate (via /v1/deploy/reset) ────
// no auth → 401 (M2M path with no token falls through to the OIDC guard)
expect(deploy("reset", { tenant: "acme" }).status).toBe(401);
// bad JSON body → 400
expect(deploy("reset", undefined, { headers: BEARER }).status).toBe(400); // "" is not JSON
// invalid tenant → 400
expect(deploy("reset", { tenant: "bad!" }, { headers: BEARER }).status).toBe(400);
// a non-owner session → 403
expect(deploy("reset", { tenant: "acme" }, { sid: "jess" }).status).toBe(403);

// ── reset: operator clears the tenant's workspace ─────────────────────────
const reset = deploy("reset", { tenant: "acme" }, { headers: BEARER });
expect(reset.status).toBe(200);
expect(reset.body).toEqual({ ok: true, cleared: 2 });
expect(reset.instanceKv("acme", "_workspace/index.mjs")).toBe(null);
expect(reset.instanceKv("acme", "_workspace/logo.png")).toBe(null);

// ── file: validation + the compile-door emission ──────────────────────────
expect(deploy("file", { tenant: "acme", kind: "handler" }, { headers: BEARER }).status).toBe(400); // path required
expect(deploy("file", { tenant: "acme", path: "x.mjs", kind: "static" }, { headers: BEARER }).status).toBe(400); // handlers only
const file = deploy("file", { tenant: "acme", path: "index.mjs", kind: "handler", source: "export default () => {}" }, { headers: BEARER });
expect(file.disposition).toBe("held");
expect(file).toHaveFetched(/rove-compile\.internal/);
// compile completes → onFileStaged records the workspace entry from the door result
// (app defaults to the echoed issue-time ctx {target, path, content_type})
const staged = file.compile().staged({ results: [{ path: "index.mjs", source_hex: "abc123", bytecode_hex: "def456" }] });
expect(staged.status).toBe(200);
expect(JSON.parse(staged.body)).toEqual({ ok: true, path: "index.mjs", hash: "abc123" });
expect(staged.instanceKv("acme", "_workspace/index.mjs")).toEqual({
  kind: "handler", content_type: "", source_hex: "abc123", bytecode_hex: "def456" });
// a failed compile → onFileStaged 500
expect(file.compile().staged({ ok: false }).status).toBe(500);

// ── cut: empty-workspace guard + the stampManifest emission ───────────────
expect(deploy("cut", { tenant: "empty" }, { headers: BEARER }).status).toBe(400); // workspace empty
const cut = deploy("cut", { tenant: "acme" }, { headers: BEARER });
expect(cut.disposition).toBe("held");
expect(cut).toHaveFetched(/rove-stage\.internal/);
// stampManifest completes → onCut returns { ok, dep_id }
const cutDone = cut.stampManifest().cut({ dep_id: "00000000cafebabe" });
expect(cutDone.status).toBe(200);
expect(JSON.parse(cutDone.body)).toEqual({ ok: true, dep_id: "00000000cafebabe" });

// ── source-read saga — readManifest → onManifest → blob.get loop → finish ──
const sources = (tenant, dep, sid) => s.inbound({
  method: "GET", path: "/v1/sources/" + tenant + "/" + dep, host: "app.rewindjs.com",
  body: "", session: sid ? { id: sid } : undefined,
});

// auth branches
expect(sources("acme", "1a2b").status).toBe(401);                 // no session (middleware guard)
expect(sources("acme", "1a2b", "jess").status).toBe(403);         // non-owner
expect(sources("acme", "zz", "op").status).toBe(400);             // bad dep_id (non-hex)

// operator reads a dep → the manifest read door is armed
const q = sources("acme", "1a2b", "op");
expect(q.disposition).toBe("held");
expect(q).toHaveFetched(/rove-blob-read\.internal\/acme\/manifest\/1a2b/);

// resolve the manifest (2 handlers + 1 static) → onManifest reads the first handler
const man = q.fetch(/manifest\/1a2b/).resolve({ status: 200, done: true, body: j({ entries: [
  { path: "index.mjs", kind: "handler", hash: "h1", content_type: "" },
  { path: "util.mjs", kind: "handler", hash: "h2", content_type: "" },
  { path: "logo.png", kind: "static", hash: "h3", content_type: "image/png" },
] }) });
expect(man.disposition).toBe("held");
expect(man).toHaveFetched(/blob\/h1/);

// source 0 arrives → onModuleSource threads it, reads the next handler
const src0 = man.fetch(/blob\/h1/).resolve({ status: 200, done: true, body: "export default () => {}" });
expect(src0.disposition).toBe("held");
expect(src0).toHaveFetched(/blob\/h2/);

// source 1 arrives (last handler) → finishSources responds
const done = src0.fetch(/blob\/h2/).resolve({ status: 200, done: true, body: "export const x = 1" });
expect(done.status).toBe(200);
const out = JSON.parse(done.body);
expect(out.ok).toBe(true);
expect(out.dep_id).toBe("1a2b");
expect(out.entries.length).toBe(3);
expect(out.entries.find((e) => e.path === "index.mjs").source).toBe("export default () => {}");
expect(out.entries.find((e) => e.path === "util.mjs").source).toBe("export const x = 1");
// a static carries metadata only, no source
const png = out.entries.find((e) => e.path === "logo.png");
expect(png.source).toBe(undefined);
expect(png.kind).toBe("static");

// a failed handler-source read → that entry is marked missing (not fatal)
const missing = src0.fetch(/blob\/h2/).resolve({ status: 404, ok: false });
const mOut = JSON.parse(missing.body);
expect(mOut.entries.find((e) => e.path === "util.mjs").missing).toBe(true);

// ── current-dep resolution: "current" → _deploy/current, then the same saga ─
const cur = sources("acme", "current", "op");
expect(cur.disposition).toBe("held");
expect(cur).toHaveFetched(/rove-blob-read\.internal\/acme\/manifest\/cafe/); // resolved from _deploy/current
