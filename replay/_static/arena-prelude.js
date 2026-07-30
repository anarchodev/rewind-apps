// GENERATED — do not edit. scripts/ops/gen_replay_prelude.py (rove)
// composes this from the engine's own shim sources; regenerated at
// publish time by the replay tenant's manifest `generate` hook.
//
// Evaled once into the WASM arena's open base (arena_eval_base), before
// freeze, before any run, outside every drill trace — so a replayed
// handler sees the same pure compute globals a live handler does.

// ── src/replay/js/textcodec_pure.js ──
;// Pure-JS UTF-8 `TextEncoder` / `TextDecoder` — the codec for arenas that
// have no native textcodec binding: the CLI sim/replay epilogue splices this
// file into its per-run script, and the browser WASM replay prelude
// (scripts/ops/gen_replay_prelude.py) evals it into the arena base. Prod is
// different: it installs globals/textcodec.js over the native
// `_system.textcodec` (bindings/textcodec.zig) and never sees this file.
//
// The codec matches prod byte-for-byte — a latin1 (`charCodeAt & 0xff`)
// shortcut diverges on EVERY non-ASCII byte, which silently corrupts every
// hash/HMAC/JWT/base64url/signature computed over non-ASCII text offline.
// That includes the lone-surrogate corner: prod (QuickJS) encodes a LONE
// surrogate as its 3-byte WTF-8 form (ED A0 80), NOT the WHATWG U+FFFD
// replacement, and so does this encoder.
//
// Idempotent: installs only where `TextDecoder` is absent, so a request-arena
// re-eval over a base that already ran it keeps the base copy.
(function () {
  if (typeof globalThis.TextDecoder !== "undefined") return;
  const __utf8Encode = (s) => { s = String(s == null ? "" : s); const out = []; for (let i = 0; i < s.length; i++) { let cp = s.charCodeAt(i); if (cp >= 0xD800 && cp <= 0xDBFF) { const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0; if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i++; } } if (cp < 0x80) out.push(cp); else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F)); else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); } const u = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) u[i] = out[i]; return u; };
  const __utf8Decode = (bytes, fatal) => { let b = bytes; if (typeof b === "string") { const t = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) t[i] = b.charCodeAt(i) & 0xff; b = t; } let s = ""; let i = 0; const n = b.length; const bad = () => { if (fatal) throw new TypeError("TextDecoder: malformed UTF-8"); s += "\uFFFD"; }; while (i < n) { const c0 = b[i]; if (c0 < 0x80) { s += String.fromCharCode(c0); i++; continue; } let need, cp, min; if (c0 >= 0xC2 && c0 <= 0xDF) { need = 1; cp = c0 & 0x1F; min = 0x80; } else if (c0 >= 0xE0 && c0 <= 0xEF) { need = 2; cp = c0 & 0x0F; min = 0x800; } else if (c0 >= 0xF0 && c0 <= 0xF4) { need = 3; cp = c0 & 0x07; min = 0x10000; } else { bad(); i++; continue; } let ok = i + need < n; for (let k = 1; ok && k <= need; k++) { const cc = b[i + k]; if (cc < 0x80 || cc > 0xBF) { ok = false; break; } cp = (cp << 6) | (cc & 0x3F); } if (!ok || cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { bad(); i++; continue; } if (cp < 0x10000) s += String.fromCharCode(cp); else { cp -= 0x10000; s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); } i += need + 1; } return s; };
  globalThis.TextDecoder = function (label, options) { const enc = String(label == null ? "utf-8" : label).toLowerCase(); if (enc !== "utf-8" && enc !== "utf8") throw new RangeError("TextDecoder: only utf-8 is supported"); this._fatal = !!(options && options.fatal); };
  globalThis.TextDecoder.prototype.decode = function (u) { if (u == null) return ""; return __utf8Decode(u, this._fatal); };
  globalThis.TextEncoder = function () {};
  globalThis.TextEncoder.prototype.encode = function (s) { return __utf8Encode(s); };
})();

// ── src/tape/js_interaction_digest.js ──
;// The interaction digest, JS side — the mirror of
// src/tape/interaction_digest.zig. Read that file for what the digest is
// for and, more importantly, for what is deliberately excluded from it.
//
// Two implementations of one hash is exactly the shape that has bitten this
// codebase before (a latin1 codec that diverged from the native one on every
// non-ASCII byte; a kv.prefix signature that disagreed between two callers).
// So neither side is the reference: `testdata/digest_vectors.json` is, and
// both sides assert against it.
//
// Bytes, not characters: the Zig side folds UTF-8 bytes, so this encodes
// before hashing. A key with any non-ASCII character would otherwise hash
// differently here — the same trap as the codec, in a place where the symptom
// would be an unexplained fidelity mismatch rather than mangled text.
(function () {
  if (globalThis.__interactionDigest) return;

  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = (1n << 64n) - 1n;
  const VERSION = 1;
  // Must equal MAX_INLINE_KEY in interaction_digest.zig, and be measured in
  // BYTES — a char-length check diverges on any non-ASCII key.
  const MAX_INLINE_KEY = 320;

  const enc = new TextEncoder();

  const fold = (seed, bytes) => {
    let h = seed;
    for (let i = 0; i < bytes.length; i++) {
      h = (h ^ BigInt(bytes[i])) & MASK;
      h = (h * PRIME) & MASK;
    }
    return h;
  };

  const foldValue = (s) => fold(OFFSET, typeof s === "string" ? enc.encode(s) : s);
  const tooLong = (s) => enc.encode(String(s)).length > MAX_INLINE_KEY;
  const hex16 = (h) => h.toString(16).padStart(16, "0");

  class InteractionDigest {
    constructor() {
      this.h = fold(OFFSET, new Uint8Array([VERSION]));
    }
    line(l) {
      this.h = fold(this.h, enc.encode(l));
      this.h = fold(this.h, enc.encode("\n"));
    }
    // Each element mirrors the Zig spelling exactly, including the
    // lowercase-hex formatting of folded values and the overlong-key
    // fallback — a key too long to spell inline still folds to something
    // deterministic rather than vanishing.
    kvRead(key, found, value) {
      if (tooLong(key)) return this.overlong("r", key);
      this.line(`r ${key} ${found ? 1 : 0} ${(found ? foldValue(value) : 0n).toString(16)}`);
    }
    kvPrefix(prefix, found, count, rowsFold) {
      if (tooLong(prefix)) return this.overlong("p", prefix);
      this.line(`p ${prefix} ${found ? 1 : 0} ${count} ${rowsFold.toString(16)}`);
    }
    kvWrite(key, value) {
      if (tooLong(key)) return this.overlong("w", key);
      this.line(`w ${key} ${foldValue(value).toString(16)}`);
    }
    kvDelete(key) {
      if (tooLong(key)) return this.overlong("d", key);
      this.line(`d ${key}`);
    }
    fetch(method, url, body) {
      this.line(`f ${method} ${foldValue(url).toString(16)} ${foldValue(body ?? "").toString(16)}`);
    }
    wakeArm(kind, arg, exportName) {
      if (tooLong(arg)) return this.overlong("a", String(arg));
      this.line(`a ${kind} ${arg} ${exportName}`);
    }
    streamWrite(bytes) {
      const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
      this.line(`s ${b.length} ${foldValue(b).toString(16)}`);
    }
    response(status, body) {
      this.line(`x ${status} ${foldValue(body ?? "").toString(16)}`);
    }
    overlong(tag, key) {
      this.line(`${tag}! ${foldValue(key).toString(16)}`);
    }
    hex() {
      return hex16(this.h);
    }
  }

  globalThis.__interactionDigest = {
    VERSION,
    Digest: InteractionDigest,
    foldValue: (s) => foldValue(s).toString(16),
  };
})();

// ── src/replay/js/system_recorders.js ──
;// The `_system.*` primitive layer the offline runtimes compose over — ONE
// source shared by the CLI sim (src/replay/sim_globals.zig embeds it into
// the reactor base) and the browser replay arena
// (scripts/ops/gen_replay_prelude.py folds it into arena-prelude.js).
// Neither runtime has the worker's native effect bindings, so the public
// shims in `globals/*.js` bottom out here instead.
//
// `crypto` maps onto the native crypto the replay bindings install
// (getRandomValues/randomBytes/randomUUID/sha256/hmacSha256 are real);
// streaming SHA-256, SHA-512/384 and RSA/ECDSA verify are supplied here in
// pure JS, and the slots that remain unimplemented throw a named error
// rather than returning a wrong answer — a bogus `valid:false` on a good
// token is the worst possible offline failure.
//
// The effect primitives (`http`/`after`/`blob`/`stream`/`platform`) are
// RECORDERS: they never fire, they push `{kind:…}` entries into the
// per-run sink `globalThis.__rove_effects`. Replay re-executes recorded
// inputs, so an effect that already happened live must be observed, not
// repeated. The durable verbs (`webhook`/`email`/`schedule`/`blob`) stay
// the REAL shims on top of these, so they decompose into the primitives
// that actually replicate (`_send/owed` + `_sched/*` kv rows +
// `http.fetch`) exactly as production does.
//
// Prod's synchronous argument validation is mirrored throughout, each
// check naming its Zig source — change one side, change both.
//
// The host must seed the per-run state these recorders read before each
// activation: `__rove_effects`, `__rove_fetch_seq`, `__rove_stream_bytes`,
// `__rove_blob_receive_used`, `__rove_activation_kind`, `__rove_captured`,
// `__rove_email_sends`.

;(function(){
  var nat = globalThis.crypto;
  var no = function(n){ return function(){ throw new Error("crypto." + n + " is not available in `rewind test` (the offline sim has SHA-256/HMAC + random only — no streaming sha, RSA or ECDSA)"); }; };
  // A verify path reached an alg/curve the offline sim doesn't implement.
  // THROW (a loud, declared gap) rather than return a silent `valid:false`
  // — a wrong verdict on a valid token is the worst offline failure (it
  // greens a login-rejection prod would accept). Verify those against a live
  // cluster until the sim grows the alg. Issue #45.
  var __cryptoGap = function(what){ throw new Error("crypto." + what + " is not available in `rewind test` (the offline sim implements RS256 + ES256/P-256 verify + SHA-256/HMAC only) — verify this alg against a live cluster"); };
  var push = function(e){ (globalThis.__rove_effects || (globalThis.__rove_effects = [])).push(e); };
  var b2s = function(c){ if (typeof c === "string") return c; var s = ""; for (var i = 0; i < c.length; i++) s += String.fromCharCode(c[i]); return s; };
  // ── prod's synchronous effect-argument validation, mirrored so a call
  // shape that throws live also throws offline with the same error type and
  // message (customer `catch` branches keyed on them are testable). Each
  // check names its prod source; change one side, change both. ──
  // http_b.isValidExportName (bindings/http.zig): ASCII alnum/_/$, first
  // char non-digit — gates every bound-export override ({on}/name).
  var isExportName = function(s){ return typeof s === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s); };
  // JS_ToInt64-style coercion (after.ms): ToNumber, then NaN/±Infinity → 0,
  // fraction truncated. The ToInt32 sites (randomBytes n, blob.url ttl) use
  // JS's own `| 0` — the exact ECMA ToInt32 incl. the mod-2^32 wrap prod's
  // JS_ToInt32 performs, so out-of-range wrapping accepts/rejects the same
  // values as prod.
  var toInt = function(x){ var n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; };
  // UTF-8 byte length of a string chunk / byte length of a Uint8Array —
  // the wire size prod's caps measure (surrogate pairs 4 bytes, lone 3).
  var u8len = function(s){ if (typeof s !== "string") return s.length; var n = 0; for (var i = 0; i < s.length; i++) { var cp = s.charCodeAt(i); if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) { n += 4; i++; } else if (cp < 0x80) n += 1; else if (cp < 0x800) n += 2; else n += 3; } return n; };
  // dupeJsStringOrBytes (bindings/http.zig): a fetch body is a string or
  // Uint8Array; absent (undefined) defaults — anything else (incl. null)
  // throws. Shared by http.fetch / after.fetch / http.subscribe.
  var checkFetchBody = function(o){ if (o.body !== undefined && typeof o.body !== "string" && !(o.body instanceof Uint8Array)) throw new TypeError("fetch: `body` must be a string or Uint8Array"); };
  // buildFetchRow (bindings/http.zig) — the shared unbound-fetch option
  // validation jsHttpFetch AND jsHttpSubscribe run: url required, body
  // shape, `name` identifier, `on_chunk` (module path) required. The
  // native reads ONLY `on_chunk` (the public shims lower `on` to it), so
  // no `on` fallback here. Returns the module path.
  var checkFetchOpts = function(o){
    if (typeof o.url !== "string") throw new TypeError("http.fetch requires a `url` string");
    checkFetchBody(o);
    var nm = o.name === undefined ? "" : String(o.name);
    if (nm.length > 0 && !isExportName(nm)) throw new TypeError("http.fetch: `name` must be a JS identifier (alphanumeric/underscore/$, first char non-digit)");
    if (!o.on_chunk) throw new TypeError("http.fetch: `on_chunk` (module path) is required");
    return o.on_chunk;
  };
  // The outbound rate limit (prod's per-tenant OUTBOUND budget) is armed
  // by `scenario({ emailBudget: N })` and enforced in `recFetch` below
  // (the sim's fetch chokepoint), mirroring prod's move off the retired
  // email-specific `__rove_check_email_rate` native onto the fetch
  // primitive. No bare `__rove_*` global remains — the continuation native
  // lives on `_system.continuation` below (next.js captures it at
  // base-eval; the bare `__rove_next` global is gone).
  // Streaming SHA-256 in pure JS (the portable replay engine has one-shot
  // `nat.sha256` only). Same posture as the RSA/ECDSA verify above; drives
  // `crypto.sha256Init/Update/Final` so `blob.write`/`blob.seal` (recipe
  // midstate) work offline. Final(Update*(Init())) === nat.sha256(concat) —
  // string chunks UTF-8-encoded to match nat.sha256's string handling. The
  // midstate token ("js2:" H32hex : totalLen : bufHex) is sim-internal
  // (never crosses to native) — its own format, not the worker's `s2:`.
  var K256 = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H256_0 = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var rotr = function(x, n){ return ((x >>> n) | (x << (32 - n))) >>> 0; };
  var shaCompress = function(H, blk){
    var w = new Array(64), i;
    for (i = 0; i < 16; i++) w[i] = ((blk[i*4] << 24) | (blk[i*4+1] << 16) | (blk[i*4+2] << 8) | blk[i*4+3]) >>> 0;
    for (i = 16; i < 64; i++) { var s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3); var s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10); w[i] = (((w[i-16] + s0) >>> 0) + ((w[i-7] + s1) >>> 0)) >>> 0; }
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25); var ch = (e & f) ^ ((~e) & g);
      var t1 = (((h + S1) >>> 0) + ((ch + ((K256[i] + w[i]) >>> 0)) >>> 0)) >>> 0;
      var S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22); var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d + t1) >>> 0; d=c; c=b; b=a; a=(t1 + t2) >>> 0;
    }
    H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0; H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
  };
  var shaStrU8 = function(s){ var out = [], i, cp; for (i = 0; i < s.length; i++) { cp = s.charCodeAt(i); if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length) { var lo = s.charCodeAt(i+1); if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i++; } } if (cp < 0x80) out.push(cp); else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F)); else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); } return out; };
  var shaBytes = function(d){ if (typeof d === "string") return shaStrU8(d); var out = [], i; for (i = 0; i < d.length; i++) out.push(d[i] & 0xff); return out; };
  var hx8 = function(x){ return ("00000000" + (x >>> 0).toString(16)).slice(-8); };
  var hx2 = function(x){ return ("0" + (x & 0xff).toString(16)).slice(-2); };
  // Emit the WORKER's `s2:` wire format (bindings/crypto.zig midstateToToken):
  // "s2:" + base64url_no_pad( 8×u32 BE state ‖ u64 BE total_len ‖ u8 buf_len
  // ‖ buf ). So a sim-produced midstate round-trips into prod-shaped fixtures.
  // shaParse ALSO decodes it (and keeps reading the legacy "js2:" hex form
  // for old worlds), so a prod-captured world whose kv carries an `s2:` token
  // replays offline (issue #47).
  var shaSer = function(st){ var raw = [], i, w; for (i = 0; i < 8; i++){ w = st.h[i] >>> 0; raw.push((w>>>24)&0xff,(w>>>16)&0xff,(w>>>8)&0xff,w&0xff); } var len = st.len, hi = Math.floor(len/0x100000000), lo = len%0x100000000; raw.push(Math.floor(hi/0x1000000)%256, Math.floor(hi/0x10000)%256, Math.floor(hi/0x100)%256, hi%256, Math.floor(lo/0x1000000)%256, Math.floor(lo/0x10000)%256, Math.floor(lo/0x100)%256, lo%256); raw.push(st.buf.length & 0xff); for (i = 0; i < st.buf.length; i++) raw.push(st.buf[i] & 0xff); return "s2:" + globalThis.base64url.encode(new Uint8Array(raw)); };
  var shaParse = function(tok){ if (typeof tok !== "string") throw new Error("crypto.sha256: invalid midstate token"); var h = [], buf = [], i, len; if (tok.indexOf("s2:") === 0){ var raw = globalThis.base64url.decode(tok.slice(3)); if (raw.length < 41) throw new Error("crypto.sha256: invalid midstate token"); for (i = 0; i < 8; i++) h.push(((raw[i*4]<<24)|(raw[i*4+1]<<16)|(raw[i*4+2]<<8)|raw[i*4+3])>>>0); len = 0; for (i = 32; i < 40; i++) len = len*256 + raw[i]; var bl = raw[40]; for (i = 0; i < bl; i++) buf.push(raw[41+i]); return { h: h, len: len, buf: buf }; } if (tok.indexOf("js2:") === 0){ var p = tok.slice(4).split(":"); var hs = p[0], bh = p[2] || ""; len = Number(p[1]); for (i = 0; i < 8; i++) h.push(parseInt(hs.substr(i*8, 8), 16) >>> 0); for (i = 0; i < bh.length; i += 2) buf.push(parseInt(bh.substr(i, 2), 16)); return { h: h, len: len, buf: buf }; } throw new Error("crypto.sha256: invalid midstate token"); };
  var shaInit = function(){ return shaSer({ h: H256_0.slice(), len: 0, buf: [] }); };
  var shaUpdate = function(tok, data){ var st = shaParse(tok); var bytes = shaBytes(data); var buf = st.buf.concat(bytes); var i = 0; while (buf.length - i >= 64) { shaCompress(st.h, buf.slice(i, i + 64)); i += 64; } st.buf = buf.slice(i); st.len += bytes.length; return shaSer(st); };
  var shaFinal = function(tok){ var st = shaParse(tok); var buf = st.buf.slice(); buf.push(0x80); while (buf.length % 64 !== 56) buf.push(0x00); var bitHi = Math.floor(st.len / 0x20000000), bitLo = (st.len * 8) >>> 0; buf.push((bitHi >>> 24) & 0xff, (bitHi >>> 16) & 0xff, (bitHi >>> 8) & 0xff, bitHi & 0xff, (bitLo >>> 24) & 0xff, (bitLo >>> 16) & 0xff, (bitLo >>> 8) & 0xff, bitLo & 0xff); for (var i = 0; i < buf.length; i += 64) shaCompress(st.h, buf.slice(i, i + 64)); var out = ""; for (i = 0; i < 8; i++) out += hx8(st.h[i]); return out; };
  // SHA-512 / SHA-384 one-shot (BigInt 64-bit words) — the portable engine
  // has native sha256 only. Drives RS384/RS512 verify (and ES384/512 later).
  // Round constants + IVs are FIPS 180-4; the compress loop mirrors sha256's
  // but over 64-bit words with the 512 rotation schedule. `bytes` is a byte
  // array (shaBytes UTF-8-encodes a string, matching nat.sha256).
  var __M64 = (1n << 64n) - 1n;
  var rotr64 = function(x, n){ var b = BigInt(n); return ((x >> b) | (x << (64n - b))) & __M64; };
  var K512 = [0x428a2f98d728ae22n,0x7137449123ef65cdn,0xb5c0fbcfec4d3b2fn,0xe9b5dba58189dbbcn,0x3956c25bf348b538n,0x59f111f1b605d019n,0x923f82a4af194f9bn,0xab1c5ed5da6d8118n,0xd807aa98a3030242n,0x12835b0145706fben,0x243185be4ee4b28cn,0x550c7dc3d5ffb4e2n,0x72be5d74f27b896fn,0x80deb1fe3b1696b1n,0x9bdc06a725c71235n,0xc19bf174cf692694n,0xe49b69c19ef14ad2n,0xefbe4786384f25e3n,0x0fc19dc68b8cd5b5n,0x240ca1cc77ac9c65n,0x2de92c6f592b0275n,0x4a7484aa6ea6e483n,0x5cb0a9dcbd41fbd4n,0x76f988da831153b5n,0x983e5152ee66dfabn,0xa831c66d2db43210n,0xb00327c898fb213fn,0xbf597fc7beef0ee4n,0xc6e00bf33da88fc2n,0xd5a79147930aa725n,0x06ca6351e003826fn,0x142929670a0e6e70n,0x27b70a8546d22ffcn,0x2e1b21385c26c926n,0x4d2c6dfc5ac42aedn,0x53380d139d95b3dfn,0x650a73548baf63den,0x766a0abb3c77b2a8n,0x81c2c92e47edaee6n,0x92722c851482353bn,0xa2bfe8a14cf10364n,0xa81a664bbc423001n,0xc24b8b70d0f89791n,0xc76c51a30654be30n,0xd192e819d6ef5218n,0xd69906245565a910n,0xf40e35855771202an,0x106aa07032bbd1b8n,0x19a4c116b8d2d0c8n,0x1e376c085141ab53n,0x2748774cdf8eeb99n,0x34b0bcb5e19b48a8n,0x391c0cb3c5c95a63n,0x4ed8aa4ae3418acbn,0x5b9cca4f7763e373n,0x682e6ff3d6b2b8a3n,0x748f82ee5defb2fcn,0x78a5636f43172f60n,0x84c87814a1f0ab72n,0x8cc702081a6439ecn,0x90befffa23631e28n,0xa4506cebde82bde9n,0xbef9a3f7b2c67915n,0xc67178f2e372532bn,0xca273eceea26619cn,0xd186b8c721c0c207n,0xeada7dd6cde0eb1en,0xf57d4f7fee6ed178n,0x06f067aa72176fban,0x0a637dc5a2c898a6n,0x113f9804bef90daen,0x1b710b35131c471bn,0x28db77f523047d84n,0x32caab7b40c72493n,0x3c9ebe0a15c9bebcn,0x431d67c49c100d4cn,0x4cc5d4becb3e42b6n,0x597f299cfc657e2an,0x5fcb6fab3ad6faecn,0x6c44198c4a475817n];
  var H512_0 = [0x6a09e667f3bcc908n,0xbb67ae8584caa73bn,0x3c6ef372fe94f82bn,0xa54ff53a5f1d36f1n,0x510e527fade682d1n,0x9b05688c2b3e6c1fn,0x1f83d9abfb41bd6bn,0x5be0cd19137e2179n];
  var H384_0 = [0xcbbb9d5dc1059ed8n,0x629a292a367cd507n,0x9159015a3070dd17n,0x152fecd8f70e5939n,0x67332667ffc00b31n,0x8eb44a8768581511n,0xdb0c2e0d64f98fa7n,0x47b5481dbefa4fa4n];
  var __sim_sha512 = function(bytes, is384){ var H = (is384 ? H384_0 : H512_0).slice(); var msg = bytes.slice(); var bitLen = BigInt(bytes.length) * 8n; msg.push(0x80); while (msg.length % 128 !== 112) msg.push(0); for (var i = 15; i >= 0; i--) msg.push(Number((bitLen >> BigInt(i*8)) & 0xffn)); for (var off = 0; off < msg.length; off += 128){ var w = new Array(80), t, x, j; for (t = 0; t < 16; t++){ x = 0n; for (j = 0; j < 8; j++) x = (x << 8n) | BigInt(msg[off+t*8+j]); w[t] = x; } for (t = 16; t < 80; t++){ var s0 = rotr64(w[t-15],1) ^ rotr64(w[t-15],8) ^ (w[t-15] >> 7n); var s1 = rotr64(w[t-2],19) ^ rotr64(w[t-2],61) ^ (w[t-2] >> 6n); w[t] = (w[t-16] + s0 + w[t-7] + s1) & __M64; } var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7]; for (t = 0; t < 80; t++){ var S1 = rotr64(e,14) ^ rotr64(e,18) ^ rotr64(e,41); var ch = (e & f) ^ ((~e & __M64) & g); var t1 = (h + S1 + ch + K512[t] + w[t]) & __M64; var S0 = rotr64(a,28) ^ rotr64(a,34) ^ rotr64(a,39); var maj = (a & b) ^ (a & c) ^ (b & c); var t2 = (S0 + maj) & __M64; h=g; g=f; f=e; e=(d+t1)&__M64; d=c; c=b; b=a; a=(t1+t2)&__M64; } H[0]=(H[0]+a)&__M64; H[1]=(H[1]+b)&__M64; H[2]=(H[2]+c)&__M64; H[3]=(H[3]+d)&__M64; H[4]=(H[4]+e)&__M64; H[5]=(H[5]+f)&__M64; H[6]=(H[6]+g)&__M64; H[7]=(H[7]+h)&__M64; } var nwords = is384 ? 6 : 8, out = []; for (i = 0; i < nwords; i++) for (j = 7; j >= 0; j--) out.push(Number((H[i] >> BigInt(j*8)) & 0xffn)); return out; };
  var __bytesBig = function(b){ var x = 0n; for (var i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]); return x; };
  // RS256/384/512 verify (RSASSA-PKCS1-v1.5) in pure JS over BigInt — the
  // common OIDC algs. Portable (no OpenSSL). ECDSA below.
  var __sim_verifyRsa = function(jwk, alg, data, sig){
    var a = (alg || "sha256").toLowerCase();
    if (a !== "sha256" && a !== "sha384" && a !== "sha512") __cryptoGap("verifyRsa(" + a + ")");
    try {
      if (!jwk || jwk.kty !== "RSA") return false;
      var b64u = globalThis.base64url;
      var toBig = function(b){ var x = 0n; for (var i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]); return x; };
      var n = toBig(b64u.decode(jwk.n)), e = toBig(b64u.decode(jwk.e));
      var sb = (typeof sig === "string") ? b64u.decode(sig) : sig;
      var s = toBig(sb);
      if (s >= n) return false;
      var r = 1n, base = s % n, ee = e;
      while (ee > 0n){ if (ee & 1n) r = (r * base) % n; ee >>= 1n; base = (base * base) % n; }
      var klen = 0, nn = n; while (nn > 0n){ nn >>= 8n; klen++; }
      var em = new Uint8Array(klen), mm = r;
      for (var i2 = klen - 1; i2 >= 0; i2--){ em[i2] = Number(mm & 0xffn); mm >>= 8n; }
      if (em[0] !== 0x00 || em[1] !== 0x01) return false;
      var p = 2; while (p < em.length && em[p] === 0xff) p++;
      if (em[p] !== 0x00) return false; p++;
      // DigestInfo: the PKCS#1-v1.5 ASN.1 prefix + the digest, per alg
      // (RFC 8017). sha384/512 hash via the pure-JS __sim_sha512.
      var hash, PFX;
      if (a === "sha384") { hash = __sim_sha512(shaBytes(data), true); PFX = [0x30,0x41,0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x02,0x05,0x00,0x04,0x30]; }
      else if (a === "sha512") { hash = __sim_sha512(shaBytes(data), false); PFX = [0x30,0x51,0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x03,0x05,0x00,0x04,0x40]; }
      else { var hex = nat.sha256(data); hash = []; for (var j = 0; j < 32; j++) hash.push(parseInt(hex.substr(j*2, 2), 16)); PFX = [0x30,0x31,0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01,0x05,0x00,0x04,0x20]; }
      if (em.length - p !== PFX.length + hash.length) return false;
      for (var k = 0; k < PFX.length; k++) if (em[p + k] !== PFX[k]) return false;
      for (var k2 = 0; k2 < hash.length; k2++) if (em[p + PFX.length + k2] !== hash[k2]) return false;
      return true;
    } catch (_) { return false; }
  };
  // ES256/384/512 verify (ECDSA P-256/P-384/P-521 + SHA-256/384/512) in pure
  // JS over BigInt. Point math uses Jacobian coordinates (a = -3, shared by
  // every NIST P-curve) so the whole verify costs ONE modular inverse at the
  // end. Accepts JWS raw r||s (2·flen bytes) or DER. The digest is chosen by
  // `alg`, the curve by the jwk's `crv`.
  var __sim_verifyEcdsa = function(jwk, alg, data, sig){
    var a = (alg || "sha256").toLowerCase();
    var crv = jwk && jwk.crv;
    // Digest → e, by alg. sha384/512 via the pure-JS __sim_sha512.
    var digestE;
    if (a === "sha256") digestE = function(){ return BigInt("0x" + nat.sha256(data)); };
    else if (a === "sha384") digestE = function(){ return __bytesBig(__sim_sha512(shaBytes(data), true)); };
    else if (a === "sha512") digestE = function(){ return __bytesBig(__sim_sha512(shaBytes(data), false)); };
    else __cryptoGap("verifyEcdsa(" + a + ")");
    // Curve params, by crv (a = p-3 for all). flen = field byte length (the
    // raw r||s half-width). Unknown curve → loud gap.
    var C;
    if (crv === "P-256") C = { p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn, n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n, Gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, Gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n, flen: 32 };
    else if (crv === "P-384") C = { p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn, n: 0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n, Gx: 0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n, Gy: 0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn, flen: 48 };
    else if (crv === "P-521") C = { p: 0x1ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn, n: 0x1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409n, Gx: 0xc6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n, Gy: 0x11839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n, flen: 66 };
    else __cryptoGap("verifyEcdsa(crv=" + String(crv) + ")");
    try {
      if (!jwk || jwk.kty !== "EC") return false;
      var b64u = globalThis.base64url;
      var toBig = __bytesBig;
      var p = C.p, n = C.n, Gx = C.Gx, Gy = C.Gy, flen = C.flen;
      var acurve = p - 3n;
      var mod = function(x, m){ x %= m; return x < 0n ? x + m : x; };
      var inv = function(x, m){ var r = 1n, b = mod(x, m), e = m - 2n; while (e > 0n){ if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; };
      // Jacobian point [X, Y, Z]; Z === 0n is the point at infinity.
      var jdbl = function(P){
        if (P[2] === 0n || P[1] === 0n) return [0n, 0n, 0n];
        var YY = (P[1] * P[1]) % p; var S = mod(4n * P[0] * YY, p); var ZZ = (P[2] * P[2]) % p;
        var M = mod(3n * P[0] * P[0] + acurve * ZZ % p * ZZ, p);
        var X3 = mod(M * M - 2n * S, p);
        return [X3, mod(M * (S - X3) - 8n * YY % p * YY, p), mod(2n * P[1] * P[2], p)];
      };
      var jadd = function(P, Q){
        if (P[2] === 0n) return Q; if (Q[2] === 0n) return P;
        var Z1Z1 = (P[2] * P[2]) % p, Z2Z2 = (Q[2] * Q[2]) % p;
        var U1 = mod(P[0] * Z2Z2, p), U2 = mod(Q[0] * Z1Z1, p);
        var S1 = mod(P[1] * Q[2] % p * Z2Z2, p), S2 = mod(Q[1] * P[2] % p * Z1Z1, p);
        if (U1 === U2){ if (S1 !== S2) return [0n, 0n, 0n]; return jdbl(P); }
        var H = mod(U2 - U1, p); var I = mod(2n * H % p * (2n * H), p); var J = mod(H * I, p);
        var rr = mod(2n * (S2 - S1), p); var V = mod(U1 * I, p);
        var X3 = mod(rr * rr - J - 2n * V, p);
        var ZS = mod(P[2] + Q[2], p);
        return [X3, mod(rr * (V - X3) - 2n * S1 % p * J, p), mod((ZS * ZS % p - Z1Z1 - Z2Z2) * H, p)];
      };
      var jmul = function(k, P){ var R = [0n, 0n, 0n]; k = mod(k, n); while (k > 0n){ if (k & 1n) R = jadd(R, P); P = jdbl(P); k >>= 1n; } return R; };
      var Q = [toBig(b64u.decode(jwk.x)), toBig(b64u.decode(jwk.y)), 1n];
      var sb = (typeof sig === "string") ? b64u.decode(sig) : sig;
      var r, s;
      if (sb.length === 2 * flen){ r = toBig(sb.slice(0, flen)); s = toBig(sb.slice(flen, 2 * flen)); }
      else if (sb[0] === 0x30){ var i = 2; if (sb[1] & 0x80) i = 2 + (sb[1] & 0x7f); var rl = sb[i + 1]; r = toBig(sb.slice(i + 2, i + 2 + rl)); i = i + 2 + rl; var sl = sb[i + 1]; s = toBig(sb.slice(i + 2, i + 2 + sl)); }
      else return false;
      if (r <= 0n || r >= n || s <= 0n || s >= n) return false;
      var e = digestE();
      var w = inv(s, n);
      var R = jadd(jmul(mod(e * w, n), [Gx, Gy, 1n]), jmul(mod(r * w, n), Q));
      if (R[2] === 0n) return false;
      var zi = inv(R[2], p);
      return mod(mod(R[0] * zi % p * zi, p), n) === r;
    } catch (_) { return false; }
  };
  // Offline OIDC provider signing (issue #46). Real RSA keygen is slow +
  // complex offline, so oidcGenerateKey returns a FIXED deterministic 2048-bit
  // dev key — the determinism contract is same run → same signatures
  // (replay-exact). The kid derives from the key so it's stable; a
  // keyset/rotation flow reuses this material (realistic enough for
  // provider-mode round-trip tests offline). `priv` is a sim-internal JSON
  // blob {n,d} — oidcGenerateKey/oidcSign are the only producer/consumer.
  var __OIDC_N = "sk2buuLi4Pv9BoOsn8-0m6TBjKbIDpa54s2JKccxMROnshPPL65yjeV9w7kkeRsXMslRfqwzR4KuOHjoPhhZUje5rmEEiZ5ewP-DB2nES3MLYN5nyA6Cr4-VriOyRQaYYFjWox8N-_d0z_DEEicwJud0sgQPNQltgeglNP4a64TbEZD4E20VnP6LjUXIqfG5_qSeIf9-VZoVFg08tH8K56gQwU9w4dPysMj_jySPev7oTqS7pbrM_J663f9x43ZQRn1cMjXQWCfJp9F6k-Eu4ov0iSu8_gIJWGQA46Sc8nVopsqnTPDu3e9YgU4BddaEBs8ybtKJkYkqSQ840Uj23w";
  var __OIDC_E = "AQAB";
  var __OIDC_D = "GVAbQ7TiML6VdU9MOoPqSA5jy-wBitCrIx-60UuOGEGKFSXqzAIgETT7XcXy_55w9KzP_QPFY-mRgkLn9ajPRXTTz4XGdyMcoJmlqG_DhlKW0vHAGg61Tuc7gLVgoZwGFeeG0TGfcp32325253zYwS0qy_r3jbgA6-hhH9zTRYwiRBPZ9ZhHVLyzMbTEEUmENqnNGgmY4vA3jUH0GW0Npaf2g8eQglfViniOo8t3DIMCA8faED3I_nTvThShBEy0Hfz5vPcWR9TvzHvM_5pK1gTslbpIvDaGaRjMzA2PGU3k-4FiFGK1SNGT5tSkRO4CfonydW_I9xNGD3wmYXyTwQ";
  var __OIDC_KID = "sim-rsa-" + nat.sha256(__OIDC_N).slice(0, 16);
  var __oidcGenerateKey = function(){ return { priv: JSON.stringify({ n: __OIDC_N, d: __OIDC_D }), jwk: { kty: "RSA", n: __OIDC_N, e: __OIDC_E, kid: __OIDC_KID, use: "sig", alg: "RS256" }, kid: __OIDC_KID }; };
  // RSASSA-PKCS1-v1.5 sign (RS256) over BigInt: EM = 00 01 FF..FF 00 ‖
  // DigestInfo(SHA-256(signingInput)); sig = EM^d mod n; return base64url.
  var __oidcSign = function(priv, signingInput){ var pk = (typeof priv === "string" && priv.charAt(0) === "{") ? JSON.parse(priv) : null; if (!pk || !pk.n || !pk.d) throw new Error("crypto.oidcSign: private key not from crypto.oidcGenerateKey (the offline sim uses its own key format)"); var b64u = globalThis.base64url; var n = __bytesBig(b64u.decode(pk.n)), d = __bytesBig(b64u.decode(pk.d)); var klen = 0, nn = n; while (nn > 0n){ nn >>= 8n; klen++; } var hex = nat.sha256(signingInput); var T = [0x30,0x31,0x30,0x0d,0x06,0x09,0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x01,0x05,0x00,0x04,0x20]; for (var i = 0; i < 32; i++) T.push(parseInt(hex.substr(i*2,2),16)); var em = [0x00, 0x01]; var padLen = klen - 3 - T.length; for (i = 0; i < padLen; i++) em.push(0xff); em.push(0x00); for (i = 0; i < T.length; i++) em.push(T[i]); var m = __bytesBig(em); var r = 1n, base = m % n, ee = d; while (ee > 0n){ if (ee & 1n) r = (r * base) % n; ee >>= 1n; base = (base * base) % n; } var sig = new Uint8Array(klen), mm = r; for (i = klen - 1; i >= 0; i--){ sig[i] = Number(mm & 0xffn); mm >>= 8n; } return b64u.encode(sig); };
  // Per-instance / root kv isolation for `platform.*`. Each store namespaces
  // its keys under `__rove_store/{tag}/` in the one closed-world map, so a
  // scoped or root write never collides with the tenant's own kv (or another
  // instance's). The facade pushes CLEAN store-tagged effect entries; the
  // epilogue kv wrapper skips recording and hides the namespaced keys, so a
  // tenant read / prefix scan never sees another store.
  var NS_STORE = "__rove_store/";
  var storeKv = function(P, tag){
    return {
      get: function(k){ var v = globalThis.kv.get(P + k); push({ kind: "read", store: tag, key: k, present: v !== undefined && v !== null }); return v; },
      set: function(k, val){ push({ kind: "write", store: tag, key: k, value: val }); return globalThis.kv.set(P + k, val); },
      delete: function(k){ push({ kind: "delete", store: tag, key: k }); return globalThis.kv.delete(P + k); },
      prefix: function(p, cursor, limit){ var r = globalThis.kv.prefix(P + (p || ""), cursor, limit); push({ kind: "read", op: "prefix", store: tag, key: (p || "") }); return (r || []).map(function(e){ return { key: e.key.slice(P.length), value: e.value }; }); },
    };
  };
  // platform.* is admin-only (prod: throws off the `__admin__` handler). Fail
  // closed — every sync method is gated unless the run is flagged admin
  // (`scenario({ admin: true })` → the hidden `__rove_store/admin` key). Note
  // `platform.compile` is NOT gated here: it lowers to a bound fetch (via the
  // real platform.js over `_system.after`), admin-checked door-side in prod.
  var GATE_MSG = "platform is only available on the admin handler";
  var gate = function(fn){ return function(){ if (globalThis.kv.get(NS_STORE + "admin") !== "1") throw new TypeError(GATE_MSG); return fn.apply(null, arguments); }; };
  var rootStore_r = storeKv(NS_STORE + "r/", "r");
  // Fetch/subscribe recorder. Ids are unique per run (`ftch_<seq>` — the
  // epilogue resets the counter each activation), NOT prod's ftch_<64hex>:
  // determinism over realism, but distinct so a handler can correlate the
  // returned id with the `request.fetchId` its resume observes.
  // The effect entry carries the FULL option bag prod reads
  // (http.zig buildFetchRow), defaults applied, in the PUBLIC spellings
  // (timeoutMs/maxChunkBytes/maxTotalBytes — this recorder sits under the
  // after.js/http.js shims, which already lowered them to the native
  // snake_case, so translate back) — so `toHaveSent("fetch", { headers,
  // stream, timeoutMs, … })` matches what the handler wrote and `.not.`
  // variants aren't vacuous.
  var nextSeq = function(){ return (globalThis.__rove_fetch_seq = (globalThis.__rove_fetch_seq || 0) + 1); };
  // `bound` distinguishes the connection-scoped `after.fetch` (binds to the
  // held socket or is DROPPED at the success seam — http.zig jsOnFetch)
  // from the unbound `http.fetch` primitive (fires regardless — what
  // webhook.send/blob compose on). The epilogue's drop-tagging pass and the
  // harness's fetchesPending count both key on it.
  var recFetch = function(url, o, on, bound){
    // Outbound rate limit — prod enforces a per-tenant OUTBOUND budget at
    // the fetch primitive (bindings/http.zig `outboundRateOk`): every
    // customer-initiated egress (on.fetch / http.fetch / the immediate
    // fire of webhook.send / email.send) shares one bucket. Offline the
    // bucket is UNMETERED by default; `scenario({ emailBudget: N })` arms
    // a per-activation allowance (hidden reserved kv key) so the N+1-th
    // outbound in a run throws prod's exact Error{code:"rate_limited"} and
    // the customer's `catch (e){ e.code === "rate_limited" }` branch is
    // testable. Enforced HERE (the shared recorder = the sim's fetch
    // chokepoint) so a rejected send throws before its durable _send/owed
    // marker is recorded — mirroring prod's fetch-before-marker order. The
    // epilogue resets the per-activation counter.
    // Platform-internal doors (`*.internal` — blob/compose/platform/logs
    // storage + control-plane I/O) are exempt, matching prod's
    // `targetsInternalDoor` (bindings/http.zig) — they aren't third-party
    // egress.
    var __isInternal = (function(u){ var s = String(u || "").indexOf("://"); if (s < 0) return false; var a = String(u).slice(s + 3); var h = a.split(/[\/:?#]/)[0]; return h.slice(-9) === ".internal"; })(url);
    var __ob = __isInternal ? null : globalThis.kv.get("__rove_store/email_budget");
    if (__ob !== undefined && __ob !== null) {
      var __n = Number(__ob);
      if (Number.isFinite(__n)) {
        var __used = globalThis.__rove_email_sends || 0;
        if (__used >= __n) { var __e = new Error("outbound rate limit exceeded, retry after 1s"); __e.code = "rate_limited"; throw __e; }
        globalThis.__rove_email_sends = __used + 1;
      }
    }
    var id = "ftch_" + nextSeq();
    push({ kind: "fetch", id: id, url: url, bound: !!bound, method: (o && o.method) || "GET",
      body: (o && o.body !== undefined) ? o.body : null,
      headers: (o && o.headers) || {},
      ctx: (o && o.ctx !== undefined) ? o.ctx : null,
      on: on || null,
      stream: !!(o && o.stream),
      timeoutMs: (o && o.timeout_ms != null) ? o.timeout_ms : 30000,
      maxChunkBytes: (o && o.max_response_chunk_bytes != null) ? o.max_response_chunk_bytes : 262144,
      maxTotalBytes: (o && o.max_total_response_bytes != null) ? o.max_total_response_bytes : 52428800 });
    return id;
  };
  globalThis._system = {
    // The park/continue native (`next.js` captures this at base-eval).
    // Mirrors the worker's disposition: target "" = same-module;
    // non-empty = cross-module re-entry — the worker parks the target
    // as the continuation's path and dispatches every later resume on
    // the held chain there, so the epilogue surfaces it on the bundle
    // (`target`) and the harness resume folds re-enter it
    // (`heldEntry`). `fn` is the native's optional named-export
    // override (`next(path, { fn?, ctx? })`), carried for the same
    // reason.
    continuation: {
      next: function(target, o){ return { __rove_disposition: "next", target: (target ? target : null), fn: (o && typeof o.fn === "string") ? o.fn : null, ctx: (o && o.ctx !== undefined) ? o.ctx : null }; },
    },
    crypto: {
      getRandomValues: function(a){ return nat.getRandomValues(a); },
      // jsCryptoRandomBytes (bindings/crypto.zig): ToInt32(n) ∈ [0, 65536].
      randomBytes: function(n){ var v = Number(n) | 0; if (v < 0 || v > 65536) throw new RangeError("crypto.randomBytes: n must be in [0, 65536]"); return nat.randomBytes(v); },
      randomUUID: function(){ return nat.randomUUID(); },
      sha256: function(d){ return nat.sha256(d); },
      hmacSha256: function(k,d){ return nat.hmacSha256(k,d); },
      sha256Init: function(){ return shaInit(); },
      sha256Update: function(t,d){ return shaUpdate(t,d); },
      sha256Final: function(t){ return shaFinal(t); },
      verifyRsa: function(jwk, alg, data, sig){ return __sim_verifyRsa(jwk, alg, data, sig); },
      verifyEcdsa: function(jwk, alg, data, sig){ return __sim_verifyEcdsa(jwk, alg, data, sig); },
      ecdsaGenerateKey: no("ecdsaGenerateKey"), ecdsaSign: no("ecdsaSign"), ecdsaVerify: no("ecdsaVerify"),
      oidcGenerateKey: function(){ return __oidcGenerateKey(); }, oidcSign: function(priv, si){ return __oidcSign(priv, si); },
    },
    http: {
      // Validation mirrors jsHttpFetch → buildFetchRow (bindings/http.zig).
      fetch: function(o){
        if (o === null || o === undefined || typeof o !== "object") throw new TypeError("http.fetch requires an options object");
        return recFetch(o.url, o, checkFetchOpts(o), false);
      },
      cancelFetch: function(){},
      // jsHttpSubscribe reuses buildFetchRow, so the inner throws keep the
      // http.fetch spelling — matched verbatim.
      subscribe: function(o){
        if (o === null || o === undefined || typeof o !== "object") throw new TypeError("http.subscribe requires an options object");
        var oc = checkFetchOpts(o);
        // A held subscription reuses buildFetchRow (http.zig jsHttpSubscribe),
        // so record the FULL option bag prod reads — minus timeout_ms/stream
        // (held transfers always stream and never time out). Public spellings,
        // like recFetch, so `toHaveSent("subscribe", { headers, maxChunkBytes,
        // … })` matches and `.not.` isn't vacuous.
        var id = "sub_" + nextSeq();
        push({ kind: "subscribe", id: id, url: o.url, method: (o && o.method) || "GET",
          body: (o && o.body !== undefined) ? o.body : null,
          headers: (o && o.headers) || {},
          ctx: (o && o.ctx !== undefined) ? o.ctx : null,
          on: oc,
          maxChunkBytes: (o && o.max_response_chunk_bytes != null) ? o.max_response_chunk_bytes : 262144,
          maxTotalBytes: (o && o.max_total_response_bytes != null) ? o.max_total_response_bytes : 52428800 });
        return id;
      },
      cancelSubscription: function(){},
    },
    after: {
      // `on` is the ONE spelling end to end — the after.js shim passes the
      // opts bag through and the worker bindings read `opts.on` the same way.
      // Validation mirrors jsOnFetch/buildOnFetchRow: url string required;
      // the bound `{on}` must be a bare identifier (a `/` or `.` module
      // path is rejected at issue time — cross-module continuations are
      // webhook.send's `on`, not a bound fetch's).
      fetch: function(url, o){
        if (typeof url !== "string") throw new TypeError("after.fetch(url, opts?) requires a url string");
        o = o || {};
        checkFetchBody(o);
        var onv = o.on === undefined ? "" : String(o.on);
        if (onv.length > 0 && !isExportName(onv)) throw new TypeError("after.fetch: `on` must be a JS identifier (alphanumeric/underscore/$, first char non-digit)");
        return recFetch(url, o, o.on || null, true);
      },
      // jsOnKv: string prefix required. jsOnTimer: ToInt64(ms) must be > 0
      // (so undefined/NaN/0/negative/fractional-below-1 all throw) — with
      // JS_ToInt64's mod-2^64 wrap, so an overflowing delay (≥ 2^63 wraps
      // negative) throws here exactly as live.
      kv: function(prefix, o){ if (typeof prefix !== "string") throw new TypeError("after.kv(prefix, opts?) requires a string prefix"); push({ kind: "kv-wake", prefix: prefix, on: (o && o.on) || null }); },
      timer: function(ms, o){ ms = Number(BigInt.asIntN(64, BigInt(toInt(ms)))); if (ms <= 0) throw new TypeError("after.ms(ms): ms must be > 0"); push({ kind: "timer", ms: ms, on: (o && o.on) || null }); },
    },
    blob: {
      // jsBlobPresign (bindings/blob.zig): hash = 64 lowercase hex; a
      // present ttl must land in 1..604800 after ToInt32.
      presign: function(hash, ttl, ct){
        if (typeof hash !== "string") throw new TypeError("blob.url requires a hash string");
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new TypeError("blob.url: hash must be 64 lowercase hex chars");
        if (ttl !== undefined && ttl !== null) { var t = Number(ttl) | 0; if (t < 1 || t > 604800) throw new TypeError("blob.url: ttl must be 1..604800 seconds"); }
        return "https://sim.invalid/blob/" + hash + (ttl != null ? "?ttl=" + ttl : "");
      },
      write: function(){}, seal: function(){ return {}; },
      // `blob.receive(on)` (own-tenant) and `platform.scope(id).blob.receive`
      // (which lowers to `receive(on, id, JSON.stringify(ctx))`) both bottom
      // out here. Record `scope` + the issue-time `app` ctx so a
      // `.receive().stored({...})` continuation can echo `app` back exactly
      // as `emitTerminal` does (`request.ctx = {hash, len, app}`).
      // jsBlobReceive gates, in prod's order: onHeaders-only (the body is
      // still at the door), once per request (a receive consumes THE
      // body), then the `on` export-name checks. The epilogue stamps
      // `__rove_activation_kind` and resets the once-gate per run.
      receive: function(on, scope, appJson){
        if (globalThis.__rove_activation_kind !== "inbound_headers") throw new TypeError("blob.receive: only callable from an onHeaders activation");
        if (globalThis.__rove_blob_receive_used) throw new TypeError("blob.receive: already called for this request (one inbound body)");
        if (typeof on !== "string" || !on.length) throw new TypeError("blob.receive requires an `on` export name");
        if (!isExportName(on)) throw new TypeError("blob.receive: `on` must be a JS identifier");
        globalThis.__rove_blob_receive_used = true;
        var app = null; if (appJson !== undefined && appJson !== null) { try { app = JSON.parse(appJson); } catch (_) { app = null; } } push({ kind: "blob", op: "receive", on: on, scope: (scope !== undefined ? scope : null), app: app });
      },
    },
    stream: {
      start: function(){},
      // jsStreamWrite (bindings/stream.zig): chunk must be a string or
      // Uint8Array (no String() fallback — "[object Object]" must never
      // ship as a wire chunk), and one activation's cumulative writes are
      // capped at StreamChunks.QUEUE_HARD_CAP (4 MiB) — a synchronous
      // flood throws; paginate with next(). The epilogue resets the
      // per-activation counter.
      write: function(c){
        if (typeof c !== "string" && !(c instanceof Uint8Array)) throw new TypeError("stream.write: chunk must be a string or Uint8Array");
        var prev = globalThis.__rove_stream_bytes || 0;
        // UTF-8 length ≥ UTF-16 code-unit count, so an over-cap chunk can be
        // rejected on .length alone; the per-char scan only runs for chunks
        // that could fit, and an all-ASCII chunk short-circuits via one
        // native regex test (its UTF-8 length IS .length).
        var nbytes = (typeof c !== "string" || !/[^\x00-\x7F]/.test(c)) ? c.length
          : (prev + c.length > 4194304 ? c.length : u8len(c));
        var tot = prev + nbytes;
        if (tot > 4194304) throw new RangeError("stream.write: too many bytes buffered in one activation; emit fewer per activation and continue with next()");
        globalThis.__rove_stream_bytes = tot;
        // `bytes` is the WIRE size (what the cap counts and prod ships).
        push({ kind: "stream", bytes: nbytes, data: b2s(c) });
      },
    },
    platform: {
      // scope(id).kv → instance `id`'s isolated store; `blob` is a bare object
      // the real platform.js augments (receive/get). root → the __root__ store.
      // Each is admin-gated (see `gate` above); the returned scope/root handle
      // is then a granted capability (its ops aren't re-checked).
      // jsPlatformScope (globals.zig): id required + non-empty (ToString
      // coerced), and the instance must RESOLVE — prod throws
      // Error{code:"InstanceNotFound"} at the call site for a ghost id.
      // Known offline = declared via `scenario({instances})` or created by
      // `instances.create` this run (both set the hidden exists marker).
      scope: gate(function(id){
        if (id === undefined) throw new TypeError("platform.scope requires (instance_id)");
        id = String(id);
        if (!id.length) throw new TypeError("platform.scope: instance_id must be non-empty");
        // The exists marker is harness-seeded, so a CAPTURED tape (which
        // carries no scenario) skips the resolve check — the tape already
        // proves the instance resolved live.
        if (!globalThis.__rove_captured && globalThis.kv.get(NS_STORE + "exists/i/" + id) !== "1") { var e = new Error("instance not found"); e.code = "InstanceNotFound"; throw e; }
        push({ kind: "platform", op: "scope", id: id });
        return { kv: storeKv(NS_STORE + "i/" + id + "/", "i/" + id), blob: {} };
      }),
      root: { get: gate(rootStore_r.get), set: gate(rootStore_r.set), delete: gate(rootStore_r.delete), prefix: gate(rootStore_r.prefix) },
      // instances.create records the exists marker as a STORE-TAGGED write
      // (not just a hidden native set): resumes rebuild kv from the folded
      // effect log, and only recorded writes fold forward — so an instance
      // created in one activation stays scope-resolvable in the next.
      // create(name): prod takes a NAME string (valueToOwnedString) and
      // returns undefined — the instance id IS the name. Record it, and seed
      // the exists marker keyed by name so a later platform.scope(name) folds.
      instances: { create: gate(function(name){ push({ kind: "platform", op: "instances.create", name: name }); push({ kind: "write", store: "exists", key: "i/" + name, value: "1" }); globalThis.kv.set(NS_STORE + "exists/i/" + name, "1"); }), deployStarter: gate(function(name){ push({ kind: "platform", op: "instances.deployStarter", name: name }); }) },
      releases: { publish: gate(function(tenant, depId){ push({ kind: "platform", op: "releases.publish", tenant: tenant, depId: depId }); }) },
      // checkRootToken(token) → true iff it matches the operator root token
      // (env-supplied in prod); the sim carries it as a hidden reserved kv key
      // seeded by `scenario({ rootToken })`. Unconfigured → nothing is root.
      auth: { checkRootToken: gate(function(token){ var rt = globalThis.kv.get(NS_STORE + "auth/token"); var ok = (typeof rt === "string" && rt.length > 0 && token === rt); push({ kind: "platform", op: "auth.checkRootToken", ok: ok }); return ok; }) },
    },
  };
})();

// ── src/js/globals/crypto.js ──
;// Public `crypto` surface — the documentation source of truth for
// handler cryptography (docs/architecture/builtin-libs.md Phase A).
//
// Thin shim over the native `_system.crypto` binding. Top-level
// `crypto.*` names are unchanged; `_system.*` is the internal ABI and
// customer code must never reference it directly. The bundled
// jwt/oauth/oidc/sessions libraries compose on this shim.
//
// Evaluated as a global script (no module/exports) into every
// dispatcher context after the native bindings install.

(function () {
  const sys = _system.crypto;

  /**
   * Cryptographic primitives. Random sources (`getRandomValues`,
   * `randomUUID`, `randomBytes`) are replay-deterministic — captured
   * to the request tape and re-issued identically on replay. Hash and
   * signature-verify operations are pure functions of their inputs and
   * are not taped.
   *
   * Two signature families, named by their KEY FORMAT — don't mix
   * them: `verifyEcdsa` / `verifyRsa` take a JWK (the JOSE world:
   * JWTs, OIDC id_tokens, JWKS documents); `ecdsaSign` /
   * `ecdsaVerify` / `ecdsaGenerateKey` take raw key bytes (the
   * protocol-crypto world: your own signing recipes). `oidcSign`
   * is the JOSE-side signer (PEM private key → compact JWS).
   *
   * @namespace crypto
   */
  globalThis.crypto = {
    /**
     * Fill a typed array with cryptographically random bytes, in
     * place. Web Crypto compatible.
     *
     * @param {Uint8Array} typedArray - The array to fill.
     * @returns {Uint8Array} The same array instance, now filled.
     *
     * @example
     * const salt = crypto.getRandomValues(new Uint8Array(16));
     */
    getRandomValues(typedArray) {
      return sys.getRandomValues(typedArray);
    },

    /**
     * Generate a random RFC 4122 v4 UUID string.
     *
     * @returns {string} e.g. `"f47ac10b-58cc-4372-a567-0e02b2c3d479"`.
     *
     * @example
     * const id = crypto.randomUUID();
     */
    randomUUID() {
      return sys.randomUUID();
    },

    /**
     * Return `n` cryptographically random bytes.
     *
     * @param {number} n - Byte count. Non-negative integer ≤ 65536;
     *   out of range throws `RangeError`.
     * @returns {Uint8Array} `n` fresh random bytes.
     *
     * @example
     * const token = base64url.encode(crypto.randomBytes(32));
     */
    randomBytes(n) {
      return sys.randomBytes(n);
    },

    /**
     * SHA-256 digest of `data`.
     *
     * @param {string|Uint8Array} data - String (hashed as UTF-8
     *   bytes) or raw bytes.
     * @returns {string} Lowercase hex, 64 characters.
     *
     * @example
     * const fp = crypto.sha256(JSON.stringify(payload));
     */
    sha256(data) {
      return sys.sha256(data);
    },

    /**
     * SHA-256 of `data`, URL-safe base64 (no padding) — one call for the
     * `base64url.encode(hex.decode(crypto.sha256(x)))` idiom. Both a PKCE S256
     * code challenge (RFC 7636) and a stable content-addressed id are exactly
     * this digest-of-a-secret-or-key.
     *
     * @param {string|Uint8Array} data - String (hashed as UTF-8 bytes) or raw
     *   bytes.
     * @returns {string} URL-safe base64, 43 characters, no padding.
     *
     * @example
     * const challenge = crypto.sha256b64url(codeVerifier); // PKCE S256
     */
    sha256b64url(data) {
      return base64url.encode(hex.decode(sys.sha256(data)));
    },

    /**
     * Begin a streaming SHA-256. Returns an opaque midstate token —
     * a plain string, so hash state can ride kv across activations
     * (an accumulation built over many chunks finalizes to the same
     * digest as hashing the whole payload at once). Pure and
     * deterministic; feed it to {@link crypto.sha256Update}.
     *
     * @returns {string} Midstate token (version-prefixed, ≤ ~150
     *   chars).
     *
     * @example
     * let mid = crypto.sha256Init();
     * mid = crypto.sha256Update(mid, "hello ");
     * mid = crypto.sha256Update(mid, "world");
     * const hash = crypto.sha256Final(mid); // === crypto.sha256("hello world")
     */
    sha256Init() {
      return sys.sha256Init();
    },

    /**
     * Absorb `data` into a streaming SHA-256. Pure: returns the NEW
     * midstate token; the input token is unchanged and reusable (fork
     * a hash by updating the same token twice).
     *
     * @param {string} token - Midstate from {@link crypto.sha256Init}
     *   or a prior update.
     * @param {string|Uint8Array} data - String (hashed as UTF-8
     *   bytes) or raw bytes.
     * @returns {string} The advanced midstate token.
     */
    sha256Update(token, data) {
      return sys.sha256Update(token, data);
    },

    /**
     * Finalize a streaming SHA-256 to its digest. The token itself is
     * unconsumed (finalize is pure too — you can keep updating the
     * same midstate afterwards).
     *
     * @param {string} token - Midstate token.
     * @returns {string} Lowercase hex, 64 characters — identical to
     *   `crypto.sha256` over the concatenated inputs.
     */
    sha256Final(token) {
      return sys.sha256Final(token);
    },

    /**
     * HMAC-SHA256 of `data` under `key`. The vendor-neutral primitive
     * for Stripe-Signature / X-Slack-Signature / AWS SigV4 style
     * derivations (compose the provider's exact scheme in handler JS).
     *
     * @param {string|Uint8Array} key - Secret key (UTF-8 if string).
     * @param {string|Uint8Array} data - Message bytes (UTF-8 if
     *   string).
     * @returns {string} Lowercase hex, 64 characters.
     *
     * @example
     * const sig = crypto.hmacSha256(webhookSecret, request.bytes);
     * if (sig !== request.headers["x-signature"]) return unauthorized();
     */
    hmacSha256(key, data) {
      return sys.hmacSha256(key, data);
    },

    /**
     * Verify an RSA-PKCS#1 v1.5 (RS256/RS384/RS512) signature. Used to
     * validate OIDC id_tokens. Does NOT validate JWT claims (iss/aud/
     * exp/iat/nbf) — verify the signature here, then check claims.
     *
     * @param {{kty:string,n:string,e:string}} jwk - Public key from
     *   the provider JWKS (`n`/`e` base64url). Other fields ignored.
     * @param {string} alg - `"sha256"` | `"sha384"` | `"sha512"`
     *   (case-insensitive).
     * @param {Uint8Array} data - JWS signing input bytes
     *   (`header_b64 + "." + payload_b64`, UTF-8).
     * @param {Uint8Array} sig - Raw signature bytes (the base64url-
     *   decoded third JWS segment).
     * @returns {boolean} `true` if valid, `false` if it does not
     *   match. Throws on malformed input.
     *
     * @example
     * const ok = crypto.verifyRsa(jwks.keys[0], "sha256", signingInput, sigBytes);
     */
    verifyRsa(jwk, alg, data, sig) {
      return sys.verifyRsa(jwk, alg, data, sig);
    },

    /**
     * Verify a JWS ECDSA (ES256/ES384/ES512) signature — Sign in with
     * Apple, AWS Cognito on EC keys, etc. Does NOT validate JWT
     * claims. The signature is raw `R||S` per JWS (not DER); the
     * binding converts internally.
     *
     * @param {{kty:string,crv:string,x:string,y:string}} jwk - EC
     *   public key; `crv` is `"P-256"` | `"P-384"` | `"P-521"`.
     * @param {string} alg - `"sha256"` | `"sha384"` | `"sha512"`
     *   (case-insensitive; match it to the curve).
     * @param {Uint8Array} data - JWS signing input bytes.
     * @param {Uint8Array} sig - Raw `R||S` (64 B for P-256, 96 for
     *   P-384, 132 for P-521).
     * @returns {boolean} `true` if valid, `false` otherwise. Throws on
     *   malformed input.
     *
     * @example
     * const ok = crypto.verifyEcdsa(appleKey, "sha256", signingInput, sigBytes);
     */
    verifyEcdsa(jwk, alg, data, sig) {
      return sys.verifyEcdsa(jwk, alg, data, sig);
    },

    /**
     * Generate an RSA-2048 keypair for an OIDC identity provider. The
     * private key is returned as an opaque PEM the IdP stores and
     * never parses (key custody stays in Zig/OpenSSL).
     *
     * @returns {{priv:string, jwk:{kty:string,n:string,e:string,alg:string,use:string,kid:string}, kid:string}}
     *   `priv` is an opaque PKCS#8 PEM; `jwk` is publishable at the
     *   JWKS endpoint; `kid` is the key id.
     *
     * @example
     * const { priv, jwk, kid } = crypto.oidcGenerateKey();
     * kv.set("oidc/privkey", priv);
     * kv.set("oidc/jwks", JSON.stringify({ keys: [jwk] }));
     */
    oidcGenerateKey() {
      return sys.oidcGenerateKey();
    },

    /**
     * RS256-sign an OIDC JWS signing input with a private key minted
     * by {@link crypto.oidcGenerateKey}.
     *
     * @param {string} privPem - The opaque PEM from `oidcGenerateKey`.
     * @param {string} signingInput - `header_b64 + "." + payload_b64`.
     * @returns {string} base64url-encoded RS256 signature (the third
     *   JWS segment).
     *
     * @example
     * const jwt = signingInput + "." + crypto.oidcSign(priv, signingInput);
     */
    oidcSign(privPem, signingInput) {
      return sys.oidcSign(privPem, signingInput);
    },

    /**
     * Generate a raw ECDSA keypair over `secp256k1` or `P-256` — the
     * two signing curves the AT Protocol (Bluesky) uses for repo
     * signing keys and `did:plc` rotation keys.
     *
     * Distinct from {@link crypto.oidcGenerateKey} (RSA, JOSE) and the
     * JWK {@link crypto.verifyEcdsa} path (JOSE, DER-tolerant): this
     * surface is raw bytes, SHA-256, compact `R‖S` signatures, with
     * **low-S enforced** — the malleability rule the atproto data
     * model requires. Multibase/multicodec `did:key` encoding of the
     * public key is pure JS (done in the `atproto` library).
     *
     * @param {string} curve - `"secp256k1"` | `"P-256"`.
     * @returns {{privateKey:Uint8Array, publicKey:Uint8Array}}
     *   `privateKey` is the 32-byte scalar; `publicKey` is the
     *   33-byte compressed SEC1 point (`0x02`/`0x03 ‖ X`).
     *
     * @example
     * const { privateKey, publicKey } = crypto.ecdsaGenerateKey("secp256k1");
     * kv.set("repo/signing-key", base64url.encode(privateKey));
     */
    ecdsaGenerateKey(curve) {
      return sys.ecdsaGenerateKey(curve);
    },

    /**
     * ECDSA-sign `data` (SHA-256 digest) with a raw private scalar
     * from {@link crypto.ecdsaGenerateKey}. The signature is the
     * 64-byte compact `R‖S` form atproto stores in signed commits,
     * always low-S normalized.
     *
     * @param {string} curve - `"secp256k1"` | `"P-256"`.
     * @param {Uint8Array} privateKey - 32-byte scalar.
     * @param {Uint8Array} data - Message bytes (e.g. the dag-cbor
     *   encoding of an unsigned commit).
     * @returns {Uint8Array} 64-byte raw `R‖S` signature.
     *
     * @example
     * const sig = crypto.ecdsaSign("secp256k1", priv, dagCborBytes);
     */
    ecdsaSign(curve, privateKey, data) {
      return sys.ecdsaSign(curve, privateKey, data);
    },

    /**
     * Verify a 64-byte compact ECDSA signature (SHA-256). A high-S
     * signature returns `false` even if it is mathematically valid —
     * atproto rejects malleable signatures, so this primitive enforces
     * the rule rather than leaving it to callers.
     *
     * @param {string} curve - `"secp256k1"` | `"P-256"`.
     * @param {Uint8Array} publicKey - SEC1 point: 33-byte compressed
     *   or 65-byte uncompressed.
     * @param {Uint8Array} data - Message bytes that were signed.
     * @param {Uint8Array} sig - 64-byte raw `R‖S` signature.
     * @returns {boolean} `true` iff valid and low-S.
     *
     * @example
     * const ok = crypto.ecdsaVerify("secp256k1", pub, commitBytes, sig);
     */
    ecdsaVerify(curve, publicKey, data, sig) {
      return sys.ecdsaVerify(curve, publicKey, data, sig);
    },
  };
})();

// ── src/js/globals/http.js ──
;// Public `http` surface — the documentation source of truth for the
// outbound HTTP primitive (docs/architecture/builtin-libs.md Phase A,
// the reified primitives in docs/architecture/effects-and-handlers.md).
//
// Thin shim over the native `_system.http` binding. Durability is
// JS-shim'd in `webhook.send` (and `email.send`) on top of the
// internal fetch primitive + `kv` markers + durable scheduled wakes.
// `_system.*` is the internal ABI and customer code must never
// reference it directly.
//
// Evaluated as a global script (no module/exports) into every
// dispatcher context after the native bindings install.

(function () {
  const sys = _system.http;

  /**
   * Long-lived held outbound subscriptions. The one-shot outbound
   * primitives are {@link after.fetch} (connection-scoped; cancel via
   * {@link after.cancel}) and {@link webhook.send} (durable,
   * connectionless); `http.subscribe` holds an upstream that pushes to
   * YOU.
   *
   * @namespace http
   */
  globalThis.http = {
    /**
     * Open a held outbound subscription — `after.fetch`'s held
     * symmetric twin for long-lived upstreams (atproto firehose, Pub/Sub
     * long-poll, SSE consumers, any third-party push where the
     * provider holds the connection). Closes the held-upstream
     * subscription primitive gap (`docs/effect-algebra.md`).
     *
     * Same options as `after.fetch` minus `timeoutMs` (held
     * subscriptions don't time out — they end on cancel or
     * upstream close) and `stream` (always true — held transfers
     * stream by definition). The `on_chunk` handler fires per
     * upstream writeback as a `fetch_chunk` activation; the
     * terminal event has `final: true, ok: false` to signal
     * "subscription ended" (whether by clean upstream close or
     * transport error). Your handler interprets that as
     * "reconnect if desired."
     *
     * Subject to a per-tenant cap on simultaneous held
     * subscriptions. Exceeding the cap fires one
     * `on_chunk(final: true, ok: false)` event so your handler
     * still runs once and can surface the condition.
     *
     * @param {object} opts
     * @param {string} opts.url - Upstream URL.
     * @param {string} [opts.method="GET"] - HTTP method.
     * @param {Object<string,string>} [opts.headers] - Request headers.
     * @param {string} [opts.body] - Request body.
     * @param {string} opts.on - Module path each upstream writeback
     *   wakes (REQUIRED — the universal callback key). Same
     *   activation shape as a streamed `after.fetch`.
     * @param {number} [opts.maxChunkBytes=262144] - Per-chunk cap.
     * @param {number} [opts.maxTotalBytes=52428800] - Cumulative
     *   response cap; exceeding sets `bodyTruncated` on the terminal
     *   event.
     * @param {*} [opts.ctx] - Threaded forward to each activation
     *   as `request.ctx`.
     * @returns {string} The subscription id — the same `ftch_…` form
     *   as `after.fetch`'s return and each chunk's
     *   `request.activation.fetchId`, so you can correlate them
     *   directly. Pass to {@link http.cancelSubscription}.
     *
     * @example
     * const id = http.subscribe({
     *   url: "https://bsky.network/xrpc/com.atproto.sync.subscribeRepos",
     *   on: "ingest_firehose",
     *   ctx: { cursor: kv.get("firehose/cursor") },
     * });
     * kv.set("firehose/subscription_id", id);
     */
    subscribe(opts) {
      opts = opts || {};
      for (const pair of [["on_chunk", "on"], ["max_response_chunk_bytes", "maxChunkBytes"], ["max_total_response_bytes", "maxTotalBytes"]]) {
        if (pair[0] in opts) throw new TypeError("http.subscribe: option `" + pair[0] + "` was renamed — use `" + pair[1] + "`");
      }
      const native = Object.assign({}, opts);
      delete native.on;
      delete native.maxChunkBytes;
      delete native.maxTotalBytes;
      if (typeof opts.on === "string") native.on_chunk = opts.on;
      if (opts.maxChunkBytes != null) native.max_response_chunk_bytes = opts.maxChunkBytes;
      if (opts.maxTotalBytes != null) native.max_total_response_bytes = opts.maxTotalBytes;
      return sys.subscribe(native);
    },

    /**
     * Cancel a held subscription. No-op if the subscription
     * already ended or was never issued. Cooperative: a chunk
     * already in flight may still land in `on_chunk` after the
     * cancel returns.
     *
     * @param {string} id - The id `http.subscribe` returned.
     * @returns {void}
     */
    cancelSubscription(id) {
      return sys.cancelSubscription({ id: id });
    },
  };
})();

// ── src/js/globals/base64.js ──
;// Base64 + base64url encoding/decoding + hex byte helpers.
//
// `atob` / `btoa` are the standard browser-shaped APIs (binary
// string on either side, padded standard base64). `base64url`
// works on Uint8Array (the shape PKCE / JWT verification needs:
// digest bytes in, URL-safe string out, no padding).
//
// `hex.encode` / `hex.decode` bridge between the platform's
// hex-string-returning crypto APIs and the byte-oriented
// base64url surface — `base64url.encode(hex.decode(crypto.sha256(x)))`
// is the PKCE code_challenge in two lines.

const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Build via an array + join, NOT `out += `. In the per-request bump
// arena every `+=` allocates a fresh (never-freed-until-reset) string,
// so `+=`-building an n-char string costs O(n²) arena volume and
// exhausts the arena for large inputs (a big base64/hex of a chunk or
// payload then silently yields an empty response). Array push + join
// is O(n). Same reason `_decodeBase`, `_bytesToString`, `hex.encode`
// avoid `+=` below.
function _encodeBase(bytes, alphabet, padding) {
  const out = [];
  let i = 0;
  while (i + 2 < bytes.length) {
    const b0 = bytes[i++], b1 = bytes[i++], b2 = bytes[i++];
    out.push(alphabet[b0 >> 2]);
    out.push(alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]);
    out.push(alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)]);
    out.push(alphabet[b2 & 0x3f]);
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i];
    out.push(alphabet[b0 >> 2]);
    out.push(alphabet[(b0 & 0x03) << 4]);
    if (padding) out.push("==");
  } else if (remaining === 2) {
    const b0 = bytes[i], b1 = bytes[i + 1];
    out.push(alphabet[b0 >> 2]);
    out.push(alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]);
    out.push(alphabet[(b1 & 0x0f) << 2]);
    if (padding) out.push("=");
  }
  return out.join("");
}

function _decodeBase(str, lookup) {
  // Decode symbol-at-a-time over the ORIGINAL string, skipping padding
  // + whitespace in place — no stripped copy. The earlier `+=` strip
  // (O(n²) arena) and its array+join replacement (a per-char array,
  // still heavy enough to exhaust the arena when many values are
  // decoded in one activation) both allocated O(n) scratch per call;
  // this allocates only the output Uint8Array.
  const out = new Uint8Array((str.length * 3) >> 2); // upper bound
  let oi = 0;
  const quad = [0, 0, 0, 0];
  let q = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Skip '=' padding and ASCII whitespace (space/\t/\n/\v/\f/\r).
    if (code === 0x3d || code === 0x20 || (code >= 0x09 && code <= 0x0d)) continue;
    const v = code < 128 ? lookup[code] : -1;
    if (v < 0) throw new Error("invalid base64 input");
    quad[q++] = v;
    if (q === 4) {
      out[oi++] = (quad[0] << 2) | (quad[1] >> 4);
      out[oi++] = ((quad[1] & 0x0f) << 4) | (quad[2] >> 2);
      out[oi++] = ((quad[2] & 0x03) << 6) | quad[3];
      q = 0;
    }
  }
  // Trailing 2 or 3 symbols (an unpadded or padded final group).
  if (q === 2) {
    out[oi++] = (quad[0] << 2) | (quad[1] >> 4);
  } else if (q === 3) {
    out[oi++] = (quad[0] << 2) | (quad[1] >> 4);
    out[oi++] = ((quad[1] & 0x0f) << 4) | (quad[2] >> 2);
  }
  return out.subarray(0, oi);
}

function _buildLookup(alphabet) {
  const arr = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) arr[alphabet.charCodeAt(i)] = i;
  return arr;
}
const STD_LOOKUP = _buildLookup(STD_ALPHABET);
const URL_LOOKUP = _buildLookup(URL_ALPHABET);
// Cross-tolerant decoder: accept either alphabet on input. Useful
// because code in the wild emits both styles and parsers should be
// liberal in what they accept.
const ANY_LOOKUP = (() => {
  const arr = new Int8Array(STD_LOOKUP);
  for (let i = 0; i < arr.length; i++) {
    if (URL_LOOKUP[i] >= 0) arr[i] = URL_LOOKUP[i];
  }
  return arr;
})();

function _stringToBytes(s) {
  // Treat string as binary (each char = byte 0-255). Matches btoa
  // semantics. Throws on out-of-range chars to surface bugs early.
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0xff) throw new Error("btoa: input contains non-Latin-1 character");
    out[i] = code;
  }
  return out;
}

function _bytesToString(bytes) {
  // Inverse of _stringToBytes — binary string out. Use TextDecoder
  // if you want UTF-8 interpretation. Chunked fromCharCode.apply,
  // not `+=` (O(n²) arena volume — see _encodeBase).
  const parts = [];
  const CH = 8192; // stay under the argument-count limit
  for (let i = 0; i < bytes.length; i += CH) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
  }
  return parts.join("");
}

/**
 * Encode a binary string to padded standard base64 (browser `btoa`).
 *
 * @function btoa
 * @param {string} s - Binary string; each char is one byte
 *   (0–255). Non-Latin-1 chars throw.
 * @returns {string} Standard-alphabet base64 with `=` padding.
 * @example
 * btoa("hello"); // "aGVsbG8="
 */
globalThis.btoa = function (s) {
  if (typeof s !== "string") s = String(s);
  return _encodeBase(_stringToBytes(s), STD_ALPHABET, true);
};

/**
 * Decode standard base64 to a binary string (browser `atob`).
 * Tolerates padding and whitespace.
 *
 * @function atob
 * @param {string} s - Standard-alphabet base64.
 * @returns {string} Binary string (one char per byte). Use
 *   `TextDecoder` for UTF-8 interpretation. Invalid input throws.
 * @example
 * atob("aGVsbG8="); // "hello"
 */
globalThis.atob = function (s) {
  if (typeof s !== "string") s = String(s);
  return _bytesToString(_decodeBase(s, STD_LOOKUP));
};

/**
 * URL-safe base64 (no padding) over bytes — the shape PKCE / JWT
 * verification needs.
 *
 * @namespace base64url
 */
globalThis.base64url = {
  /**
   * Encode bytes as URL-safe base64, no padding.
   *
   * @param {Uint8Array|string|number[]} input - Bytes; a string is
   *   first UTF-8 encoded.
   * @returns {string} URL-safe base64 (`-`/`_`, no `=`).
   * @example
   * base64url.encode(crypto.randomBytes(32)); // PKCE verifier
   */
  encode(input) {
    let bytes;
    if (typeof input === "string") {
      bytes = new TextEncoder().encode(input);
    } else if (input instanceof Uint8Array) {
      bytes = input;
    } else {
      bytes = new Uint8Array(input);
    }
    return _encodeBase(bytes, URL_ALPHABET, false);
  },

  /**
   * Decode URL-safe base64 to bytes. Tolerates padding and the
   * standard (`+`/`/`) alphabet too (liberal in what it accepts).
   *
   * @param {string} s - base64url (or standard) text.
   * @returns {Uint8Array} Decoded bytes. Invalid input throws.
   * @example
   * const token = "aGVhZA.cGF5bG9hZA.c2ln";
   * const sig = base64url.decode(token.split(".")[2]);
   */
  decode(s) {
    if (typeof s !== "string") s = String(s);
    return _decodeBase(s, ANY_LOOKUP);
  },
};

/**
 * Hex string ⇄ bytes. Bridges the platform's hex-returning crypto
 * APIs to the byte-oriented base64url surface — e.g.
 * `base64url.encode(hex.decode(crypto.sha256(x)))` is a PKCE
 * code_challenge in two calls.
 *
 * @namespace hex
 */
globalThis.hex = {
  /**
   * Encode bytes as a lowercase hex string.
   *
   * @param {Uint8Array|number[]} bytes - Bytes to encode.
   * @returns {string} Lowercase hex, 2 chars per byte.
   * @example
   * hex.encode(new Uint8Array([255, 0])); // "ff00"
   */
  encode(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const tab = "0123456789abcdef";
    const out = [];  // array+join, not `+=` (O(n²) arena — see base64 _encodeBase)
    for (let i = 0; i < bytes.length; i++) {
      out.push(tab[bytes[i] >> 4]);
      out.push(tab[bytes[i] & 0x0f]);
    }
    return out.join("");
  },

  /**
   * Decode a hex string to bytes. Accepts upper or lower case.
   *
   * @param {string} s - Even-length hex string.
   * @returns {Uint8Array} Decoded bytes. Odd length or non-hex
   *   chars throw.
   * @example
   * hex.decode("ff00"); // Uint8Array([255, 0])
   */
  decode(s) {
    if (typeof s !== "string") throw new TypeError("hex.decode: input must be a string");
    if ((s.length & 1) !== 0) throw new Error("hex.decode: odd-length input");
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) {
      const hi = _hexNibble(s.charCodeAt(i * 2));
      const lo = _hexNibble(s.charCodeAt(i * 2 + 1));
      if (hi < 0 || lo < 0) throw new Error("hex.decode: non-hex character");
      out[i] = (hi << 4) | lo;
    }
    return out;
  },
};

function _hexNibble(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

// ── src/js/globals/urlsearchparams.js ──
;// `URLSearchParams` polyfill — spec-compliant subset for parsing
// + building query strings without depending on the full URL class.
//
// Construct with:
//   - a string ("a=1&b=2", optionally with a leading "?")
//   - a plain object ({a:1, b:2})
//   - an array of [name, value] pairs
//   - another URLSearchParams (clones)
//
// Methods: append, delete, entries, forEach, get, getAll, has, keys,
// set, sort, toString, values, [Symbol.iterator], `size`.
//
// Encoding follows application/x-www-form-urlencoded, so a value
// produced by `toString()` round-trips through `request.query` and
// the JS `rpc({...})` dispatch recipe (handler-shape.md).

/**
 * WHATWG `URLSearchParams` (spec-compliant subset) for parsing and
 * building `application/x-www-form-urlencoded` query strings without
 * the full `URL` class. `toString()` output round-trips through
 * `request.query`.
 *
 * @class URLSearchParams
 * @example
 * const q = new URLSearchParams(request.query); // "a=1&b=2"
 * q.get("a");            // "1"
 * q.append("a", "3");
 * q.toString();          // "a=1&b=2&a=3"
 */
class URLSearchParams {
  /**
   * @param {string|Object<string,*>|Array<[string,string]>|URLSearchParams}
   *   [init] - Query string (leading `?` optional), plain object,
   *   array of `[name, value]` pairs, or another instance (cloned).
   */
  constructor(init) {
    this._list = []; // array of [name, value] pairs; both strings

    if (init === undefined || init === null || init === "") {
      return;
    }
    if (typeof init === "string") {
      this._parseString(init);
      return;
    }
    if (init instanceof URLSearchParams) {
      this._list = init._list.map((p) => [p[0], p[1]]);
      return;
    }
    if (Array.isArray(init)) {
      for (const entry of init) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new TypeError("URLSearchParams: array init requires [name, value] pairs");
        }
        this._list.push([String(entry[0]), String(entry[1])]);
      }
      return;
    }
    if (typeof init === "object") {
      for (const k of Object.keys(init)) {
        this._list.push([String(k), String(init[k])]);
      }
      return;
    }
    throw new TypeError("URLSearchParams: unsupported init type");
  }

  _parseString(s) {
    if (s[0] === "?") s = s.slice(1);
    if (s.length === 0) return;
    for (const pair of s.split("&")) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      let name, value;
      if (eq === -1) {
        name = pair;
        value = "";
      } else {
        name = pair.slice(0, eq);
        value = pair.slice(eq + 1);
      }
      this._list.push([_decode(name), _decode(value)]);
    }
  }

  /** @returns {number} Number of name/value pairs. */
  get size() {
    return this._list.length;
  }

  /**
   * Append a new pair (does not replace existing ones).
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  append(name, value) {
    this._list.push([String(name), String(value)]);
  }

  /**
   * Remove all pairs with `name`.
   * @param {string} name
   * @returns {void}
   */
  delete(name) {
    name = String(name);
    this._list = this._list.filter((p) => p[0] !== name);
  }

  /**
   * @param {string} name
   * @returns {string|null} The first value for `name`, or `null`.
   */
  get(name) {
    name = String(name);
    for (const p of this._list) if (p[0] === name) return p[1];
    return null;
  }

  /**
   * @param {string} name
   * @returns {string[]} All values for `name`, in insertion order.
   */
  getAll(name) {
    name = String(name);
    return this._list.filter((p) => p[0] === name).map((p) => p[1]);
  }

  /**
   * @param {string} name
   * @returns {boolean} Whether any pair has `name`.
   */
  has(name) {
    name = String(name);
    return this._list.some((p) => p[0] === name);
  }

  /**
   * Set `name` to a single `value`, replacing any existing pairs
   * (keeps the first slot's position).
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  set(name, value) {
    name = String(name);
    value = String(value);
    let replaced = false;
    const next = [];
    for (const p of this._list) {
      if (p[0] === name) {
        if (!replaced) {
          next.push([name, value]);
          replaced = true;
        }
      } else {
        next.push(p);
      }
    }
    if (!replaced) next.push([name, value]);
    this._list = next;
  }

  /**
   * Stable-sort pairs by name (UCS-2 code units, per spec).
   * @returns {void}
   */
  sort() {
    // Stable sort by name (UCS-2 code units, per spec).
    const indexed = this._list.map((p, i) => [p, i]);
    indexed.sort((a, b) => {
      if (a[0][0] < b[0][0]) return -1;
      if (a[0][0] > b[0][0]) return 1;
      return a[1] - b[1];
    });
    this._list = indexed.map((entry) => entry[0]);
  }

  /**
   * @returns {string} `application/x-www-form-urlencoded` string
   *   (spaces as `+`), round-trippable through the platform.
   */
  toString() {
    const parts = [];
    for (const p of this._list) {
      parts.push(_encode(p[0]) + "=" + _encode(p[1]));
    }
    return parts.join("&");
  }

  /**
   * @yields {[string, string]} `[name, value]` pairs in order.
   * @returns {IterableIterator<[string,string]>}
   */
  *entries() {
    for (const p of this._list) yield [p[0], p[1]];
  }

  /**
   * @yields {string} Each pair's name, in order.
   * @returns {IterableIterator<string>}
   */
  *keys() {
    for (const p of this._list) yield p[0];
  }

  /**
   * @yields {string} Each pair's value, in order.
   * @returns {IterableIterator<string>}
   */
  *values() {
    for (const p of this._list) yield p[1];
  }

  /**
   * @returns {IterableIterator<[string,string]>} Alias of
   *   {@link URLSearchParams#entries} (enables `for...of`).
   */
  [Symbol.iterator]() {
    return this.entries();
  }

  /**
   * Invoke `callback(value, name, this)` for each pair.
   * @param {function(string, string, URLSearchParams): void} callback
   * @param {*} [thisArg] - `this` inside `callback`.
   * @returns {void}
   */
  forEach(callback, thisArg) {
    for (const p of this._list) callback.call(thisArg, p[1], p[0], this);
  }
}

// application/x-www-form-urlencoded: encode every byte that isn't
// in the unreserved set + space → +. The receiver (parseDispatch
// in dispatcher.zig) accepts either +-as-space or %20.
function _encode(s) {
  let out = "";
  // Iterate UTF-8 bytes via TextEncoder so non-ASCII characters
  // get percent-encoded byte-by-byte.
  const bytes = new TextEncoder().encode(s);
  const hex = "0123456789ABCDEF";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x20) {
      out += "+";
    } else if (
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f
      // * - . _ — application/x-www-form-urlencoded unreserved
    ) {
      out += String.fromCharCode(b);
    } else {
      out += "%" + hex[b >> 4] + hex[b & 0x0f];
    }
  }
  return out;
}

function _decode(s) {
  // Replace '+' with space first, then percent-decode UTF-8.
  let bytes_len = 0;
  // First pass: compute byte length.
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%") {
      i += 2;
    }
    bytes_len++;
  }
  const bytes = new Uint8Array(bytes_len);
  let bi = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "+") {
      bytes[bi++] = 0x20;
    } else if (ch === "%" && i + 2 < s.length) {
      const hi = _hexCh(s.charCodeAt(i + 1));
      const lo = _hexCh(s.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        bytes[bi++] = (hi << 4) | lo;
        i += 2;
      } else {
        bytes[bi++] = ch.charCodeAt(0);
      }
    } else {
      bytes[bi++] = ch.charCodeAt(0);
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, bi));
}

function _hexCh(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

globalThis.URLSearchParams = URLSearchParams;

// ── src/js/globals/platform.js ──
;// Public `platform` surface — the documentation source of truth for
// the admin control plane (docs/architecture/builtin-libs.md Phase A;
// auth-domain-plan.md for the admin handler context).
//
// Thin shim over the native `_system.platform` binding. Top-level
// `platform.*` is unchanged; `_system.*` is the internal ABI and
// customer code must never reference it directly.
//
// Every method is admin-only: it throws `TypeError` ("platform is
// only available on the admin handler") when reached from a normal
// tenant handler — the gate is enforced natively, the shim only
// forwards. Evaluated as a global script into every dispatcher
// context after the native bindings install.

(function () {
  const sys = _system.platform;
  // `after.fetch` native (captured before `_harden.js` deletes `_system`) —
  // `platform.compile` lowers to a bound fetch to a trusted compile door.
  const sysOn = _system.after;
  // `blob.receive` native — `platform.scope(t).blob.receive` lowers to a
  // cross-tenant streamed upload (extra target + ctx args, admin-gated).
  const sysBlobReceive = _system.blob.receive;

  /**
   * Admin control plane: cross-tenant kv access, the platform root
   * store, instance lifecycle, releases, and root-token auth. Only
   * usable from the `__admin__` handler.
   *
   * @namespace platform
   */
  globalThis.platform = {
    /**
     * Get accessors scoped to another instance — the explicit
     * cross-tenant grant (replaces the old X-Rove-Scope global-kv rebind).
     *
     * @param {string} id - Target instance id (non-empty).
     * @returns {{kv:object, blob:object, deploy:object}}
     *   - `kv` — `{get, set, delete, prefix}`, the same as the global
     *     {@link kv}, bound to instance `id`.
     *   - `blob` — `{get(hash, {on}), receive({on, ctx})}`: cross-tenant blob
     *     READ (resumes `on` with the bytes) + STREAMED write (pipe the inbound
     *     body straight into `id`'s file-blobs, no JS buffering). There is no
     *     sync `put` — cross-tenant writes stream via `receive`.
     *   - `deploy` — `{stampManifest(entries), readManifest(dep)}`: write/read a
     *     deployment manifest in `id`'s deployments/ from composed `entries`
     *     (`[{path, kind, source_hex, bytecode_hex?, content_type?}]`);
     *     stampManifest returns the dep_id (16-hex). Compose deploys with
     *     {@link platform.compile} (handlers) + `blob.receive` (statics) +
     *     `stampManifest`, then activate with {@link platform.releases.publish}.
     *   Unknown id throws `Error{code:"InstanceNotFound"}`.
     *
     * @example
     * const { kv: tenantKv } = platform.scope(req.instanceId);
     * const profile = tenantKv.get("profile");
     */
    scope(id) {
      const s = sys.scope(id);
      // Cross-tenant blob READ — the read twin of `blob.put`. Bound, like
      // {@link blob.get}: it lowers to an after.fetch at the admin-only
      // `rove-blob-read.internal` door (rewritten to `id`'s S3 prefix +
      // SigV4-signed natively). The bytes resume on `request.bytes` at the
      // `on` export (default onFetchResult); thread state with `opts.ctx`
      // (→ `request.ctx`). Return next() after it. Compose the replay bundle /
      // Code-tab sources from these reads in JS — no native assembly.
      // Cross-tenant STREAMED upload — the streaming twin of blob.put. Pipes
      // the inbound request body straight to `id`'s file-blobs (zero JS
      // buffering, no chunk activations), resuming `on` with
      // `request.ctx = {hash, len, app:<opts.ctx>}` when durable. onHeaders-only
      // (like blob.receive); for large statics the deploy app uses this instead
      // of base64-buffering through blob.put.
      s.blob.receive = function (opts) {
        opts = opts || {};
        return sysBlobReceive(
          typeof opts.on === "string" ? opts.on : undefined, id,
          JSON.stringify(opts.ctx !== undefined ? opts.ctx : null),
        );
      };
      s.blob.get = function (hash, opts) {
        opts = opts || {};
        const fetch_opts = {
          method: "GET",
          max_response_chunk_bytes: opts.max_bytes || 8 * 1024 * 1024,
        };
        if (opts.ctx !== undefined) fetch_opts.ctx = opts.ctx;
        fetch_opts.on = opts.on || "onFetchResult";
        return sysOn.fetch(
          "http://rove-blob-read.internal/" + id + "/blob/" + hash,
          fetch_opts,
        );
      };
      // deploy.stampManifest is the deploy's STAGING BARRIER — it lowers to
      // a bound after.fetch (not a native sync call) so it resumes your handler
      // only once the manifest (the last staging write) AND every prior
      // bytecode/static PUT is durable. Return next() after it; the result
      // arrives at the `on` export (default onStamped) as
      // `request.ctx = {ok, dep_id}`.
      s.deploy = {
        stampManifest(entries, opts) {
          opts = opts || {};
          const req = { scope: id, entries };
          // PM P1: `opts.resolution` bakes the deploy's `{packages,
          // app_imports}` sections into the manifest (and its dep_id).
          if (opts.resolution !== undefined)
            req.resolution = JSON.stringify(opts.resolution);
          return sysOn.fetch(
            "http://rove-stage.internal/",
            { method: "POST", body: JSON.stringify(req), on: opts.on || "onStamped" },
          );
        },
        // readManifest is the READ twin of stampManifest: it reads `id`'s
        // deployment manifest for `dep_id` (16-hex) off the read door. The raw
        // manifest JSON resumes on `request.json` at `on` (default
        // onFetchResult) — parse it in JS, then read each handler entry's
        // source with `scope(id).blob.get(hash)`. The current dep_id is
        // `scope(id).kv.get("_deploy/current")`.
        readManifest(dep_id, opts) {
          opts = opts || {};
          const fetch_opts = { method: "GET", on: opts.on || "onFetchResult" };
          if (opts.ctx !== undefined) fetch_opts.ctx = opts.ctx;
          return sysOn.fetch(
            "http://rove-blob-read.internal/" + id + "/manifest/" + dep_id,
            fetch_opts,
          );
        },
      };
      return s;
    },

    /**
     * Compile handler sources to bytecode + content-address them into
     * `scope`'s blobs, off the hot path (`docs/architecture/cli-and-deploy.md` §4.1).
     * Admin-only (the issuing tenant is checked natively). Source →
     * bytecode is the one irreducibly-native deploy step; it's async
     * (compile is slow) but its result is deterministic + idempotent, so
     * it needs no replay tape.
     *
     * **Bound, like {@link on.fetch}:** the call binds to the held chain,
     * so you must `return next()` after it; the result resumes your
     * handler at the `on` export (default `onFetchResult`) with
     * `request.ctx = {ok, results:[{path, source_hex, bytecode_hex}]}`
     * (or `{ok:false, status, error}`). Compose the manifest from those
     * hashes + your statics and stamp it there. Stage/activate is still a
     * separate `platform.releases.publish`.
     *
     * @param {Array<{path:string, source:string}>} files - Handler sources.
     * @param {object} opts
     * @param {string} opts.scope - Target instance id (where blobs stage).
     * @param {string} [opts.on="onFetchResult"] - Resume export.
     * @returns {string} The bound fetch id (`ftch_…`).
     *
     * @example
     * platform.compile(handlers, { scope: tenant, on: "onCompiled" });
     * return next();
     * // export function onCompiled(request) {
     * //   const { results } = request.ctx; ...stamp manifest...
     * // }
     */
    compile(files, opts) {
      opts = opts || {};
      const req = { scope: opts.scope, files };
      // PM P1: `opts.resolution` = the deploy's `{packages, app_imports}`
      // lockfile sections (manifest v2 shapes). The engine fetches the
      // referenced package bytecodes so every `@scope/pkg` import in
      // `files` resolves — and is VALIDATED — at compile. Pre-stringified
      // so the native door needn't re-walk dynamic JSON.
      if (opts.resolution !== undefined)
        req.resolution = JSON.stringify(opts.resolution);
      // PM P1: `opts.pkg_hash` compiles the batch as a PACKAGE's files
      // under `/pkg/<pkg_hash>/…` virtual names (their module identity).
      if (opts.pkg_hash !== undefined) req.pkg_hash = opts.pkg_hash;
      const body = JSON.stringify(req);
      // `opts.ctx` threads forward across the compile re-entry — it's echoed
      // in the result as `request.ctx.app` (the bound resume otherwise only
      // surfaces the compile output). Use it to carry e.g. the deploy's
      // target + composed static entries into the onCompiled handler.
      return sysOn.fetch(
        "http://rove-compile.internal/",
        { method: "POST", body, ctx: opts.ctx, on: opts.on || "onFetchResult" },
      );
    },

    /**
     * The platform root store (`__root__.db`) — instance / domain /
     * user / account metadata.
     *
     * @namespace platform.root
     */
    root: {
      /**
       * @param {string} key
       * @returns {string|null} The value, or `null` if absent.
       * @example const acct = JSON.parse(platform.root.get(`account/${id}`));
       */
      get(key) {
        return sys.root.get(key);
      },
      /**
       * Write to the root store. Replicates via the root writeset.
       * @param {string} key
       * @param {string} value
       * @returns {void}
       * @example platform.root.set(`domain/${host}`, JSON.stringify(rec));
       */
      set(key, value) {
        return sys.root.set(key, value);
      },
      /**
       * @param {string} key
       * @returns {void}
       * @example platform.root.delete(`domain/${host}`);
       */
      delete(key) {
        return sys.root.delete(key);
      },
      /**
       * Prefix scan of the root store. Same pagination contract as
       * {@link kv.prefix} (limit default 100, max 1000).
       * @param {string} prefix
       * @param {string} [cursor]
       * @param {number} [limit=100]
       * @returns {Array<{key:string,value:string}>}
       * @example const all = platform.root.prefix("instance/", null, 1000);
       */
      prefix(prefix, cursor, limit) {
        return sys.root.prefix(prefix, cursor, limit);
      },
    },

    /**
     * Instance lifecycle.
     *
     * @namespace platform.instances
     */
    instances: {
      /**
       * Create an instance: its directory + `app.db`, the local
       * `instance/{name}` marker, and the replicated root marker.
       * Idempotent. Throws `Error{code:"InvalidName"}` on a bad name.
       *
       * @param {string} name - Instance id.
       * @returns {void}
       * @example platform.instances.create("acme-prod");
       */
      create(name) {
        return sys.instances.create(name);
      },
      /**
       * Deploy the platform-baked starter app (`index.mjs` +
       * `_static/index.html`) into `name` and flip
       * `_deploy/current` via raft. Sealed primitive in v1 (starter
       * content is not customer-supplied). Throws
       * `Error{code:"InstanceNotFound"}` if `name` doesn't resolve.
       *
       * @param {string} name - Target instance id.
       * @returns {void}
       * @example platform.instances.deployStarter("acme-prod");
       */
      deployStarter(name) {
        return sys.instances.deployStarter(name);
      },
    },

    /**
     * Releases.
     *
     * @namespace platform.releases
     */
    releases: {
      /**
       * Activate deployment `depId` on `tenantId`: stamp
       * `_deploy/current`, propose envelope-0 through raft (no
       * blocking on consensus), and enqueue the deployment loader.
       * Returns sub-millisecond; consensus + bytecode load run async.
       * Throws `Error{code:"InstanceNotFound"}` if `tenantId` doesn't
       * resolve.
       *
       * @param {string} tenantId - Target instance id.
       * @param {string} depId - Deployment id to activate.
       * @returns {void}
       * @example platform.releases.publish("acme-prod", depId);
       */
      publish(tenantId, depId) {
        return sys.releases.publish(tenantId, depId);
      },
    },

    /**
     * Root-token auth.
     *
     * @namespace platform.auth
     */
    auth: {
      /**
       * Validate a platform root token.
       *
       * @param {string} token - The bearer token to check.
       * @returns {boolean} `true` if the token authenticates.
       * @example
       * if (!platform.auth.checkRootToken(bearer))
       *   return new Response("forbidden", { status: 403 });
       */
      checkRootToken(token) {
        return sys.auth.checkRootToken(token);
      },
    },
  };
})();

// ── src/js/globals/after.js ──
;// Public `after` surface — connection wake triggers (docs/handler-shape.md
// §2.3; decisions.md §4.11). Thin shim over the native
// `_system.after` binding.
//
// `after.*` registers a ONE-SHOT wake **for the current connection**: a
// held handler (one that returns `next()` / streams) is re-invoked when
// the wake fires — a duration elapses, a kv key under a watched prefix
// changes, or an outbound fetch produces a result — while it still
// holds the socket. Wakes are re-armed per activation (call `after.*`
// again to keep listening — the SSE loop shape). Ephemeral (dropped
// with the connection) and node-local (never replicated). On a
// connectionless activation (a `cron`/`schedule`/`webhook.send`
// callback) there is no connection, so `after.*` is inert.
//
// The callback-target option is `{on: "module.method"}` — the universal
// spelling across every effect.
//
// Evaluated as a global script (no module/exports) after the native
// bindings install. (The pre-rename `on.*` alias existed for one deploy
// cycle and closed 2026-07-06.)

(function () {
  const sys = _system.after;
  const sysHttp = _system.http;

// Fail-loud on retired option spellings (audit batch 3): silence would
// mean a silently-ignored option — worse than a break, pre-launch.
function _rejectRenamed(verb, opts, renames) {
  if (!opts || typeof opts !== "object") return;
  for (const k in renames) {
    if (k in opts) throw new TypeError(verb + ": option `" + k + "` was renamed — use `" + renames[k] + "`");
  }
}


  // The callback-target key is `on` at the native layer too — the bindings
  // read `opts.on` directly, so opts pass through with no respelling.

  /**
   * Connection wake triggers — re-invoke a held handler when something
   * happens, while it still holds the socket. Register them in the body
   * before returning `next()` (or while streaming). The runtime arms
   * every `after.*` wake before firing any connectionless effect of the
   * same activation, so a wake is never missed even when a callback
   * writes the key it watches.
   *
   * Wakes are one-shot and cannot be cancelled — they're ephemeral
   * and node-local, so an unwanted wake is simply ignored (or the
   * handler re-arms a different set). The exception is a fetch:
   * cancel an in-flight `after.fetch` by its returned id.
   *
   * @namespace after
   * @example
   * // SSE-style: stream rows, then wait for more under a prefix.
   * stream.start();
   * after.kv(`notif/${user}/`, { on: "onNotify" });
   * return next({ user });
   */
  globalThis.after = {
    /**
     * Wake the held connection after `ms` milliseconds. Named for its
     * unit — durations are milliseconds; there is deliberately no
     * `after.seconds` family (write `after.ms(5 * 60_000)`). Without
     * `on`, the wake lands in the `onWake` export.
     *
     * @param {number} ms - Delay in milliseconds (must be > 0).
     * @param {object} [opts]
     * @param {string} [opts.on] - Export to resume into
     *   (`"module.method"` or a bare `"method"`); defaults to `onWake`.
     * @returns {void}
     * @example
     * after.ms(30_000, { on: "onTimeout" }); // deadline for a join
     */
    ms(ms, opts) {
      return sys.timer(ms, opts);
    },

    /**
     * Wake the held connection after any key under `prefix` changes —
     * anchored to the version this activation read, so a write between
     * "you read" and "you parked" still fires it. Without `on`, the
     * wake lands in the `onWake` export.
     *
     * @param {string} prefix - Tenant-scoped key prefix to watch.
     * @param {object} [opts]
     * @param {string} [opts.on] - Export to resume into; defaults to
     *   `onWake`.
     * @returns {void}
     * @example
     * after.kv(`rooms/${roomId}/`);             // default onWake
     * after.kv(`jobs/${id}/`, { on: "onJob" }); // explicit target
     */
    kv(prefix, opts) {
      return sys.kv(prefix, opts);
    },

    /**
     * Perform an outbound HTTP request and wake the held connection on
     * its result. Connection-scoped: the result resumes THIS chain's
     * `{on}` export (defaults: `onFetchResult` for a non-streamed whole
     * body, `onFetchChunk`/`onFetchDone` for a streamed one) while it
     * still holds the socket; if the activation doesn't hold the socket
     * the fetch is inert (its durable twin is `webhook.send`). With
     * `opts.stream` each upstream writeback wakes the handler as it
     * arrives.
     *
     * @param {string} url - Upstream URL.
     * @param {object} [opts]
     * @param {string} [opts.method="GET"] - HTTP method.
     * @param {Object<string,string>} [opts.headers] - Request headers.
     * @param {string|Uint8Array} [opts.body] - Request body.
     * @param {boolean} [opts.stream=false] - false → one result event;
     *   true → one event per upstream chunk as it arrives.
     * @param {number} [opts.timeoutMs=30000] - Per-request timeout.
     * @param {number} [opts.maxChunkBytes=262144] - Per-chunk cap
     *   (streamed fetches).
     * @param {number} [opts.maxTotalBytes=52428800] - Cumulative
     *   response cap; exceeding sets `bodyTruncated`.
     * @param {*} [opts.ctx] - Threaded to each wake as `request.ctx`.
     * @param {string} [opts.on] - Export the result wakes; overrides the
     *   per-event-shape defaults for every event of this fetch.
     * @returns {string} The fetch id (`ftch_…`, opaque — compare to
     *   `request.fetchId`).
     * @throws {Error} `code:"rate_limited"` when the per-tenant outbound
     *   rate limit is exhausted (shared with `webhook.send`/`email.send`).
     * @example
     * after.fetch('https://api.example.com/stream',
     *             { stream: true, on: 'onUpstream' });
     * return next();
     */
    fetch(url, opts) {
      opts = opts || {};
      _rejectRenamed("after.fetch", opts, {
        timeout_ms: "timeoutMs",
        max_response_chunk_bytes: "maxChunkBytes",
        max_total_response_bytes: "maxTotalBytes",
        to: "on",
      });
      const native = {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        stream: opts.stream,
        ctx: opts.ctx,
      };
      if (typeof opts.on === "string") native.on = opts.on;
      if (opts.timeoutMs != null) native.timeout_ms = opts.timeoutMs;
      if (opts.maxChunkBytes != null) native.max_response_chunk_bytes = opts.maxChunkBytes;
      if (opts.maxTotalBytes != null) native.max_total_response_bytes = opts.maxTotalBytes;
      return sys.fetch(url, native);
    },

    /**
     * Cancel an in-flight `after.fetch` by the id it returned (also on
     * `request.fetchId` in its wake events). No-op if it already
     * completed. Cooperative: a chunk already in flight at the engine
     * may still land after the cancel returns — track "we moved on" in
     * your chain ctx.
     *
     * @param {string} id - The `ftch_…` id.
     * @returns {void}
     * @example
     * const id = after.fetch("https://api.example.test/slow", { on: "onSlow" });
     * after.cancel(id); // changed our mind before it landed
     */
    cancel(id) {
      return sysHttp.cancelFetch({ id: id });
    },
  };
})();

// ── src/js/globals/stream.js ──
;// Public `stream` surface — connection output effects
// (docs/handler-shape.md §2.2). Thin shim over the native
// `_system.stream` binding.
//
// `stream` is an effect **namespace** (ambient, like `kv`), not a
// return verb: a held handler produces its streamed response over time
// by calling `stream.start()` / `stream.write(chunk)`, and controls the
// connection by returning `next()` (keep producing) or a terminal value
// (close). The head — status / headers / cookies — is the ambient
// `response.*` global. `stream.*` is connection-only: on a
// connectionless activation (a `cron`/`schedule`/`webhook.send`
// callback) there is no held socket, so these calls are inert.
//
// Evaluated as a global script (no module/exports) after the native
// bindings install. IIFE-wrapped: a bare top-level definition corrupts
// the arenajs base-snapshot freeze.

(function () {
  const sys = _system.stream;

  /**
   * Connection output — produce a streamed response over time. Pair
   * with `after.*` (to wait for more) and `return next()` (to keep the
   * socket); close by returning a terminal body. The response head is
   * the ambient `response.*` global, committed to the wire by the first
   * `stream.start()` / `stream.write()` (or a terminal return).
   *
   * This is the OUTBOUND direction only. Taking a large body IN is
   * `blob.receive`/`blob.write` (an upload session); an append log you
   * name and query is `segments.*` — neither involves this namespace.
   *
   * @namespace stream
   * @example
   * // SSE: open, emit rows, then wait for more under a prefix.
   * const rows = kv.prefix(`feed/${id}/`, request.ctx?.cursor);
   * response.headers = { 'content-type': 'text/event-stream' };
   * stream.start();
   * for (const r of rows) stream.write(`data: ${r.value}\n\n`);
   * after.kv(`feed/${id}/`, { on: 'onNotify' });
   * return next({ cursor: rows.at(-1)?.key ?? request.ctx?.cursor });
   */
  globalThis.stream = {
    /**
     * Open the streamed response: commit the ambient `response.*` head
     * and begin the stream so the client's `onopen` fires before any
     * data. Optional — the first `stream.write()` opens it implicitly.
     *
     * @returns {void}
     */
    start() {
      return sys.start();
    },

    /**
     * Emit one chunk to the held socket. **Commit-gated**: the chunk
     * reaches the wire only after this activation's writes commit. Call
     * it as many times per activation as you like; raw bytes (SSE
     * `data:` framing is yours to write).
     *
     * @param {string|Uint8Array} chunk - The bytes to emit.
     * @returns {void}
     */
    write(chunk) {
      return sys.write(chunk);
    },
  };
})();

// ── src/js/globals/next.js ──
;// Public `next` disposition verb (docs/handler-shape.md §2.1). Thin shim
// over the `_system.continuation.next` native, captured once at
// base-eval (before `delete globalThis._system`) — the same closure-
// capture pattern as kv.js/webhook.js. Baked `__system/` modules that
// need cross-module dispatch call this public shim (they have the
// ambient globals + it holds the captured ref), so there is no bare
// `__rove_next` native.
//
// `next` parks the held connection: it keeps the socket open and asks
// the runtime to re-invoke this handler on its next activation (a
// kv/timer wake, an after.fetch chunk, a disconnect, …), routed to the
// conventional named export (onWake / onFetchChunk / onDisconnect / …).
// You close instead by returning a terminal body.
//
// Evaluated as a global script after the native bindings install.
// IIFE-wrapped (a bare top-level def corrupts the arenajs base-snapshot).

(function () {
  const sysNext = _system.continuation.next;

  /**
   * Park the held connection and continue on the next activation. `ctx`
   * threads small per-connection state forward as `request.ctx` (a stream
   * cursor, a fan-in accumulator) — it is NOT heap state across
   * activations (the arena resets); durable state lives in `kv`. The
   * runtime resumes THIS module's conventional export for the activation
   * kind. Close the connection by returning a terminal body instead.
   *
   * Called with two arguments, it continues into a DIFFERENT module:
   * `next(targetModule, ctx)` re-aims the held chain to `targetModule`,
   * so EVERY later resume — timer/kv wake, bound fetch chunk, the next
   * WebSocket frame, disconnect — dispatches at the target's
   * conventional export instead of this one. One semantic on every held
   * chain (plain hold, streaming, WebSocket); the same "name a target
   * module" shape as `schedule(when, target)` / `webhook.send({ on })`.
   *
   * A park must be resumable: at park time the chain needs ≥1 possible
   * resume source (an `after.*` arm — this hop's or riding from an
   * earlier one — an in-flight bound fetch / `blob.receive`, a lone owed
   * send, or the connection's own inbound traffic). A `next()` with
   * none is a defined `500 held with no wake source` at the park site.
   *
   * @param {*} [ctx] - Per-connection state for the next activation.
   *   (When two args are given, this first argument is the target
   *   module path string instead — see below.)
   * @param {*} [crossCtx] - Only with a target: the ctx to thread into
   *   `targetModule`.
   * @returns {object} The opaque park descriptor — return it.
   * @example
   * stream.write(`data: ${row.value}\n\n`);
   * after.kv(`feed/${id}/`);
   * return next({ since: row.seq });
   */
  globalThis.next = function (ctx, crossCtx) {
    // Two args ⇒ cross-module: next(targetModule, ctx). One/zero args is
    // ALWAYS same-module (ctx may itself be a string cursor, so we key on
    // arg count, never on arg type — keeps `next("cursor")` same-module).
    if (arguments.length >= 2) {
      if (typeof ctx !== "string") {
        throw new TypeError("next(target, ctx): target must be a module path string");
      }
      return sysNext(ctx, { ctx: crossCtx });
    }
    return sysNext("", arguments.length === 0 ? {} : { ctx: ctx });
  };
})();

// ── src/js/globals/time.js ──
;// Time coercion helpers — the single home for turning human time inputs
// (durations, ms-since-epoch, Date, ISO-8601) into the BigInt
// nanoseconds-since-epoch the scheduler verbs work in. `cron`,
// `schedule`, and `webhook.send` all coerce through here so the edge
// cases (finite checks, duration-vs-ISO, absolute-vs-delay) are defined
// once (docs/handler-shape.md — the connectionless verbs).
//
// - `time.toNs(x)`     absolute: bigint (ns, passthrough) | number
//                      (ms-since-epoch) | Date | string (a `"5m"`-style
//                      duration relative to now, else ISO-8601) |
//                      `null` → `0n` (fire ASAP).
// - `time.parseDuration(s)`  `<n><unit>` (unit ∈ s|m|h|d|w) → ms, or
//                      `null` if `s` isn't a duration (callers fall back
//                      to ISO).
// - `time.inToNs(x)`   a delay FROM NOW: number (ms) | duration string →
//                      absolute ns. (This is why `{at}` and `{in}` differ
//                      on a bare number: `at` is absolute, `in` is a
//                      delay.) `Date.now()` is replay-deterministic
//                      (pinned per activation).
//
// IIFE-wrapped (like every globals/ shim): a bare top-level declaration
// left in the script's global lexical scope corrupts the arenajs
// base-snapshot freeze — scope it.

(function () {
const NS_PER_MS = 1_000_000n;

function _parseDuration(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d+)([smhdw])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "w": return n * 7 * 24 * 60 * 60 * 1000;
  }
  return null;
}

/**
 * Time-coercion helpers shared by `cron` / `schedule` / `webhook.send`:
 * one place to turn human time inputs into the BigInt nanoseconds-since-
 * epoch the scheduler verbs use.
 *
 * @namespace time
 */
globalThis.time = {
  /**
   * Coerce an ABSOLUTE time input to BigInt nanoseconds-since-epoch.
   *
   * @param {bigint|number|Date|string|null} input - bigint (ns,
   *   passed through); number (ms-since-epoch, must be finite); Date;
   *   string (a `"30s"`/`"5m"`/`"2h"`/`"1d"`/`"1w"` duration relative to
   *   now, else ISO-8601); `null` → `0n` (fire ASAP).
   * @returns {bigint} Nanoseconds since epoch.
   * @throws {TypeError} On unrecognized / non-finite input.
   * @example
   * time.toNs("2h");                     // 2 hours from now
   * time.toNs("2026-06-01T03:00:00Z");   // absolute
   */
  toNs(input) {
    if (input == null) return 0n;
    if (typeof input === "bigint") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new TypeError("time.toNs: number must be finite (ms since epoch)");
      }
      return BigInt(Math.floor(input)) * NS_PER_MS;
    }
    if (input instanceof Date) return BigInt(input.getTime()) * NS_PER_MS;
    if (typeof input === "string") {
      const dur = _parseDuration(input);
      if (dur != null) return BigInt(Date.now() + dur) * NS_PER_MS;
      const ms = Date.parse(input);
      if (!Number.isNaN(ms)) return BigInt(ms) * NS_PER_MS;
    }
    throw new TypeError("time.toNs: unrecognized time input");
  },

  /**
   * Parse a duration string to milliseconds.
   *
   * @param {string} s - `<n><unit>`, unit ∈ `s|m|h|d|w` (e.g. `"5m"`).
   * @returns {number|null} Milliseconds, or `null` if `s` isn't a
   *   duration (callers fall back to ISO parsing).
   * @example
   * time.parseDuration("2h"); // 7200000
   */
  parseDuration(s) {
    return _parseDuration(s);
  },

  /**
   * Coerce a DELAY-FROM-NOW to an absolute BigInt ns-since-epoch.
   *
   * @param {number|string} input - number (milliseconds, must be
   *   finite) or a duration string (`"30s"`/`"5m"`/…).
   * @returns {bigint} `now + delay`, in nanoseconds since epoch.
   * @throws {TypeError} On a non-finite number, an unparseable duration
   *   string, or any other type.
   * @example
   * time.inToNs("30m"); // 30 minutes from now
   * time.inToNs(5000);  // 5 seconds from now
   */
  inToNs(input) {
    let ms;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new TypeError("time.inToNs: number must be finite (ms delay)");
      }
      ms = Math.floor(input);
    } else if (typeof input === "string") {
      ms = _parseDuration(input);
      if (ms == null) throw new TypeError("time.inToNs: not a duration: " + input);
    } else {
      throw new TypeError("time.inToNs: expected a number (ms delay) or a duration string");
    }
    return BigInt(Date.now() + ms) * NS_PER_MS;
  },
};
})();

// ── src/js/globals/schedule.js ──
;// The durable one-shot scheduler core — installed as the PRIVATE
// `_system.sched` (deleted from customer scope by `_harden.js`, like
// every other `_system.*` capability). The customer-facing verb is the
// `@rewind/schedule` package; this ambient core exists only so the
// engine's own primitives can compose durable wakes: the `webhook.js`
// shim captures `_system.sched` at eval time (durable send re-arm), and
// the baked `__system/*` modules that need it (cron_tick, webhook_fire,
// webhook_onresult) write the same `_sched/` rows directly over kv (they
// run post-harden and can't see this closure — see those files).
// `schedule`/`cron`/`webhook.send` are the three connectionless verbs.
//
// `_arm`/`cancel`/`get` and the `{at}`/`{in}` coercions + `opts.key`
// idempotency all live here (the former `scheduler` lib folded in
// 2026-07-06); the `@rewind/schedule` package is the same surface.
//
// Pure composition over `kv` + `crypto` + the capability-scoped engine
// wake (the engine keeps ONE next-fire watermark per tenant; this lib
// owns the queue/ordering as ordinary `_sched/` kv). At-least-once
// *FIRING*: a scheduled `target` runs at/after the fire time, possibly
// more than once across a crash — the target owns dedup (idempotency
// via `opts.key` / a kv guard). Not at-least-once *completion*: the
// lib does NOT retry a failed target; compose retry on top
// (webhook.send is exactly that — kv guard + re-arm).
//
// Storage (ordinary tenant kv, owned by this lib — no reserved
// semantics; a customer *could* write these, only affecting their own
// tenant):
//   _sched/by_id/{id}                    -> {when_ns, target, msg, key?}
//   _sched/by_time/{when_ns_padded}/{id} -> ""   (time-ordered index)
//
// Evaluated as a global script after `time.js` (it coerces `{ at }` /
// `{ in }` through the shared `time` library; `cron.*` fire-time helpers
// are still handy inputs to `{ at }`).

(function () {

  // 1 s tick resolution (SCHED_TICK_RESOLUTION). Fire times round UP to
  // the next tick; sub-second scheduling is unsupported (matches the
  // engine's 1 Hz sweep + cron's ≥1000 ms floor).
  const TICK_NS = 1_000_000_000n;

  // Fixed-width zero-pad so lexicographic `_sched/by_time/` key order ==
  // numeric fire-time order (mirrored in builtin_modules/scheduler_tick.mjs).
  // 20 digits covers i64-ns (max ~9.22e18, 19 digits) with headroom.
  const PAD_WIDTH = 20;

  // ── Caps (the durable-wake primitive, docs/effect-algebra.md) — fail-loud, operator notes ──
  // SCHED_MAX_OUTSTANDING is a depth ceiling (boot-recovery scan cost
  // scales linearly past it); SCHED_MAX_MSG_BYTES bounds the
  // durable+taped payload.
  const SCHED_MAX_OUTSTANDING = 10_000;
  const SCHED_MAX_MSG_BYTES = 16 * 1024;

  const BY_ID_PREFIX = "_sched/by_id/";
  const BY_TIME_PREFIX = "_sched/by_time/";

  function _byIdKey(id) {
    return BY_ID_PREFIX + id;
  }

  function _byTimeKey(whenNs, id) {
    return BY_TIME_PREFIX + String(whenNs).padStart(PAD_WIDTH, "0") + "/" + id;
  }

  // Round `whenNs` (BigInt) up to the next tick boundary.
  function _roundUpToTick(whenNs) {
    if (whenNs <= 0n) return 0n;
    return ((whenNs + TICK_NS - 1n) / TICK_NS) * TICK_NS;
  }

  // Deterministic id from an idempotency key: base64url-no-pad(sha256(key)),
  // 43 chars (mirrors webhook.send's `handle`). Same key ⇒ same id ⇒
  // last-write-wins.
  function _idFromKey(key) {
    return crypto.sha256b64url(key);
  }

  // Count outstanding schedules, throwing once the cap is reached. Pages
  // `_sched/by_id/` (kv.prefix caps each page at 1000); cost scales with
  // the tenant's actual outstanding count — cheap (one short page) for
  // the common case of a handful of timers, paid only as a tenant nears
  // the ceiling (the point at which we want to reject). Only invoked for
  // genuinely-new ids (re-arming an existing key is last-write-wins, not
  // a new outstanding entry).
  function _enforceOutstandingCap() {
    let cursor = "";
    let count = 0;
    for (;;) {
      const page = kv.prefix(BY_ID_PREFIX, cursor, 1000) || [];
      count += page.length;
      if (count >= SCHED_MAX_OUTSTANDING) {
        throw new Error(
          "schedule: SCHED_MAX_OUTSTANDING (" + SCHED_MAX_OUTSTANDING +
          ") reached; cancel pending wakes or raise the cap",
        );
      }
      if (page.length < 1000) return; // reached the end, under the cap
      cursor = page[page.length - 1].key;
    }
  }

  // Absolute `{at}` and delay `{in}` both coerce through the shared
  // `time` library (bigint ns | ms-since-epoch | Date | duration | ISO
  // for `at`; ms | duration for `in`). Date.now() is replay-
  // deterministic (pinned per activation).
  function _coerceAt(x) {
    return time.toNs(x);
  }

  function _coerceIn(x) {
    return time.inToNs(x);
  }

  // The arm: validate, cap, write the two `_sched/` rows. Shared by the
  // verb and every internal composer (cron ticks, webhook retry).
  function _arm(whenNs, target, msg, opts) {
    if (typeof target !== "string" || target.length === 0) {
      throw new TypeError("schedule: target must be a non-empty module specifier");
    }
    const payload = msg === undefined ? null : msg;
    const msgJson = JSON.stringify(payload);
    // `JSON.stringify` returns undefined for non-serializable values
    // (e.g. a bare function); treat that as "null" rather than crashing
    // downstream JSON.parse.
    const msgJsonSafe = msgJson === undefined ? "null" : msgJson;
    if (msgJsonSafe.length > SCHED_MAX_MSG_BYTES) {
      throw new Error(
        "schedule: ctx exceeds SCHED_MAX_MSG_BYTES (" + SCHED_MAX_MSG_BYTES +
        "); store it in your own kv and pass a reference",
      );
    }

    const key = (opts && typeof opts.key === "string" && opts.key.length > 0) ? opts.key : null;
    const id = key !== null ? _idFromKey(key) : crypto.randomUUID();
    const rounded = _roundUpToTick(whenNs);

    // Re-arm vs new: if this id already exists, it's an update
    // (last-write-wins) — drop the stale time-index entry if the fire
    // time moved, and skip the outstanding-cap check.
    const existingRaw = kv.get(_byIdKey(id));
    if (existingRaw !== null) {
      try {
        const old = JSON.parse(existingRaw);
        const oldWhen = BigInt(old.when_ns);
        if (oldWhen !== rounded) kv.delete(_byTimeKey(oldWhen, id));
      } catch (_e) {
        // Corrupt existing record — overwrite it wholesale below.
      }
    } else {
      _enforceOutstandingCap();
    }

    const record = { when_ns: String(rounded), target: target, msg: payload };
    if (key !== null) record.key = key;
    kv.set(_byIdKey(id), JSON.stringify(record));
    kv.set(_byTimeKey(rounded, id), "");
    return id;
  }

  /**
   * The durable one-shot timer: run `target` once, at a time — a fresh
   * connectionless activation that survives crashes and leader
   * changes. At-least-once *firing* (the target owns dedup); the lib
   * does not retry a failed target — compose retry on top. Recurrence
   * is `cron(spec, target)`; a connection-scoped delay (dies with the
   * caller) is `after.ms`.
   *
   * @namespace schedule
   * @example
   * const id = schedule({ in: "24h" }, "jobs/reminder", { user: "ada" });
   * // ...or an absolute time, idempotent under a stable key:
   * schedule({ at: cron.dailyAt(3, 0) }, "jobs/cleanup", null,
   *          { key: "cleanup/daily" }); // re-arm = same key, last-write-wins
   */
  /**
   * Schedule `target` to run once. `when` is `{ in }` — a delay
   * (number = ms, or a duration string `"30s"`/`"5m"`/`"2h"`/`"1d"`) —
   * or `{ at }` — an absolute time (Date, ISO-8601 string, number =
   * ms-since-epoch, or bigint = ns for exact composition with the
   * `cron.*` helpers). Fire times round up to the next 1 s tick.
   *
   * The target runs as a fresh activation: your `ctx` arrives as
   * `request.ctx`; delivery metadata (`id`, `key`, `scheduledAtNs`) on
   * `request.activation`. At-least-once firing — dedup on `id` (or
   * your `opts.key`) if exactly-once matters.
   *
   * @param {object} when - `{ in: number|string }` or
   *   `{ at: bigint|number|Date|string }`.
   * @param {string} target - Handler module specifier to invoke: a bare
   *   module (`"jobs/reminder"` → its `default` export) or the
   *   `module.method` form (`"reports.mjs.weekly"` → the `weekly` export).
   *   The method suffix is only recognized after a `.mjs`/`.js` module —
   *   so `"reports.mjs"` is a whole module, and to name a method include
   *   the extension.
   * @param {*} [ctx] - JSON-serializable payload, surfaced as
   *   `request.ctx`. Capped at 16 KiB serialized.
   * @param {object} [opts]
   * @param {string} [opts.key] - Idempotency key. Same key ⇒ same id ⇒
   *   last-write-wins (re-arming moves the fire time — the
   *   self-re-arming interval recipe). Omit for a fresh random id.
   * @returns {string} The stable schedule id (feed to `schedule.cancel`
   *   / `schedule.get`).
   * @throws {TypeError} On a malformed `when` or empty `target`.
   * @throws {Error} If `ctx` exceeds 16 KiB or the outstanding cap is hit.
   * @example
   * const id = schedule({ in: 5000 }, "jobs/poll");
   * schedule({ in: "1h" }, "jobs/expire", { leaseId: "l-7" });
   */
  _system.sched = Object.assign(function schedule(when, target, ctx, opts) {
    let whenNs;
    if (when && when.at !== undefined) whenNs = _coerceAt(when.at);
    else if (when && when.in !== undefined) whenNs = _coerceIn(when.in);
    else throw new TypeError("schedule(when, target, ctx?, opts?): when must be { at } or { in }");
    return _arm(whenNs, target, ctx, opts);
  }, {
    /**
     * Cancel a scheduled wake by id. Removes both the `_sched/by_id`
     * and `_sched/by_time` entries. Idempotent: cancelling an unknown /
     * already-fired id returns `false`.
     *
     * @param {string} id - The id `schedule(...)` returned.
     * @returns {boolean} `true` iff an entry was removed.
     * @example
     * const id = schedule({ in: "1h" }, "jobs/expire");
     * if (!schedule.cancel(id)) throw new Error("cancel missed");
     */
    cancel(id) {
      if (typeof id !== "string" || id.length === 0) return false;
      const raw = kv.get(_byIdKey(id));
      if (raw === null) return false;
      try {
        const rec = JSON.parse(raw);
        kv.delete(_byTimeKey(BigInt(rec.when_ns), id));
      } catch (_e) {
        // Corrupt record — still drop the by_id entry below. A stale
        // by_time index entry self-heals (scheduler_tick deletes an
        // index entry whose by_id is gone).
      }
      kv.delete(_byIdKey(id));
      return true;
    },

    /**
     * Look up a scheduled wake by id.
     *
     * @param {string} id - The id `schedule(...)` returned.
     * @returns {{id: string, whenNs: bigint, target: string,
     *   key: (string|null)} | null} The schedule, or `null` if unknown /
     *   already fired.
     * @example
     * const id = schedule({ in: "1h" }, "jobs/expire");
     * const s = schedule.get(id);
     * if (!s || s.target !== "jobs/expire") throw new Error("lookup failed");
     */
    get(id) {
      if (typeof id !== "string" || id.length === 0) return null;
      const raw = kv.get(_byIdKey(id));
      if (raw === null) return null;
      let rec;
      try {
        rec = JSON.parse(raw);
      } catch (_e) {
        return null;
      }
      return {
        id: id,
        whenNs: BigInt(rec.when_ns),
        target: rec.target,
        key: rec.key === undefined ? null : rec.key,
      };
    },
  });
})();

// ── src/js/globals/webhook.js ──
;(function () {
// `webhook.send` — durable outbound HTTP, composed in JS on top of
// the reified primitives: `kv.set` (durable marker), `http.fetch`
// (transient transport), `__system/webhook_onresult` (the baked
// on_chunk shim that classifies + retries + chains to the customer's
// on_result), and the durable `scheduler` (the durable-wake primitive
// of the four-primitive effect model, docs/effect-algebra.md):
// scheduled fires, retry re-arms, and the crash-recovery watchdog are
// all ONE `scheduler` entry under the idempotency key `_send/{id}`,
// fired as the baked `__system/webhook_fire`. The privileged Zig owed
// sweep (`owed_retry.zig`'s `sweepOwedRetries*`) is deleted — every
// piece of webhook durability is now a composition a customer could
// write themselves.
//
// ## Marker JSON shape (the contract webhook_fire + onresult read)
//
//   {
//     "url":        string,                // upstream URL
//     "method":     string,                // "POST" / "GET" / …
//     "body":       string,                // request body
//     "headers":    object | undefined,    // customer headers (X-Rove-* stamped on fire)
//     "attempts":   integer,               // 0 on first write; bumped by onresult
//     "max_attempts": integer,             // retry budget (default 5)
//     "on_result":  string | null,         // customer module path (null = fire-and-forget)
//     "context":    any | null             // opaque customer payload, echoed back
//   }
//
// Fire TIMING no longer lives in the marker (`next_at_ns` is gone) —
// the `scheduler` entry under key `_send/{id}` is the single durable
// next-fire authority. The marker is pure send state.
//
// ## Id derivation
//
//   - `handle` provided → deterministic: base64url-no-pad(sha256(handle)).
//     Two `webhook.send`s with the same handle write to the same
//     `_send/owed/{id}` row — last write wins (the customer's
//     idempotency mechanism).
//   - No handle → `crypto.randomUUID()`. Replay-deterministic via the
//     existing crypto random tape (Math/Date/crypto all tape).
//
// ## Fire policy
//
//   - Immediate (no `fire_at_ns`, or `fire_at_ns <= now`):
//       1. kv.set the marker.
//       2. http.fetch the request with `on_chunk =
//          __system/webhook_onresult`, ctx = {id, on_result, context}.
//          Customer-visible request carries `X-Rove-Schedule-Id` +
//          `X-Rove-Schedule-Version` headers (version=1).
//       3. scheduler watchdog at now + WATCHDOG_MS aimed at
//          `__system/webhook_fire` — if the leader dies (or the
//          onresult commit is lost) between the fetch and its
//          terminal event, the wake re-fires the marker on whatever
//          node then leads. Survives leader change by construction
//          (the wake entry is replicated kv; the new leader's
//          promotion pass rebuilds its watermark from it).
//   - Scheduled (`fire_at_ns > now`):
//       1. kv.set the marker.
//       2. scheduler.at(fire_at_ns, "__system/webhook_fire", {id},
//          {key: "_send/" + id}). No http.fetch from this call site —
//          webhook_fire issues it when the wake fires.
//
// All three writes (marker + the scheduler entry's two `_sched/` keys)
// ride the handler's one writeset; the inline fetch is a buffered Cmd
// released post-commit. If the handler throws or raft faults, none of
// it happened.
//
// webhook_fire stamps the same `X-Rove-Schedule-Id` + `X-Rove-
// Schedule-Version: {attempts+1}` headers on each deferred fire, so
// upstream services can dedupe by `(id, version)` consistently across
// first-fire-from-handler and wake-fired retries.

// Handler-surface Phase 3: the customer `http.fetch` spelling is
// retired — webhook.send composes durability over the internal fetch
// PRIMITIVE (`_system.http.fetch`), not the public surface. Capture it
// at eval time (before the `_harden.js` `delete globalThis._system`
// step); the `send` closure below uses the captured reference, which
// stays valid post-harden (only the globalThis property is removed, not
// the object). Same closure-capture posture as globals/on.js.
const sysHttp = _system.http;

// The durable scheduler core (globals/schedule.js) installs the private
// `_system.sched`; capture it here the same way as `sysHttp` (before
// `_harden.js` deletes `_system`) so webhook.send's durable re-arm keeps
// working post-harden without exposing an ambient `schedule` to customers
// (the customer-facing verb is the `@rewind/schedule` package).
const sysSched = _system.sched;

// Crash-recovery watchdog distance for the immediate-fire path: one
// attempt timeout (the fetch binding's 30 s cap) + grace. Mirrored in
// `__system/webhook_fire.mjs` (its per-attempt re-arm) — keep in sync.
const WEBHOOK_WATCHDOG_MS = 40_000;

/**
 * Durable outbound HTTP — at-least-once delivery, replay-deterministic.
 * The connectionless counterpart to `after.fetch`: the send fires after
 * the handler commits and is owned by the platform until a terminal
 * result, surviving crashes and leader changes.
 *
 * @namespace webhook
 */
globalThis.webhook = {
  /**
   * Send a webhook. Writes a durable `_send/owed/{id}` marker through
   * raft, then fires the request post-commit. On failure
   * the platform retries with exponential backoff (1s, 2s, 4s, …,
   * capped at 60s, max 5 attempts) — controlled by the baked
   * `__system/webhook_onresult` shim, not customer code. Deferred
   * fires (scheduled sends, retries, crash recovery) ride the durable
   * {@link schedule} and survive leader changes.
   *
   * The handler's commit gates the marker: if the handler throws or
   * raft faults, no marker is written and no request fires. After
   * commit the platform owns delivery; the customer's `on_result`
   * module sees one terminal result event (success or give-up after
   * the retry budget).
   *
   * @param {string} url - Target URL.
   * @param {object} [opts]
   * @param {string} [opts.method="POST"] - HTTP method.
   * @param {string} [opts.body=""] - Request body (string only — the
   *   durable marker is JSON).
   * @param {Object<string,string>} [opts.headers] - Extra headers.
   *   `X-Rove-Schedule-Id` and `X-Rove-Schedule-Version` are added
   *   by the platform on fire — don't set them yourself.
   * @param {string} [opts.key] - Idempotency key — the same word it
   *   is on `schedule`: same key → same id → same `_send/owed/{id}`
   *   row (last write wins). Omit for a fresh random id.
   * @param {bigint|number|Date|string} [opts.at] - Absolute fire time
   *   (bigint ns, number ms-since-epoch, Date, or ISO-8601 — the
   *   `schedule({at})` coercions). A future time defers the fire to a
   *   durable scheduled wake; omitted/past = fire on commit.
   * @param {number|string} [opts.in] - Delay from now (ms, or a
   *   duration string `"30s"`/`"5m"` — the `schedule({in})` shape).
   * @param {number} [opts.maxAttempts=5] - Retry budget (1 first
   *   fire + up to 4 backoff retries).
   * @param {number} [opts.timeoutMs] - Per-attempt timeout, applied
   *   to every fire (first, deferred, retries).
   * @param {string} [opts.on] - Module path of a customer result
   *   handler. Receives the terminal event on the unified flattened
   *   surface (handler-shape §7): the response on `request.bytes` /
   *   `.text` / `.json`, and `request.status` / `.bodyTruncated`
   *   (2xx = delivered; `status === 0` = never reached the endpoint;
   *   no derived `request.ok`); the threaded `ctx` value bare
   *   on `request.ctx`; delivery metadata (`attempts`, `error?`, `id`,
   *   `headers`) on `request.activation.*`. There is no `request.result`.
   * @param {*} [opts.ctx] - Opaque customer payload echoed back as
   *   `request.ctx` on the result event.
   * @returns {string} The marker id — random unless `handle` was
   *   supplied, in which case it is base64url(sha256(handle)) (stable:
   *   the same handle always yields the same id).
   * @throws {TypeError} If `url` is missing/wrong type.
   * @throws {Error} `code:"rate_limited"` when the per-tenant outbound
   *   rate limit is exhausted (email.send / webhook.send / after.fetch
   *   share one per-tenant outbound budget). The immediate fire is
   *   attempted before the durable marker is written, so a rejected send
   *   leaves nothing queued — catch and retry later.
   *
   * Lifecycle: enumerate in-flight sends with
   * `kv.prefix("_send/owed/")` (each value is the marker JSON). To
   * cancel a SCHEDULED send before it fires: `schedule.cancel(id)`
   * kills the durable wake, then `kv.delete("_send/owed/" + id)`
   * removes the marker — both in one handler, so the cancellation is
   * atomic. An already-fired send cannot be recalled.
   *
   * @example
   * webhook.send("https://hooks.example.com/x", {
   *   body: JSON.stringify({ event: "order.paid", id }),
   *   on: "hooks/onDelivered",
   *   ctx: { order_id: id },
   * });
   *
   * @example
   * // Scheduled fire — write the marker now, fire in 5 minutes.
   * webhook.send("https://example.test/reminder", {
   *   body: "ping",
   *   key: "reminder/" + userId,        // idempotent
   *   in: "5m",
   * });
   */
  send(url, maybeOpts) {
    // webhook.send(url, opts) — positional url, matching after.fetch.
    if (typeof url !== "string")
      throw new TypeError("webhook.send(url, opts): `url` must be a string");
    if (maybeOpts != null && typeof maybeOpts !== "object")
      throw new TypeError("webhook.send: opts must be an object");
    const opts = Object.assign({}, maybeOpts || {}, { url: url });
    for (const pair of [["handle", "key"], ["fire_at_ns", "at (or in)"], ["max_attempts", "maxAttempts"], ["timeout_ms", "timeoutMs"], ["on_result", "on"], ["context", "ctx"]]) {
      if (pair[0] in opts) throw new TypeError("webhook.send: option `" + pair[0] + "` was renamed — use `" + pair[1] + "`");
    }

    const on_key = typeof opts.on === "string" ? opts.on : null;
    const ctx_val = opts.ctx !== undefined ? opts.ctx : null;

    // The body must be a string: it JSON-round-trips through the
    // durable `_send/owed/{id}` marker, which would silently mangle a
    // Uint8Array to `{"0":..}` (docs/decisions.md §4.11
    // C3; byte bodies on the durable path are a deferred follow-up).
    const body = opts.body == null ? "" : opts.body;
    if (typeof body !== "string")
      throw new TypeError("webhook.send: `body` must be a string (encode bytes or JSON.stringify explicitly)");

    // `on` is a module path string. Passed verbatim to
    // `__rove_next(on_result, {ctx: {...}})` inside the
    // webhook_onresult.mjs shim.
    const on_result = on_key;

    // Id derivation: deterministic from the idempotency key, else
    // randomUUID (taped → replay-deterministic).
    let id;
    if (typeof opts.key === "string" && opts.key.length > 0) {
      // base64url(no pad)(sha256(key)). 43 chars, URL-safe, no
      // collisions in practice; deterministic so two webhook.sends
      // with the same key land on the same `_send/owed/{id}`.
      id = crypto.sha256b64url(opts.key);
    } else {
      id = crypto.randomUUID();
    }

    // Resolve the fire time via the shared `time` library: {at}
    // (absolute — bigint ns | ms | Date | duration | ISO) or {in}
    // (delay — ms | duration string).
    const now_ns = BigInt(Date.now()) * 1_000_000n;
    let fire_at_ns_big = 0n;
    if (opts.at != null) {
      fire_at_ns_big = time.toNs(opts.at);
    } else if (opts.in != null) {
      fire_at_ns_big = time.inToNs(opts.in);
    }
    const scheduled = fire_at_ns_big > now_ns;

    // `maxAttempts` caps the built-in retry loop in
    // `__system/webhook_onresult`. Default 5 (1 initial fire + 4
    // retries with exponential backoff capped at 60s). Customers
    // who want a different policy can set it explicitly; the
    // `retry.send` wrapper sets `1` to disable the built-in retry
    // and drive its own customer-side chain.
    const max_attempts = (opts.maxAttempts != null && opts.maxAttempts >= 1)
      ? Math.floor(opts.maxAttempts)
      : 5;

    const marker = {
      url: opts.url,
      method: opts.method || "POST",
      body: body,
      headers: opts.headers || {},
      attempts: 0,
      max_attempts: max_attempts,
      on_result: on_result,
      context: ctx_val,
    };
    if (opts.timeoutMs != null) marker.timeout_ms = Math.floor(opts.timeoutMs);

    // Immediate path: attempt the inline fire FIRST, BEFORE writing the
    // durable marker / watchdog. The per-tenant outbound rate limit is
    // enforced at the fetch primitive (bindings/http.zig `outboundRateOk`);
    // if it throws `rate_limited`, this send must leave NO durable residue
    // — otherwise the crash-recovery watchdog below would still deliver it,
    // and a customer who catches `rate_limited` and retries would
    // double-send. Ordering the fetch ahead of the `kv.set`/`schedule`
    // writes makes a rejected send atomic (nothing written). The fetch is
    // buffered as a `Cmd.http_fetch` and released post-commit, so it still
    // shares the marker's commit gate (docs/architecture/effects-and-handlers.md);
    // moving it earlier in the handler body doesn't change WHEN it fires,
    // only that a rate-limit throw pre-empts the writes.
    //
    // Phase 4.1.2 (inline fire): the earlier sweep-only path was a
    // workaround for a marker-commit race, resolved by the Cmd-pattern
    // commit gate — the worker stages every `http.fetch` from a write-path
    // handler on the parked unit's `BufferedCmds` and `drainRaftPending`
    // submits it STRICTLY AFTER raft commits the writeset. Scheduled fires
    // (`fire_at_ns > now`) go wake-only — the baked `__system/webhook_fire`
    // issues the fetch when the durable wake fires; the held-sync path
    // stays correct either way (the 25s mandatory deadline covers both).
    if (!scheduled) {
      sysHttp.fetch({
        url: opts.url,
        method: opts.method || "POST",
        body: body,
        headers: Object.assign({}, opts.headers || {}, {
          "X-Rove-Schedule-Id": id,
          "X-Rove-Schedule-Version": "1",
        }),
        on_chunk: "__system/webhook_onresult",
        // Held state (docs/architecture/effects-and-handlers.md): stamp the
        // send_id so the chunk router (Zig) consults
        // bound_send_owners[id] and routes the callback to the
        // cont's owning worker (instead of hash(tenant_id), which
        // may differ from the SO_REUSEPORT-chosen accept worker).
        // Platform-internal option — customers don't use it
        // directly.
        bound_send_id: id,
        timeout_ms: marker.timeout_ms,
        ctx: {
          id: id,
          on_result: on_result,
          context: ctx_val,
        },
      });
    }

    kv.set("_send/owed/" + id, JSON.stringify(marker));

    // The durable next-fire entry (one per send, idempotency key
    // `_send/{id}` — re-sends with the same handle MOVE it, mirroring
    // the marker's last-write-wins). Scheduled: the customer's fire
    // time. Immediate: the crash-recovery watchdog (onresult cancels
    // it on the terminal event; a retry re-arm moves it to the
    // backoff time).
    if (scheduled) {
      sysSched({ at: fire_at_ns_big }, "__system/webhook_fire", { id: id }, { key: "_send/" + id });
    } else {
      sysSched({ in: WEBHOOK_WATCHDOG_MS }, "__system/webhook_fire", { id: id }, { key: "_send/" + id });
    }
    return id;
  },
};

})();
// ── src/js/globals/blob.js ──
;// blob.* — tenant object storage (blob-storage-plan P1; `docs/architecture/routing-and-ingress.md`).
//
// The storage doctrine in one line: kv is for state you mutate; the
// object store is for facts you accumulate. Every object is
// content-addressed — the store has no names, only sha256 hashes;
// your naming layer (`media/{id} → hash`) lives in kv where it is
// transactional and replicated.
//
// Transport: `blob.put` / `blob.get` fetch the special origin
// `http://rove-blob.internal/{hash}`. The fetch engine rewrites that
// to YOUR tenant's `app-blobs/` prefix on the real object store and
// signs it natively — the signing keys never exist in JS, and the
// tenant in the key comes from the activation, so no handler can
// reach another tenant's prefix. `blob.url` is the one verb that is
// native end-to-end (`_system.blob.presign`): it mints a presigned
// GET URL from the activation's taped clock, so replay reproduces
// it bit-for-bit.

// IIFE-wrapped (like on.js): bare top-level function declarations
// corrupt the arenajs base-snapshot freeze — green unit tests,
// segfault on the first live request. Everything below stays in the
// closure; only `globalThis.blob` escapes.
(() => {

// Capture the natives at eval time (before `_harden.js` deletes
// `globalThis._system`) — same closure posture as webhook.js/on.js.
const sysHttp = _system.http;
const sysBlob = _system.blob;

function _rejectRenamedBlob(verb, opts) {
  if (!opts || typeof opts !== "object") return;
  for (const pair of [["content_type", "contentType"], ["max_bytes", "maxBytes"], ["on_result", "on"], ["context", "ctx"]]) {
    if (pair[0] in opts) throw new TypeError(verb + ": option `" + pair[0] + "` was renamed — use `" + pair[1] + "`");
  }
}

const BLOB_ORIGIN = "http://rove-blob.internal/";
const COMPOSE_ORIGIN = "http://rove-compose.internal/";
const HASH_RE = /^[0-9a-f]{64}$/;

function assertHash(hash, verb) {
  if (typeof hash !== "string" || !HASH_RE.test(hash))
    throw new TypeError(verb + ": hash must be 64 lowercase hex chars (a sha256 digest)");
}

// ── The recipe substrate (blob-write-recipes.md) ─────────────
//
// An open accumulation is kv rows, not worker RAM: `write` appends a
// row + advances a sha256 midstate, `seal` freezes the recipe (the
// durable marker) and emits the compose Cmd. Everything load-bearing
// is replicated kv — replayable by construction, and the caps below
// are policy, not memory protection.

const RECIPE_MAX_ROWS = 4096;
const RECIPE_INLINE_APPEND_MAX = 256 * 1024;   // mirrors MAX_FIRE_BYTES
const RECIPE_INLINE_TOTAL_MAX = 16 * 1024 * 1024;
// Plan-tier input eventually (§12.2); one constant until plans carry it.
const RECIPE_TOTAL_MAX = 1024 * 1024 * 1024;

// One open recipe per chain: the sid IS the chain's correlation id
// (recorded → replay-pure). Chain-less dispatch (test paths) shares
// one local recipe, matching the one-session-per-chain semantics the
// RAM implementation had.
function _recipeSid() {
  return request.correlation_id || "local";
}

function _recipeMetaKey(sid) { return "_blob/recipe/" + sid + "/meta"; }

function _recipeRowKey(sid, seq) {
  return "_blob/recipe/" + sid + "/r/" + String(seq).padStart(4, "0");
}

function _recipeMeta(sid) {
  const raw = kv.get(_recipeMetaKey(sid));
  return raw == null ? null : JSON.parse(raw);
}

// Sealed-but-unmaterialized hashes fail loud on dereference —
// readiness is announced by the seal's `on` activation, never
// inferred (the row is deleted by the compose flip).
function _assertMaterialized(hash, verb) {
  if (kv.get("_blob/pending/" + hash) != null)
    throw new Error(verb + ": " + hash + " is sealed but not yet materialized — wait for your seal `on` activation");
}

/**
 * Content-addressed tenant object storage.
 *
 * Two shapes: one-shot (`put`/`get`) for values you hold in hand, and
 * the upload session (`receive` → `write` → `seal`) for large inbound
 * bodies that stream in chunk by chunk. "Seal" = freeze the bytes into
 * an immutable blob and get back its hash (`segments.seal` is the same
 * metaphor applied to a log tail). `blob.write` appends INTO an upload
 * session — the opposite direction from `stream.write`, which emits
 * response bytes OUT over the held connection.
 *
 * @namespace blob
 */
globalThis.blob = {
  /**
   * Store bytes content-addressed. Returns the sha256 hash (the
   * object's permanent key) synchronously — index it in kv in the
   * same activation; the index write, the durable `_blob/owed/{hash}`
   * marker, and the rest of your writeset commit atomically, then
   * the PUT fires post-commit (idempotent: same bytes → same key).
   *
   * Durability semantics (P1): the owed marker is written before the
   * PUT and cleared by the platform when the PUT succeeds. On
   * terminal PUT failure the marker persists with `failed: true` as
   * durable evidence, and your `on_result` module (if given) sees
   * `ok: false` — re-putting the same bytes is always safe.
   * Automatic re-PUT via source-activation re-execution is the §2.5
   * recovery model and lands after P1.
   *
   * @param {string|Uint8Array} bytes - Object content. Strings store
   *   their UTF-8 bytes; use Uint8Array for binary. Bounded by the
   *   activation arena — multi-MB media wants the streaming verbs
   *   (P2/P3, not yet shipped).
   * @param {object} [opts]
   * @param {string} [opts.contentType] - Stored Content-Type,
   *   returned on direct GETs of the object.
   * @param {string} [opts.on] - Module path receiving the
   *   terminal result on the unified flattened surface (handler-shape
   *   §7): `request.status` top-level (2xx = stored; no `request.ok`),
   *   the echoed
   *   `context` (the threaded value) IS `request.ctx`, and the stored
   *   `hash` is on `request.activation.hash`.
   * @param {*} [opts.ctx] - Opaque payload echoed to the `on` module
   *   as `request.ctx`.
   * @returns {string} The object's sha256 hash (64 hex chars).
   *
   * @example
   * const hash = blob.put(JSON.stringify(event));
   * kv.set(`timeline/${room}/${seq}`, JSON.stringify({ hash }));
   */
  put(bytes, opts) {
    opts = opts || {};
    _rejectRenamedBlob("blob.put", opts);
    if (typeof bytes !== "string" && !(bytes instanceof Uint8Array))
      throw new TypeError("blob.put: bytes must be a string or Uint8Array");
    const hash = crypto.sha256(bytes);
    const on_result = typeof opts.on === "string" ? opts.on : null;
    const context = opts.ctx !== undefined ? opts.ctx : null;

    const marker = {
      hash: hash,
      content_type: opts.contentType || null,
      attempts: 1,
      on_result: on_result,
      context: context,
      created_at_ns: String(BigInt(Date.now()) * 1_000_000n),
    };
    kv.set("_blob/owed/" + hash, JSON.stringify(marker));

    sysHttp.fetch({
      url: BLOB_ORIGIN + hash,
      method: "PUT",
      body: bytes,
      headers: opts.contentType ? { "content-type": opts.contentType } : {},
      on_chunk: "__system/blob_onresult",
      ctx: { hash: hash, on_result: on_result, context: context },
    });
    return hash;
  },

  /**
   * Read an object. Connection-scoped (`after.fetch` semantics): the
   * result resumes THIS held connection — by default in
   * `onFetchResult`, or the export named by `to`. Inert in a
   * connectionless activation. A missing object surfaces as a
   * non-2xx result; reads carry no marker — the caller retries.
   *
   * @param {string} hash - The object's sha256 hash.
   * @param {object} [opts]
   * @param {string} [opts.on] - Export name to resume in.
   * @param {*} [opts.ctx] - Delivered as `request.ctx` on the
   *   resume (JSON round-trip).
   * @param {boolean} [opts.stream] - Per-chunk delivery (default
   *   false: one whole-body result, up to `maxBytes`).
   * @param {number} [opts.maxBytes] - Whole-body transport cap
   *   (default 8 MB). The per-request arena (100 MiB allocation
   *   volume) comfortably covers decoding bodies this size; for
   *   serving bytes your handler doesn't execute on, prefer the
   *   `blob.url` redirect — the bytes then never touch the worker.
   * @returns {string} The fetch id.
   *
   * @example
   * export default function () {
   *   const rec = JSON.parse(kv.get(`media/${id}`) ?? "{}");
   *   if (rec.hash) { blob.get(rec.hash, { on: "onBlob" }); return next(); }
   *   return next();
   * }
   * export function onBlob() { return request.bytes; } // flattened payload accessors; request.status top-level
   */
  get(hash, opts) {
    opts = opts || {};
    _rejectRenamedBlob("blob.get", opts);
    assertHash(hash, "blob.get");
    _assertMaterialized(hash, "blob.get");
    const fetch_opts = {
      method: "GET",
      stream: !!opts.stream,
      maxChunkBytes: opts.stream
        ? (opts.maxChunkBytes || 256 * 1024)
        : (opts.maxBytes || 8 * 1024 * 1024),
    };
    // `ctx` rides the fetch and resumes as `request.ctx` — how
    // composers (segments.get) thread slicing info to the `to`
    // export without kv round-trips.
    if (opts.ctx !== undefined) fetch_opts.ctx = opts.ctx;
    if (typeof opts.on === "string") fetch_opts.on = opts.on;
    return after.fetch(BLOB_ORIGIN + hash, fetch_opts);
  },

  /**
   * Mint a presigned download URL for an object — the zero-copy
   * read path. Answer a download request with a redirect and the
   * bytes flow storage→client without touching the worker:
   *
   *   response.status = 307;
   *   response.headers = { location: blob.url(hash, { ttl: 300 }) };
   *   return "";
   *
   * The URL's timestamp derives from the activation's taped clock,
   * so replay reproduces it exactly.
   *
   * @param {string} hash - The object's sha256 hash.
   * @param {object} [opts]
   * @param {number} [opts.ttl] - Validity in seconds (default 300,
   *   max 604800 = 7 days).
   * @param {string} [opts.contentType] - Signed response
   *   Content-Type override (S3 returns exactly this).
   * @returns {string} The presigned URL.
   */
  url(hash, opts) {
    opts = opts || {};
    assertHash(hash, "blob.url");
    _assertMaterialized(hash, "blob.url");
    return sysBlob.presign(hash, opts.ttl != null ? opts.ttl : null,
                           opts.contentType != null ? opts.contentType : null);
  },

  /**
   * Append bytes to this chain's open recipe (created on the first
   * write). The accumulation is kv rows + a sha256 midstate — nothing
   * lives in worker RAM, so it spans activations, replicates, and
   * replays like any other state. Write each streamed chunk from its
   * resume, or call repeatedly within one activation — then
   * {@link blob.seal} freezes the recipe into one content-addressed
   * object.
   *
   * Caps (policy, blob-write-recipes.md §12): 4096 rows and
   * 1 GiB per recipe, 256 KiB per inline append, 16 MiB inline total
   * — exceeding any throws. A recipe whose chain dies without
   * sealing is swept after ~15 min idle; nothing reaches storage
   * before `seal`, so abandonment costs a few kv rows, briefly.
   *
   * @param {string|Uint8Array} bytes - Chunk to append. Strings
   *   append their UTF-8 bytes; use Uint8Array for binary.
   * @returns {number} Total recipe bytes after the append.
   *
   * @example
   * export function onMirrorChunk() {
   *   if (!request.done) { blob.write(request.bytes); return next(); }
   *   const hash = blob.seal({ on: "stored", contentType: "image/png" });
   *   return JSON.stringify({ hash });
   * }
   */
  write(bytes) {
    if (typeof bytes !== "string" && !(bytes instanceof Uint8Array))
      throw new TypeError("blob.write: bytes must be a string or Uint8Array");
    const len = typeof bytes === "string"
      ? new TextEncoder().encode(bytes).length
      : bytes.length;
    if (len > RECIPE_INLINE_APPEND_MAX)
      throw new Error("blob.write: append exceeds the 256 KiB inline cap");

    const sid = _recipeSid();
    const meta = _recipeMeta(sid) || {
      state: "open", mid: crypto.sha256Init(),
      rows: 0, total: 0, inline_total: 0, updated_at: 0,
    };
    if (meta.state !== "open")
      throw new Error("blob.write: recipe already sealed — one seal per chain");
    if (meta.rows >= RECIPE_MAX_ROWS)
      throw new Error("blob.write: recipe exceeds " + RECIPE_MAX_ROWS + " rows");
    if (meta.total + len > RECIPE_TOTAL_MAX)
      throw new Error("blob.write: recipe exceeds the 1 GiB cap");
    if (meta.inline_total + len > RECIPE_INLINE_TOTAL_MAX)
      throw new Error("blob.write: recipe exceeds the 16 MiB inline cap");

    const row = typeof bytes === "string"
      ? { s: bytes }
      : { b: base64url.encode(bytes) };
    kv.set(_recipeRowKey(sid, meta.rows), JSON.stringify(row));

    meta.mid = crypto.sha256Update(meta.mid, bytes);
    meta.rows += 1;
    meta.total += len;
    meta.inline_total += len;
    meta.updated_at = Date.now();
    kv.set(_recipeMetaKey(sid), JSON.stringify(meta));
    return meta.total;
  },

  /**
   * Seal this chain's recipe: freeze it (the durable marker), return
   * the object's sha256 synchronously — finalized from the recipe's
   * midstate, no byte is re-read — and emit the compose that
   * materializes the object in storage.
   *
   * The hash is an identifier; **readiness is announced by your
   * `on` activation, never inferred.** Completion is durable
   * (webhook.send's convention, not after.fetch's — `on` names a
   * MODULE, like `blob.put`'s and `webhook.send`'s, because the
   * sealed recipe, not the live connection, owes the callback): the
   * module's default export fires connectionless once the object is
   * servable, with your `ctx` as `request.ctx`, the hash on
   * `request.activation.hash`, and `{hash, totalBytes}` as
   * `request.json`. There is no failure arm — materialization
   * retries until it happens.
   *
   * Index the hash in kv NOW if you want: the pointer write, the
   * seal marker, and the rest of your writeset commit atomically.
   * Just don't hand the hash to anything that dereferences it before
   * your `on` activation ran — `blob.url`/`blob.get` on a
   * sealed-but-unmaterialized hash throw.
   *
   * @param {object} opts
   * @param {string} opts.on - Module path activated when the object
   *   is servable (required).
   * @param {*} [opts.ctx] - Threaded to the `on` activation as
   *   `request.ctx` (JSON round-trip).
   * @param {string} [opts.contentType] - Stored Content-Type.
   * @returns {string} The object's sha256 hash (64 hex chars).
   *
   * @example
   * // doc-only
   * // upload.mjs — respond at seal; readiness arrives at `stored`.
   * export function onChunk() {
   *   blob.write(request.bytes);
   *   if (!request.done) return next();
   *   const hash = blob.seal({ on: "stored", ctx: { id: request.ctx.id } });
   *   kv.set(`media/${request.ctx.id}`, JSON.stringify({ hash, status: "processing" }));
   *   response.status = 202;
   *   return JSON.stringify({ hash });
   * }
   * // stored.mjs — the completion activation.
   * export default function () {
   *   const rec = JSON.parse(kv.get(`media/${request.ctx.id}`));
   *   kv.set(`media/${request.ctx.id}`, JSON.stringify({ ...rec, status: "ready" }));
   *   return "";
   * }
   */
  seal(opts) {
    _rejectRenamedBlob("blob.seal", opts);
    opts = opts || {};
    const on_key = opts.on;
    if (typeof on_key !== "string" || !on_key.length)
      throw new TypeError("blob.seal: `on` module path is required");
    if (opts.contentType != null && typeof opts.contentType !== "string")
      throw new TypeError("blob.seal: contentType must be a string");

    const sid = _recipeSid();
    // No open recipe = sealing an empty accumulation — a legitimate
    // (empty) object, same as blob.put("").
    const meta = _recipeMeta(sid) || {
      state: "open", mid: crypto.sha256Init(),
      rows: 0, total: 0, inline_total: 0, updated_at: 0,
    };
    if (meta.state !== "open")
      throw new Error("blob.seal: recipe already sealed — one seal per chain");

    const hash = crypto.sha256Final(meta.mid);
    const ctx = opts.ctx !== undefined ? opts.ctx : null;
    kv.set(_recipeMetaKey(sid), JSON.stringify({
      state: "sealed", hash: hash,
      content_type: opts.contentType || null,
      rows: meta.rows, totalBytes: meta.total,
      on: on_key, ctx: ctx,
      updated_at: Date.now(),
    }));
    // Deleted by the compose flip; blob.url/get check it so an early
    // dereference fails loud instead of racing storage.
    kv.set("_blob/pending/" + hash, sid);

    // The prompt compose trigger — leader-local, moot-on-loss; the
    // sealed marker above is what guarantees materialization (the
    // materializer sweeps sealed-but-unmaterialized recipes).
    sysHttp.fetch({
      url: COMPOSE_ORIGIN + sid,
      method: "PUT",
      body: "",
      headers: {},
      on_chunk: "__system/blob_compose_onresult",
      ctx: { sid: sid, hash: hash, on: on_key, ctx: ctx },
    });
    return hash;
  },

  /**
   * Pipe the entire inbound request body socket → content-addressed
   * storage with ZERO chunk activations (Case B,
   * blob-storage-plan §3.5; `docs/architecture/routing-and-ingress.md`). Only callable from an
   * `onHeaders` export — the body hasn't been accepted yet; calling
   * `blob.receive` then `return next()` opens the valve. Bytes
   * stream to a tenant-prefix S3 multipart at the client's rate
   * (flow-controlled to the upload rate) and NEVER enter a handler
   * activation or the tape — the completion event is all replay
   * needs.
   *
   * The chain resumes at `to` when the object is durable:
   * `request.ctx = { hash, len }` with `request.status === 200`. On
   * failure (client disconnect, storage error) `to` runs with
   * `request.status === 0` and nothing was stored — S3 multipart is
   * commit-gated, so a torn upload is invisible. (`status` is the
   * single result signal; no `request.ok`.)
   *
   * The litmus (vs `onChunk` + blob.write): does your logic depend
   * on the CONTENT of the bytes? No → this, one PUT. Yes → the
   * chunk path, which tapes what you read.
   *
   * @param {object} opts
   * @param {string} opts.on - Export resumed with `{hash, len}`
   *   when the object is durable (required).
   *
   * @example
   * export function onHeaders() {
   *   if (!authed(request.headers)) { response.status = 401; return "no"; }
   *   blob.receive({ on: "onStored" });
   *   return next();
   * }
   * export function onStored() {
   *   if (request.status !== 200) { response.status = 502; return "store failed"; }
   *   kv.set(`media/${request.ctx.hash}`, JSON.stringify({ len: request.ctx.len }));
   *   return JSON.stringify({ hash: request.ctx.hash });
   * }
   */
  receive(opts) {
    _rejectRenamedBlob("blob.receive", opts);
    opts = opts || {};
    const on_key = opts.on;
    if (typeof on_key !== "string" || !on_key.length)
      throw new TypeError("blob.receive: `on` export name is required");
    return sysBlob.receive(on_key);
  },
};

})();

;delete globalThis._system;
