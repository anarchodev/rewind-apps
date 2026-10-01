// KV usage against the plan cap (rove#299): the level thresholds, the upgrade
// path from the warning, and the route's authz. Both figures are the engine's
// (`platform.instances.usage`), seeded per instance.
import { scenario, expect } from "rewind:test";

const RP_CONFIG = {
  issuer: "https://auth.rewindjs.com",
  client_id: "admin-dashboard",
  redirect_uri: "https://app.rewindjs.com/_rp/callback",
  operator_prefix: "_admin/operator/",
};
const FAR = 4102444800000;
const uh = (email) => crypto.sha256(email.trim().toLowerCase()); // == userHashFor
const j = JSON.stringify;
const sess = (sub, is_root) => j({ sub, is_root, exp: FAR });

const alice = "alice@x.com", bob = "bob@x.com", carol = "carol@x.com";
const A = uh(alice), B = uh(bob);
const TEAM = "team1";
const MiB = 1024 * 1024;
const CAP = 64 * MiB;
const INC = "0000000000000000";

// team1 (free) owns one instance per fill level; alice owns team1, bob is a
// member, carol is neither.
const LEVELS = { calm: 10 * MiB, warm: 50 * MiB, hot: 60 * MiB, full: CAP, unknowncap: 5 * MiB };
const BASE = {
  "_config/oidc/rp/default": RP_CONFIG,
  "_rp/sess/al": sess(alice, false),
  "_rp/sess/bo": sess(bob, false),
  "_rp/sess/ca": sess(carol, false),
  ["account/" + TEAM + "/members/" + A]: "owner",
  ["account/" + TEAM + "/members/" + B]: "member",
  ["user/" + A + "/accounts/" + TEAM]: "owner",
  ["user/" + B + "/accounts/" + TEAM]: "member",
  ["account/" + TEAM + "/plan"]: "free",
};
const INSTANCES = {};
for (const [id, used] of Object.entries(LEVELS)) {
  BASE["account/" + TEAM + "/instances/" + id] = "";
  BASE["instance/" + id + "/owner"] = TEAM;
  BASE["instance/" + id + "/incarnation"] = INC;
  INSTANCES[id] = { usage: id === "unknowncap"
    ? { usedBytes: used, durableBytes: used, overlayBytes: 0, entries: 3 }
    : { usedBytes: used, durableBytes: used, overlayBytes: 0, entries: 3, capBytes: CAP } };
}
const s = scenario({ admin: true, now: "2026-07-01T00:00:00Z", seed: 7, kv: BASE, instances: INSTANCES });
const readUsage = (id, sid) => s.inbound({ method: "GET", path: "/v1/instances/" + id + "/usage",
  host: "app.rewindjs.com", session: sid ? { id: sid } : undefined });

// ── levels: ok < 75% ≤ warn < 90% ≤ critical < 100% ≤ full ────────────────
const calm = readUsage("calm", "al");
expect(calm.status).toBe(200);
expect(calm.body.used_bytes).toBe(10 * MiB);
expect(calm.body.cap_bytes).toBe(CAP);
expect(calm.body.level).toBe("ok");
expect(readUsage("warm", "al").body.level).toBe("warn");      // 78%
expect(readUsage("hot", "al").body.level).toBe("critical");   // 94%
expect(readUsage("full", "al").body.level).toBe("full");      // 100%
// No cap reported → no level to claim; the figure still shows.
const unk = readUsage("unknowncap", "al");
expect(unk.body.level).toBe("unknown");
expect(unk.body.cap_bytes).toBe(null);
expect(unk.body.used_bytes).toBe(5 * MiB);

// ── the upgrade path is reachable from the warning — for an owner ─────────
const own = readUsage("warm", "al").body;
expect(own.can_upgrade).toBe(true);
expect(own.account).toBe(TEAM);
expect(own.plan).toBe("free");
// A member reads the meter but cannot reach billing; the UI names who can.
const mem = readUsage("warm", "bo");
expect(mem.status).toBe(200);
expect(mem.body.can_upgrade).toBe(false);

// ── authz: reach over usage is reach over the tenant ──────────────────────
expect(readUsage("warm", null).status).toBe(401);
expect(readUsage("warm", "ca").status).toBe(403);
expect(readUsage("ghost", "al").status).toBe(403); // no owner row → refused, not 404
