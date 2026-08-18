// Assert the browser replay REFUSES a payload it does not have, and
// consumes one the dashboard resolved for it.
//
// Why this exists: a recorded payload over the inline cap is not in the
// log record — the record keeps a pointer and the bytes stay in object
// storage. Before the body door, the shell dropped every ref-bearing tape
// entry on the floor and the epilogue served `""`. That is the worst shape
// a replay tool can have: a missing input wearing the exact shape of an
// empty one, with nothing anywhere saying so.
//
// Two halves are checked here, because either alone can pass while the
// pair is broken:
//
//   1. `rtap.mjs` keeps the BodyRef. `ref_len` is the only field that
//      separates "this entry had no payload" from "this entry had a
//      payload nobody kept", and the decoder used to read past it.
//   2. `deriveActivationSurface` addresses resolutions by RAW tape ordinal
//      and turns an unresolvable reference into `payloadUnresolved`, which
//      `buildRequestEpilogue` renders as a refusal rather than "".
//
// Run: node e2e/body-resolve-check.mjs   (exit 0 = ok)

import {
  deriveActivationSurface,
  locatePayload,
  buildRequestEpilogue,
} from "../replay/_static/request-replay.mjs";
import {
  parseTapeBlob,
  RTAP_MAGIC,
  RTAP_VERSION,
  CHANNEL_TRIGGER_PAYLOAD,
  CHANNEL_FETCH_RESPONSES,
} from "../replay/_static/rtap.mjs";

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };
const enc = new TextEncoder();

// ── Hand-rolled RTAP writers ─────────────────────────────────────────
// `rtap.mjs`'s own builder covers only the channels it can synthesise
// (kv / module / request_reads), so these two are written here against
// the wire format in that file's header comment — which is the point: a
// decoder change that silently shifts an offset fails this immediately.

function frame(channel, entryBufs) {
  let total = 12;
  for (const b of entryBufs) total += 4 + b.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let o = 0;
  v.setUint32(o, RTAP_MAGIC); o += 4;
  v.setUint16(o, RTAP_VERSION); o += 2;
  v.setUint16(o, channel); o += 2;
  v.setUint32(o, entryBufs.length); o += 4;
  for (const b of entryBufs) {
    v.setUint32(o, b.length); o += 4;
    out.set(b, o); o += b.length;
  }
  return out;
}

function triggerEntry({ batch_id = 0, ref_offset = 0, ref_len = 0, inline = new Uint8Array(0) }) {
  const out = new Uint8Array(8 + 8 + 4 + 4 + inline.length);
  const v = new DataView(out.buffer);
  v.setBigUint64(0, BigInt(batch_id));
  v.setBigUint64(8, BigInt(ref_offset));
  v.setUint32(16, ref_len);
  v.setUint32(20, inline.length);
  out.set(inline, 24);
  return out;
}

function fetchEntry({
  fetch_id = "f1", seq = 0, byte_offset = 0, batch_id = 0, ref_offset = 0,
  ref_len = 0, final = true, terminal_status = 200, terminal_ok = true,
  body_truncated = false, headers = "", inline = new Uint8Array(0), content_hash = "",
}) {
  const fid = enc.encode(fetch_id), hdr = enc.encode(headers), ch = enc.encode(content_hash);
  const out = new Uint8Array(
    4 + fid.length + 4 + 8 + 8 + 8 + 4 + 1 + 2 + 1 + 1 +
    4 + hdr.length + 4 + inline.length + 4 + ch.length);
  const v = new DataView(out.buffer);
  let o = 0;
  v.setUint32(o, fid.length); o += 4; out.set(fid, o); o += fid.length;
  v.setUint32(o, seq); o += 4;
  v.setBigUint64(o, BigInt(byte_offset)); o += 8;
  v.setBigUint64(o, BigInt(batch_id)); o += 8;
  v.setBigUint64(o, BigInt(ref_offset)); o += 8;
  v.setUint32(o, ref_len); o += 4;
  out[o++] = final ? 1 : 0;
  v.setUint16(o, terminal_status); o += 2;
  out[o++] = terminal_ok ? 1 : 0;
  out[o++] = body_truncated ? 1 : 0;
  v.setUint32(o, hdr.length); o += 4; out.set(hdr, o); o += hdr.length;
  v.setUint32(o, inline.length); o += 4; out.set(inline, o); o += inline.length;
  v.setUint32(o, ch.length); o += 4; out.set(ch, o); o += ch.length;
  return out;
}

// ── 1. The decoder keeps the BodyRef ─────────────────────────────────

{
  const spilled = parseTapeBlob(frame(CHANNEL_TRIGGER_PAYLOAD, [
    triggerEntry({ batch_id: 77, ref_offset: 4096, ref_len: 40000 }),
  ])).entries[0];
  check(spilled.batch_id === 77, "trigger decode lost batch_id");
  check(spilled.ref_offset === 4096, "trigger decode lost body_ref.offset");
  check(spilled.ref_len === 40000, "trigger decode lost body_ref.len");
  check(spilled.inline_bytes.length === 0, "trigger decode invented inline bytes");

  const carried = parseTapeBlob(frame(CHANNEL_TRIGGER_PAYLOAD, [
    triggerEntry({ ref_len: 5, inline: enc.encode("hello") }),
  ])).entries[0];
  check(new TextDecoder().decode(carried.inline_bytes) === "hello",
    "trigger decode mangled inline bytes after keeping the BodyRef");

  const chunk = parseTapeBlob(frame(CHANNEL_FETCH_RESPONSES, [
    fetchEntry({ fetch_id: "fx", seq: 3, byte_offset: 100, ref_len: 90000,
                 content_hash: "a".repeat(64), headers: "{}" }),
  ])).entries[0];
  check(chunk.fetch_id === "fx" && chunk.seq === 3,
    "fetch decode desynced after keeping the BodyRef");
  check(chunk.ref_len === 90000, "fetch decode lost body_ref.len");
  check(chunk.content_hash === "a".repeat(64),
    "fetch decode lost the trailing content hash");
  check(chunk.terminal_status === 200, "fetch decode lost the terminal status");
}

// ── 2. locatePayload: the four answers ───────────────────────────────

{
  const carried = locatePayload({ inline_bytes: enc.encode("x"), ref_len: 1 }, 0, "trigger_payload", null);
  check(carried.source === "carried", "inline bytes did not report as carried");

  const empty = locatePayload({ inline_bytes: new Uint8Array(0), batch_id: 0, ref_len: 0 },
    0, "fetch_responses", null);
  check(empty.source === "empty" && empty.bytes === null,
    "a terminal-only entry with no payload reported as a failure");

  // A payload the capture CLAIMED and did not keep (the >16 KB
  // send_callback envelope, and the unretained fetch chunk): no bytes, no
  // batch, no hash — only a length. Without `ref_len` this is
  // indistinguishable from the empty case above, which is the bug.
  const lost = locatePayload({ inline_bytes: new Uint8Array(0), batch_id: 0, ref_len: 40000 },
    0, "trigger_payload", null);
  check(lost.source === "unresolved" && typeof lost.reason === "string",
    "a claimed-but-unkept payload did not report as unresolved");

  const resolved = locatePayload({ inline_bytes: new Uint8Array(0), batch_id: 7, ref_len: 3 },
    0, "trigger_payload",
    { "trigger_payload/0": { status: 200, source: "pool", len: 3, bytes: enc.encode("abc") } });
  check(resolved.source === "pool" && resolved.bytes.length === 3,
    "a resolved pool reference was not consumed");

  // Addressed by RAW ordinal: a resolution filed under a different index
  // must not be handed to this entry.
  const misfiled = locatePayload({ inline_bytes: new Uint8Array(0), batch_id: 7, ref_len: 3 },
    1, "trigger_payload",
    { "trigger_payload/0": { status: 200, source: "pool", len: 3, bytes: enc.encode("abc") } });
  check(misfiled.source === "unresolved",
    "entry 1 was served entry 0's resolved bytes — the address is not the ordinal");
}

// ── 3. The surface: consume, and refuse ──────────────────────────────

{
  // A >16 KB inbound body. The record carries no inline body; the tape
  // entry is a pool reference; the dashboard resolved it.
  const tapes = { trigger_payload: [{ batch_id: 12, ref_offset: 0, ref_len: 5, inline_bytes: new Uint8Array(0) }] };
  const s = deriveActivationSurface({
    activation: "inbound", tapes,
    resolvedBodies: { "trigger_payload/0": { status: 200, source: "pool", len: 5, bytes: enc.encode("SPILL") } },
  });
  check(s.payloadUnresolved === null, "a resolved body still reported a gap");
  check(s.bodyBytes && new TextDecoder().decode(s.bodyBytes) === "SPILL",
    "the resolved inbound body never reached the surface");

  // The same record with the door refusing (409 — recorded as nothing).
  const gone = deriveActivationSurface({
    activation: "inbound", tapes,
    resolvedBodies: { "trigger_payload/0": { status: 409, error: "the payload was not recorded" } },
  });
  check(gone.bodyBytes === null, "an unresolvable body was served anyway");
  check(gone.payloadUnresolved?.channel === "trigger_payload" &&
        gone.payloadUnresolved?.index === 0 &&
        gone.payloadUnresolved?.status === 409,
    "an unresolvable body did not surface as a gap");

  // No resolution attempted at all (an older bundle, or a door outage):
  // still a gap, never an empty body.
  const blind = deriveActivationSurface({ activation: "inbound", tapes });
  check(blind.bodyBytes === null && typeof blind.payloadUnresolved?.reason === "string",
    "a ref-bearing entry with no resolution replayed as empty — the pre-door bug");

  // A small inbound body still comes off the record, not off the tape:
  // the surface leaves `bodyBytes` null so the shell's
  // `surface.bodyBytes ?? bundle.request.body_bytes` keeps its meaning.
  const inline = deriveActivationSurface({
    activation: "inbound",
    tapes: { trigger_payload: [{ batch_id: 0, ref_len: 2, inline_bytes: enc.encode("hi") }] },
  });
  check(inline.bodyBytes === null && inline.payloadUnresolved === null,
    "an inline inbound body changed hands");
}

{
  // fetch_chunk: the last chunk's bytes are the activation's payload.
  const tapes = {
    fetch_responses: [{
      fetch_id: "f", seq: 0, byte_offset: 0, batch_id: 0, ref_offset: 0, ref_len: 90000,
      final: true, terminal_status: 200, terminal_ok: true, body_truncated: false,
      headers: "", inline_bytes: new Uint8Array(0), content_hash: "b".repeat(64),
    }],
  };
  const s = deriveActivationSurface({
    activation: "fetch_chunk", tapes,
    resolvedBodies: { "fetch_responses/0": { status: 200, source: "content", len: 4, bytes: enc.encode("BIG!") } },
  });
  check(s.bodyBytes && new TextDecoder().decode(s.bodyBytes) === "BIG!",
    "a resolved content-addressed chunk never reached the surface");
  check(s.result?.status === 200, "the terminal status was lost while resolving the chunk");

  const gone = deriveActivationSurface({
    activation: "fetch_chunk", tapes,
    resolvedBodies: { "fetch_responses/0": { status: 410, error: "gone" } },
  });
  check(gone.bodyBytes === null && gone.payloadUnresolved?.channel === "fetch_responses",
    "an unresolvable chunk replayed as an empty chunk");

  // A terminal-only chunk (a stream FIN, a transport error) legitimately
  // has no bytes and must NOT be reported as a gap.
  const terminal = deriveActivationSurface({
    activation: "fetch_chunk",
    tapes: { fetch_responses: [{ ...tapes.fetch_responses[0], ref_len: 0, content_hash: "" }] },
  });
  check(terminal.payloadUnresolved === null,
    "a genuinely empty terminal chunk was reported as a lost payload");
}

// ── 4. The epilogue refuses before it serves "" ──────────────────────

{
  // The exact gap: a spilled body the handler DID read. `bodyRead` is
  // true, `bodyBytes` is null — the old epilogue answered "".
  const src = buildRequestEpilogue({
    record: { method: "POST", path: "/upload", host: "app.example.com" },
    requestReads: [{ kind: 2, name: "", value: "" }],  // READ_KIND_BODY_READ
    bodyBytes: null,
    payloadUnresolved: { channel: "trigger_payload", index: 0, status: 410,
                         reason: "the referenced bytes are no longer in storage" },
  });
  check(src.includes("payloadGone"), "the epilogue carries no payloadGone flag");
  check(src.includes("the referenced bytes are no longer in storage"),
    "the epilogue does not carry the reason the payload is missing");
  check(/if \(D\.payloadGone\) miss\(/.test(src),
    "the epilogue does not refuse the payload read");
  // The refusal must come BEFORE the bodyRead branch, or a body the
  // handler read falls through to the empty-string path anyway.
  check(src.indexOf("D.payloadGone) miss(") < src.indexOf("!D.bodyRead) miss("),
    "the payload refusal runs after the bodyRead check — the empty body still wins");

  const clean = buildRequestEpilogue({
    record: { method: "GET", path: "/", host: "app.example.com" },
  });
  check(/"payloadGone":null/.test(JSON.stringify({ payloadGone: null })) &&
        clean.includes("\"payloadGone\":null"),
    "a record with nothing missing still declares a payload gap");
}

if (failures.length) {
  console.error("body-resolve-check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("body-resolve-check ok");
