// registry resolve + discovery surface — the resolve API (issue #1 §3) that
// returns the manifest-v2 Resolution lockfile shape the rewind CLI consumes,
// plus the discovery read endpoints (§4). Resolve/discovery are PUBLIC (no
// session), so these inbounds carry no session.
//
// Writes don't leak between inbounds, so the "already-published" packages are
// SEEDED into kv (as a real publish would leave them) with content-consistent
// pkg_hashes computed by the same JCS formula the handler uses.
import { scenario, expect } from "rewind:test";

const RP = {
  issuer: "https://auth.rewindjs.com",
  client_id: "registry-dashboard",
  redirect_uri: "https://registry.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const j = JSON.stringify;
const HOST = "registry.rewindjs.com";
const H = (s) => crypto.sha256(s);
function canon(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
function pkgHash(spec, version, files, imports) {
  const fs = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({ path: f.path, source_hash: f.source_hash }));
  const ip = Object.keys(imports || {}).sort().map((k) => [k, imports[k]]);
  return crypto.sha256(canon({ spec: spec, version: version, files: fs, imports: ip }));
}

// A published package: source blob + version record (twice-keyed) + index row.
function mk(kv, idxAcc, spec, version, source, imports, caps) {
  const files = [{ path: "index.mjs", source_hash: H(source) }];
  const ph = pkgHash(spec, version, files, imports || {});
  const rec = { spec: spec, version: version, pkg_hash: ph, files: files, imports: imports || {}, capabilities: caps || [], private: false, published_at: 0 };
  kv["pkg/src/" + H(source)] = source;
  kv["pkg/ver/" + spec + "/" + version] = j(rec);
  kv["pkg/hash/" + ph] = j(rec);
  (idxAcc[spec] = idxAcc[spec] || []).push({ version: version, pkg_hash: ph });
  return ph;
}

const KV = { "_config/oidc/rp/default": RP };
const IDX = {};
// jwt has two versions; oidc@2.3.1 froze jwt@1.4.0 internally (the classic
// encapsulation case: app pins 1.9.0, oidc keeps its private 1.4.0).
const JWT14 = mk(KV, IDX, "@rewind/jwt", "1.4.0", "export const v=14; crypto.sha256('x');", {}, ["crypto"]);
const JWT19 = mk(KV, IDX, "@rewind/jwt", "1.9.0", "export const v=19; crypto.sha256('x');", {}, ["crypto"]);
const OIDC = mk(KV, IDX, "@rewind/oidc", "2.3.1", "import '@rewind/jwt'; export const guard=1; kv.get('s');", { "@rewind/jwt": JWT14 }, ["crypto", "kv"]);
for (const spec of Object.keys(IDX)) KV["pkg/idx/" + spec] = j(IDX[spec]);

const s = () => scenario({ now: "2026-07-01T00:00:00Z", seed: 1, kv: KV });
const resolve = (body) => s().inbound({ method: "POST", path: "/v1/resolve", host: HOST, body: body });
const get = (path) => s().inbound({ method: "GET", path: path, host: HOST });

// ── resolve: encapsulation + dedup + private nesting ──────────────────────
// App pins oidc@^2.3 and jwt@^1.9. Surface = {oidc:2.3.1, jwt:1.9.0}; the
// closure ALSO carries oidc's frozen private jwt@1.4.0.
const r = resolve({ dependencies: { "@rewind/oidc": "^2.3", "@rewind/jwt": "^1.9" } });
expect(r.status).toBe(200);
expect(r.body.app_imports).toEqual({ "@rewind/oidc": OIDC, "@rewind/jwt": JWT19 });
const byHash = {};
for (const p of r.body.packages) byHash[p.pkg_hash] = p;
expect(Object.keys(byHash).length).toBe(3);              // oidc, jwt@1.9, jwt@1.4
expect(byHash[JWT19].private).toBe(false);               // on the app surface
expect(byHash[JWT19].version).toBe("1.9.0");
expect(byHash[JWT14].private).toBe(true);                // nested, encapsulated
expect(byHash[JWT14].version).toBe("1.4.0");
expect(byHash[OIDC].imports).toEqual({ "@rewind/jwt": JWT14 });   // frozen at publish
// resolution files carry source_hash only — bytecode_hash is filled at deploy
expect(byHash[OIDC].files[0].source_hash).not.toBe(undefined);
expect(byHash[OIDC].files[0].bytecode_hash).toBe(undefined);

// ── resolve: dedup collapses when a dep isn't lifted to the surface ───────
// App pins only oidc; jwt appears solely as oidc's private nested copy.
const r2 = resolve({ dependencies: { "@rewind/oidc": "^2.3" } });
expect(r2.body.app_imports).toEqual({ "@rewind/oidc": OIDC });
const priv = r2.body.packages.filter((p) => p.spec === "@rewind/jwt");
expect(priv.length).toBe(1);
expect(priv[0].version).toBe("1.4.0");
expect(priv[0].private).toBe(true);

// ── resolve: overrides pin an exact version on the app surface ────────────
const r3 = resolve({ dependencies: { "@rewind/jwt": "^1.9" }, overrides: { "@rewind/jwt": "1.4.0" } });
expect(r3.body.app_imports).toEqual({ "@rewind/jwt": JWT14 });

// ── resolve: an unsatisfiable dependency is a 422 ─────────────────────────
expect(resolve({ dependencies: { "@rewind/jwt": "^9.0" } }).status).toBe(422);
expect(resolve({ dependencies: { "@rewind/ghost": "^1.0" } }).status).toBe(422);

// ── discovery ──────────────────────────────────────────────────────────────
const list = get("/v1/packages");
expect(list.status).toBe(200);
const specs = list.body.packages.map((p) => p.spec);
expect(specs.indexOf("@rewind/jwt") !== -1).toBe(true);
expect(specs.indexOf("@rewind/oidc") !== -1).toBe(true);
const jwtEntry = list.body.packages.filter((p) => p.spec === "@rewind/jwt")[0];
expect(jwtEntry.latest).toBe("1.9.0");                   // highest semver

const pkg = get("/v1/packages/@rewind/jwt");
expect(pkg.status).toBe(200);
expect(pkg.body.versions.map((v) => v.version)).toEqual(["1.4.0", "1.9.0"]);

const ver = get("/v1/packages/@rewind/oidc/2.3.1");
expect(ver.status).toBe(200);
expect(ver.body.pkg_hash).toBe(OIDC);
expect(get("/v1/packages/@rewind/oidc/9.9.9").status).toBe(404);

// source blob fetch (what the CLI pulls to stage via /v1/deploy/pkgfile)
const blob = get("/v1/blobs/" + H("export const v=19; crypto.sha256('x');"));
expect(blob.status).toBe(200);
expect(blob.body).toBe("export const v=19; crypto.sha256('x');");
expect(get("/v1/blobs/" + "0".repeat(64)).status).toBe(404);
