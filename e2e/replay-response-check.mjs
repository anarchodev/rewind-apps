// Assert the browser replay derives the WIRE response the way production
// serves it.
//
// Why this exists: the replay shell shows the response its re-execution
// produced, and folds that same response into the interaction digest it
// compares against the capture's. Both readings are only worth having if
// the derivation matches the serving path — a body one byte off presents a
// divergence as a faithful reproduction, and a header the worker would have
// dropped reads as a header production sent.
//
// The rules live in three engines: the worker
// (`src/js/response_building.zig` + `dispatcher.zig`), the offline sim
// (`src/replay/epilogue.zig`), and `deriveWireResponse` here. This file
// pins the third against the cases where the raw handler intent and the
// wire response differ — which is every case worth a test.
//
// Run: node e2e/replay-response-check.mjs   (exit 0 = ok)

import { deriveWireResponse, buildRequestEpilogue } from "../replay/_static/request-replay.mjs";

const failures = [];

function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${name}\n    want ${w}\n    got  ${g}`);
}

const wire = (result, response = {}, effects = [], kind = "inbound") =>
  deriveWireResponse(result, response, effects, kind);

// ── body derivation (response_building.bodyFromReturn) ──────────────

check("a string return is the raw body, not JSON-quoted",
  wire("hello").body, "hello");

check("an object return is JSON.stringify'd",
  wire({ ok: true }).body, '{"ok":true}');

check("an object return auto-stamps content-type",
  wire({ ok: true }).headers, { "content-type": "application/json" });

check("a handler's own content-type wins over the auto-stamp",
  wire({ ok: true }, { headers: { "Content-Type": "application/ld+json" } }).headers,
  { "content-type": "application/ld+json" });

check("a string return does NOT auto-stamp content-type",
  wire("hello").headers, {});

check("undefined return is an empty body",
  wire(undefined).body, "");

check("null return is an empty body",
  wire(null).body, "");

// Bytes mean bytes (docs/decisions.md §4.11): the JSON.stringify fallthrough
// used to corrupt them to `{"0":..}`, which is also what the replay folded
// into its digest — so every byte-returning handler replayed as diverged.
const bytes = new Uint8Array([0xff, 0x00, 0x41]);
check("a Uint8Array return is raw bytes, not an index object",
  Array.from(wire(bytes).body), [0xff, 0x00, 0x41]);
check("a byte body is flagged binary and carried as base64",
  [wire(bytes).binary, wire(bytes).bodyB64], [true, "/wBB"]);
check("a byte body does not auto-stamp content-type",
  wire(bytes).headers, {});

// ── buffered stream chunks (dispatcher.prependStreamChunks) ─────────

const streamed = [{ kind: "stream", data: "head-" }, { kind: "stream", data: "mid-" }];
check("buffered stream.write chunks ship ahead of the body",
  wire("tail", {}, streamed).body, "head-mid-tail");

check("a rolled-back stream chunk never reaches the wire",
  wire("tail", {}, [{ kind: "stream", data: "gone", rolledBack: true }]).body, "tail");

check("stream chunks prepend to a byte body as bytes",
  Array.from(wire(bytes, {}, [{ kind: "stream", data: "A" }]).body),
  [0x41, 0xff, 0x00, 0x41]);

// Only a first-hop HTTP terminal prepends: a resume's chunks are already on
// the open stream, and a WS frame went to the socket.
check("a resume activation does not re-ship buffered chunks",
  wire("tail", {}, streamed, "send_callback").body, "tail");
check("inbound_headers is a first hop and does prepend",
  wire("tail", {}, streamed, "inbound_headers").body, "head-mid-tail");

// ── status (worker_dispatch's coercion + clamp) ─────────────────────

check("an unset status defaults to 200", wire("x", {}).status, 200);
check("a status below 100 clamps up", wire("x", { status: 7 }).status, 100);
check("a status above 599 clamps down", wire("x", { status: 9000 }).status, 599);
check("a string status coerces like ToInt32", wire("x", { status: "404" }).status, 404);

// ── header vetting (response_building.isEmittableHeaderName) ────────

check("header names lowercase (HTTP/2)",
  wire("x", { headers: { "X-Trace": "abc" } }).headers, { "x-trace": "abc" });

for (const [name, why] of [
  [":status", "pseudo-header"],
  ["connection", "hop-by-hop"],
  ["content-length", "platform-managed"],
  ["set-cookie", "cookies go through the cookies array"],
  ["x-rewind-internal", "reserved prefix"],
  ["x-rove-internal-thing", "reserved prefix"],
  ["bad name", "token-invalid"],
]) {
  check(`a ${why} header (${name}) is dropped`,
    wire("x", { headers: { [name]: "v" } }).headers, {});
}

check("a header value with CRLF is dropped (response splitting)",
  wire("x", { headers: { "x-a": "v\r\nX-Evil: 1" } }).headers, {});
check("a non-string header value is dropped",
  wire("x", { headers: { "x-a": 42 } }).headers, {});

// ── cookie sanitization (response_building.sanitizeSetCookie) ───────

check("a cookie keeps its attributes",
  wire("x", { cookies: ["a=1; Path=/; HttpOnly"] }).cookies, ["a=1; Path=/; HttpOnly"]);
check("Domain= is stripped — no cookie onto the parent domain",
  wire("x", { cookies: ["a=1; Domain=.example.com; Path=/"] }).cookies, ["a=1; Path=/"]);
check("a non-string cookie is dropped",
  wire("x", { cookies: [{ a: 1 }] }).cookies, []);

// ── next(): the connection is held, prod ships nothing yet ──────────

const held = wire({ __rove_disposition: "next", ctx: { n: 1 } }, { status: 201, headers: { "x-a": "b" } });
check("next() is held with no wire body", [held.held, held.body], [true, null]);
check("a held hop still reports what the handler set (prod discarded it)",
  [held.status, held.headers], [201, { "x-a": "b" }]);

// ── the epilogue actually uses it ───────────────────────────────────
//
// The derivation is only load-bearing if the generated epilogue calls
// it and parks what it produced. Embedding is by `toString()`, so a
// refactor that closed the function over module scope would still pass
// every case above and then throw a ReferenceError inside the arena —
// where the failure surfaces as "the run did not complete", not as a
// broken embed.
const epilogue = buildRequestEpilogue({
  record: { method: "GET", path: "/x", host: "app.example.com" },
  activation: "inbound",
});

for (const needle of [
  "const __deriveWire = function deriveWireResponse(",  // embedded by source
  "__deriveWire(globalThis.__replay_result, globalThis.response, __effectLog, D.kind)",
  "__dg.response(__wire.status, __wire.body)",          // one derivation, digest included
]) {
  if (!epilogue.includes(needle)) failures.push(`the epilogue never does: ${needle}`);
}

for (const field of ["status", "held", "headers", "cookies", "body", "bodyB64", "binary", "isJson"]) {
  if (!epilogue.includes(`${field}: __wire.`)) {
    failures.push(`the parked output drops \`${field}\` — the response panel reads it`);
  }
}

if (failures.length) {
  console.error("replay wire-response derivation diverges from the serving path:\n");
  for (const f of failures) console.error("  ✗ " + f);
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log("replay wire-response derivation: ok");
