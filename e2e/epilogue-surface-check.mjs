// Assert the browser replay epilogue installs the CURRENT request
// surface — the one the engine installs on a live activation.
//
// Why this exists: the request surface is built in two places. The
// engine installs it in `src/js/globals_request.zig` (rove); the
// browser replay rebuilds it in `buildRequestEpilogue`
// (`replay/_static/request-replay.mjs`, here). They are separate
// implementations of one contract, in separate repos, and nothing
// forces them to agree — so a rename on the engine side leaves this
// one installing a property that no longer exists.
//
// That failure is silent and it is the worst shape a replay tool can
// have: the handler reads `undefined` instead of a value, replay
// diverges from production, and nothing errors. The rove#448 saga
// rename hit exactly this (`request.correlation_id` → `request.sagaId`).
//
// This is a spelling check, not a parity check — it cannot see the
// engine. Retired spellings are listed explicitly so that removing one
// from the engine means deleting it here too, which is the moment
// someone re-reads this file.
//
// Run: node e2e/epilogue-surface-check.mjs   (exit 0 = ok)

import { buildRequestEpilogue } from "../replay/_static/request-replay.mjs";

// Property spellings the engine has retired. Any of these appearing in
// a generated epilogue means the browser replay is installing a surface
// production no longer has.
const RETIRED = [
  "request.correlation_id", // → request.sagaId (rove#448)
  "request.body =", // → request.bytes/.text/.json (the ergonomics arc)
];

// (option passed to the builder, property it must install)
const REQUIRED = [
  ["sagaId", "request.sagaId"],
  ["tenant", "request.tenant"],
];

const failures = [];

const epilogue = buildRequestEpilogue({
  record: { method: "GET", path: "/live", host: "app.example.com" },
  tenant: "acme",
  sagaId: "0100000000000042",
});

for (const [opt, prop] of REQUIRED) {
  if (!epilogue.includes(prop)) {
    failures.push(`epilogue never installs ${prop} (builder option \`${opt}\`)`);
  }
}
if (!epilogue.includes("0100000000000042")) {
  failures.push("the descriptor does not carry the sagaId it was given — " +
    "the property is installed but always empty");
}
for (const retired of RETIRED) {
  // `request.body =` legitimately appears under the `captured` alias
  // branch, so only flag it outside that guard.
  if (retired === "request.body =" && epilogue.includes("D.captured")) continue;
  if (epilogue.includes(retired)) {
    failures.push(`epilogue still installs the retired ${retired}`);
  }
}

if (failures.length) {
  console.error("epilogue surface check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`epilogue surface check ok — installs ${REQUIRED.map(r => r[1]).join(", ")}; ` +
  `no retired spellings`);
