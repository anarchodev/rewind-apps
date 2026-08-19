// The Code tab's Phase-1 doors: hash-reference staging (/v1/deploy/ref),
// the single-file source read (/v1/source/{tenant}/{dep}?path=…), and the
// sources door's package-metadata fidelity (capabilities/private must
// survive the round-trip — a redeploy resolution missing them would
// silently strip the package's capability grants). Both doors compose
// scope(t).blob.get / deploy.readManifest, which lower to bound fetches at
// rove-blob-read.internal — so the test drives the full held chain and
// resolves each hop.
import { scenario, expect } from "rewind:test";

const RP_CONFIG = {
  issuer: "https://auth.rewindjs.com",
  client_id: "admin-dashboard",
  redirect_uri: "https://app.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000;
const sess = (sub, is_root) => JSON.stringify({ sub, is_root, exp: FAR });

const s = scenario({
  admin: true,
  now: "2026-08-01T00:00:00Z",
  instances: { acme: {} },
  kv: {
    "_config/oidc/rp/default": RP_CONFIG,
    "_rp/sess/op": sess("ops@rewindjs.com", true),   // operator
    "_rp/sess/al": sess("alice@x.com", false),       // plain user, owns nothing
  },
});
const call = (method, path, sid, body) =>
  s.inbound({ method, path, host: "app.rewindjs.com", body, session: sid ? { id: sid } : undefined });

const HASH = "ab".repeat(32); // 64 lowercase hex — the door's wire contract

// ── /v1/deploy/ref — hash-reference static staging ────────────────────────

// authz: middleware 401 with no session; deployGate 403 for a non-owner.
expect(call("POST", "/v1/deploy/ref", null, { tenant: "acme" }).status).toBe(401);
expect(call("POST", "/v1/deploy/ref", "al",
  { tenant: "acme", path: "_static/a.png", kind: "static", hash: HASH }).status).toBe(403);

// wire contract: path+hash required; statics only; 64-lowercase-hex hash.
expect(call("POST", "/v1/deploy/ref", "op", { tenant: "acme" }).status).toBe(400);
expect(call("POST", "/v1/deploy/ref", "op",
  { tenant: "acme", path: "index.mjs", kind: "handler", hash: HASH }).status).toBe(400);
expect(call("POST", "/v1/deploy/ref", "op",
  { tenant: "acme", path: "_static/a.png", kind: "static", hash: "AB12" }).status).toBe(400);

// happy path: hold → verify the blob exists via the read door → record the
// workspace row exactly as v1/upload's onStored writes it.
const ref = call("POST", "/v1/deploy/ref", "op", {
  tenant: "acme", path: "_static/logo.png", kind: "static",
  content_type: "image/png", hash: HASH,
});
expect(ref.disposition).toBe("held");
expect(ref).toHaveFetched(/rove-blob-read\.internal\/acme\/blob\//);
const refOk = ref.fetch(/rove-blob-read/).resolve({ status: 200, body: "\x89PNG…" });
expect(refOk.status).toBe(200);
expect(JSON.parse(refOk.body)).toEqual({ ok: true, path: "_static/logo.png", hash: HASH });
expect(refOk.instanceKv("acme", "_workspace/_static/logo.png")).toEqual({
  kind: "static", content_type: "image/png", source_hex: HASH,
});

// missing blob (GC'd / bogus hash): the deploy fails HERE, and no workspace
// row exists to become a dangling manifest pointer.
const refGone = ref.fetch(/rove-blob-read/).resolve({ status: 404, ok: false });
expect(refGone.status).toBe(404);
expect(JSON.parse(refGone.body).ok).toBe(false);
expect(refGone.instanceKv("acme", "_workspace/_static/logo.png")).toBe(null);

// ── /v1/source/{tenant}/{dep}?path=… — single-file text read ─────────────

const DEP = "00000000000000ab";
const CSS_HASH = "cd".repeat(32);
const MANIFEST = JSON.stringify({
  entries: [
    { path: "index.mjs", kind: "handler",
      content_type: "application/javascript", hash: "ef".repeat(32) },
    { path: "_static/app.css", kind: "static",
      content_type: "text/css", hash: CSS_HASH },
    { path: "_static/logo.png", kind: "static",
      content_type: "image/png", hash: "01".repeat(32) },
  ],
});
const src = (qs, sid = "op") =>
  call("GET", "/v1/source/acme/" + DEP + "?" + qs, sid);

// authz + wire contract.
expect(call("GET", "/v1/source/acme/" + DEP + "?path=x", null).status).toBe(401);
expect(src("path=_static/app.css", "al").status).toBe(403);
expect(src("").status).toBe(400);                       // no path param
expect(call("GET", "/v1/source/acme/zz?path=x", "op").status).toBe(400); // bad dep

// happy path: manifest hop → blob hop → the source JSON the editor opens.
const rd = src("path=" + encodeURIComponent("_static/app.css"));
expect(rd.disposition).toBe("held");
expect(rd).toHaveFetched(/rove-blob-read\.internal\/acme\/manifest\/00000000000000ab/);
const rd2 = rd.fetch(/manifest/).resolve({ status: 200, body: MANIFEST });
expect(rd2.disposition).toBe("held");
expect(rd2).toHaveFetched(/rove-blob-read\.internal\/acme\/blob\/cdcd/);
const rdDone = rd2.fetch(/blob\/cd/).resolve({ status: 200, body: "body { color: red }" });
expect(rdDone.status).toBe(200);
expect(JSON.parse(rdDone.body)).toEqual({
  ok: true, path: "_static/app.css", kind: "static",
  content_type: "text/css", source_hex: CSS_HASH,
  source: "body { color: red }",
});

// a binary entry never reaches the blob hop — 415, carry it by hash-ref.
const bin = src("path=" + encodeURIComponent("_static/logo.png"))
  .fetch(/manifest/).resolve({ status: 200, body: MANIFEST });
expect(bin.status).toBe(415);

// a path the deployment doesn't carry → 404.
const ghost = src("path=nope.css").fetch(/manifest/).resolve({ status: 200, body: MANIFEST });
expect(ghost.status).toBe(404);

// ── /v1/sources — package capabilities/private survive the read ──────────
// The redeploy resolution is built from this response; buildResolution
// reads capabilities+private, so the door must return them.

const H1 = "12".repeat(32), P1 = "34".repeat(32), PKG = "56".repeat(32);
const PKG_MANIFEST = JSON.stringify({
  entries: [{ path: "index.mjs", kind: "handler",
              content_type: "application/javascript", hash: H1 }],
  packages: [{
    spec: "@rewind/email", version: "1.2.0", pkg_hash: PKG,
    imports: {}, capabilities: ["email.send"], private: true,
    files: [{ path: "index.mjs", source_hash: P1 }],
  }],
  app_imports: { "@rewind/email": PKG },
});
const all = call("GET", "/v1/sources/acme/" + DEP, "op")
  .fetch(/manifest/).resolve({ status: 200, body: PKG_MANIFEST })
  .fetch(/blob\/12/).resolve({ status: 200, body: "export default function(){}" })
  .fetch(/blob\/34/).resolve({ status: 200, body: "export function send(){}" });
expect(all.status).toBe(200);
const out = JSON.parse(all.body);
expect(out.packages.length).toBe(1);
expect(out.packages[0].capabilities).toEqual(["email.send"]);
expect(out.packages[0].private).toBe(true);
expect(out.packages[0].files[0].source).toBe("export function send(){}");
expect(out.app_imports).toEqual({ "@rewind/email": PKG });
