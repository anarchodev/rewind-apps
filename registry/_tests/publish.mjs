// registry publish surface — the source-only, gated, immutable publish path
// (issue #1 §2). Exercises the real router + _middlewares OIDC guard offline.
//
// The publish endpoint's pkg_hash is a PERMANENT cross-publisher wire contract,
// so this suite recomputes it with an INDEPENDENT reimplementation of the JCS
// formula (canon/pkgHash below) and asserts byte-for-byte equality against what
// the handler returns — the whole point of a reproducible content identity.
//
// Writes don't leak between inbounds, so each assertion is a single publish
// inbound whose own kv writes are read back via res.kv(...).
import { scenario, expect } from "rewind:test";

const RP = {
  issuer: "https://auth.rewindjs.com",
  client_id: "registry-dashboard",
  redirect_uri: "https://registry.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000;
const j = JSON.stringify;
const HOST = "registry.rewindjs.com";
const sess = (sub, is_root) => j({ sub, is_root, exp: FAR });

// ── independent JCS pkg_hash reimplementation (the contract cross-check) ──
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

// A tiny frozen jwt@1.4.0 record so dep-freezing has something to resolve against.
const JWT_SRC = "export function verify(t){ return crypto.sha256(t); }";
const JWT_FILES = [{ path: "index.mjs", source_hash: H(JWT_SRC) }];
const JWT_HASH = pkgHash("@rewind/jwt", "1.4.0", JWT_FILES, {});
const JWT_REC = { spec: "@rewind/jwt", version: "1.4.0", pkg_hash: JWT_HASH, files: JWT_FILES, imports: {}, capabilities: ["crypto"], private: false, published_at: 0 };

const BASE = {
  "_config/oidc/rp/default": RP,
  "_rp/sess/op": sess("ops@rewindjs.com", true),   // operator
  "_rp/sess/jess": sess("jess@x.com", false),      // non-operator
  "pkg/idx/@rewind/jwt": j([{ version: "1.4.0", pkg_hash: JWT_HASH }]),
  ["pkg/hash/" + JWT_HASH]: j(JWT_REC),
  "pkg/ver/@rewind/jwt/1.4.0": j(JWT_REC),
};
const s = () => scenario({ now: "2026-07-01T00:00:00Z", seed: 1, kv: BASE });
const pub = (sid, body) => s().inbound({ method: "POST", path: "/v1/packages", host: HOST, body: body, session: sid ? { id: sid } : undefined });

// ── auth gate: publish is operator-only in v1 ─────────────────────────────
expect(pub(null, { spec: "@rewind/a", version: "1.0.0", files: [{ path: "i.mjs", source: "export const x=1;" }] }).status).toBe(401);
expect(pub("jess", { spec: "@rewind/a", version: "1.0.0", files: [{ path: "i.mjs", source: "export const x=1;" }] }).status).toBe(403);

// ── input validation ──────────────────────────────────────────────────────
expect(pub("op", { spec: "not-a-spec", version: "1.0.0", files: [{ path: "i.mjs", source: "x" }] }).status).toBe(400);
expect(pub("op", { spec: "@rewind/a", version: "v1", files: [{ path: "i.mjs", source: "x" }] }).status).toBe(400);
expect(pub("op", { spec: "@rewind/a", version: "1.0.0", files: [] }).status).toBe(400);
// v1 reserves publishing to the first-party @rewind scope
expect(pub("op", { spec: "@acme/widgets", version: "1.0.0", files: [{ path: "i.mjs", source: "x" }] }).status).toBe(400);

// ── privileged-surface gate (mirror of rove referencesPrivilegedSurface) ──
expect(pub("op", { spec: "@rewind/evil", version: "1.0.0", files: [{ path: "i.mjs", source: "const p = _system.kv;" }] }).status).toBe(400);
expect(pub("op", { spec: "@rewind/evil", version: "1.0.0", files: [{ path: "i.mjs", source: "__rove_check_email_rate();" }] }).status).toBe(400);
// a var merely CONTAINING the token as a substring is fine (whole-ident match)
expect(pub("op", { spec: "@rewind/ok", version: "1.0.0", files: [{ path: "i.mjs", source: "const my_system_x = 1; const subroverX = 2;" }] }).status).toBe(201);

// ── happy path: pkg_hash contract + capability extraction ─────────────────
const SRC = "export function issue(){ return webhook.send({}) || kv.get('x'); }";
const okBody = { spec: "@rewind/mailer", version: "2.0.0", files: [{ path: "index.mjs", source: SRC }] };
const ok = pub("op", okBody);
expect(ok.status).toBe(201);
const wantHash = pkgHash("@rewind/mailer", "2.0.0", [{ path: "index.mjs", source_hash: H(SRC) }], {});
expect(ok.body.pkg_hash).toBe(wantHash);           // byte-for-byte contract cross-check
expect(ok.body.capabilities).toEqual(["kv", "webhook"]);
// the version record + hash record + index row + source blob were all written
expect(ok.kv("pkg/ver/@rewind/mailer/2.0.0")).not.toBe(null);
expect(ok.kv("pkg/hash/" + wantHash)).not.toBe(null);
expect(ok.kv("pkg/src/" + H(SRC))).toBe(SRC);
// res.kv() returns JSON values already parsed (raw string for non-JSON blobs).
expect(ok.kv("pkg/idx/@rewind/mailer").some((e) => e.version === "2.0.0" && e.pkg_hash === wantHash)).toBe(true);

// ── dependency freezing (encapsulation): own deps → concrete dep hashes ────
const oidcSrc = "import { verify } from '@rewind/jwt'; export function guard(){ return verify('t'); }";
const withDep = pub("op", { spec: "@rewind/oidc", version: "2.3.1", files: [{ path: "index.mjs", source: oidcSrc }], dependencies: { "@rewind/jwt": "^1.4" } });
expect(withDep.status).toBe(201);
expect(withDep.body.imports).toEqual({ "@rewind/jwt": JWT_HASH });   // frozen at publish
expect(withDep.body.capabilities).toEqual(["crypto"]);              // ∪ jwt's caps
// an unresolvable own-dep is rejected
expect(pub("op", { spec: "@rewind/oidc", version: "2.3.1", files: [{ path: "i.mjs", source: "x" }], dependencies: { "@rewind/nope": "^1.0" } }).status).toBe(400);

// ── immutability: identical re-publish is idempotent; different is a conflict ──
// seed a record whose hash MATCHES the content we re-publish → 200 idempotent
const idSrc = "export const x = 1;";
const idHash = pkgHash("@rewind/frozen", "1.0.0", [{ path: "index.mjs", source_hash: H(idSrc) }], {});
const idRec = { spec: "@rewind/frozen", version: "1.0.0", pkg_hash: idHash, files: [{ path: "index.mjs", source_hash: H(idSrc) }], imports: {}, capabilities: [], private: false, published_at: 0 };
const withFrozen = scenario({
  now: "2026-07-01T00:00:00Z", seed: 1,
  kv: Object.assign({}, BASE, {
    "pkg/ver/@rewind/frozen/1.0.0": j(idRec),
    "pkg/ver/@rewind/conflict/1.0.0": j({ spec: "@rewind/conflict", version: "1.0.0", pkg_hash: "0".repeat(64), files: [], imports: {}, capabilities: [] }),
  }),
});
const idem = withFrozen.inbound({ method: "POST", path: "/v1/packages", host: HOST, body: { spec: "@rewind/frozen", version: "1.0.0", files: [{ path: "index.mjs", source: idSrc }] }, session: { id: "op" } });
expect(idem.status).toBe(200);
expect(idem.body.idempotent).toBe(true);
const conflict = withFrozen.inbound({ method: "POST", path: "/v1/packages", host: HOST, body: { spec: "@rewind/conflict", version: "1.0.0", files: [{ path: "index.mjs", source: idSrc }] }, session: { id: "op" } });
expect(conflict.status).toBe(409);
