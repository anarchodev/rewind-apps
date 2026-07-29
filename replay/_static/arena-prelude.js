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

