// The reference browser-agent WS saga — the flagship of the `rewind test` surface:
// a held WebSocket chain (browser.message frames), an LLM `after.fetch` resolved
// with a canned Claude response, the destructive-action confirm gate, and the
// getReplay bounce. Every frame threads its ctx + kv writes forward.
//
// The LLM endpoint/key/model come from `_config/*`; a stub endpoint lets the fetch
// be matched + resolved. tenant + correlationId are set so browser.getReplay can
// issue its read-only replay fetch.
//
// NOTE: the harness can't yet continue a WS conversation AFTER a fetch resume — a
// fetch resolve returns a plain node, not a WS-connection node, so `.receive(next
// frame)` on it drives the blob path, not the next onMessage. So the second leg of
// the confirm flow (confirm_result → act) and the getReplay follow-ups aren't
// asserted here (filed as a rove harness gap). Every branch is still covered up to
// its onLLM resume.
import { scenario, expect } from "rewind:test";

const s = scenario({
  now: "2026-07-01T00:00:00Z",
  tenant: "agent-sample",
  correlationId: "corr-1",
  kv: {
    "_config/llm_endpoint": "https://llm.stub/messages",
    "_config/anthropic_api_key": "sk-test",
    "_config/llm_model": "claude-opus-4-8",
  },
});

const frame = (o) => JSON.stringify(o);
const claude = (content) => ({ status: 200, done: true, body: JSON.stringify({ content }) });

// ── hello: reset transcript, stash the goal, ack "connected" ──────────────
const ws = s.ws({ path: "/agent" });
const hello = ws.receive(frame({ t: "hello", sid: "s1", goal: "buy milk" }));
expect(hello.disposition).toBe("held");
expect(hello.kv("agent/s1/goal")).toBe("buy milk");
expect(hello).toHaveSentFrame(/"t":"status".*connected/);
expect(hello.ctx).toEqual({ sid: "s1" });

// ── snapshot → think → hold on the LLM fetch (the core turn) ──────────────
const snap = hello.receive(frame({ t: "snapshot", sid: "s1",
  elements: [{ ref: "e1", role: "button", name: "Add to cart" }] }));
expect(snap.disposition).toBe("held");
expect(snap).toHaveFetched(/llm\.stub\/messages/);
expect(snap).toHaveSentFrame(/thinking/);

// ── onLLM: a normal tool_use → browser.act + the transcript persists ──────
// (regression: callLLM must thread the resume ctx via after.fetch opts.ctx — else
// sid is lost and the transcript writes to `agent/undefined/msgs`.)
const acted = snap.fetch(/llm\.stub/).resolve(claude(
  [{ type: "tool_use", id: "tu1", name: "click", input: { ref: "e1" } }]));
expect(acted.disposition).toBe("held");
expect(acted).toHaveSentFrame(/"t":"act".*"op":"click".*"ref":"e1"/);
expect(acted.ctx.pending_tool_id).toBe("tu1");
const msgs = acted.kv("agent/s1/msgs"); // read-only think() deferred the write to onLLM
expect(msgs.length).toBe(2);
expect(msgs[1].role).toBe("assistant");

// ── onLLM: no tool_use → the model is done ────────────────────────────────
const done = snap.fetch(/llm\.stub/).resolve(claude([{ type: "text", text: "All set." }]));
expect(done).toHaveSentFrame(/"t":"done".*All set/);

// ── onLLM: an LLM error is surfaced, the chain stays held ─────────────────
const err = snap.fetch(/llm\.stub/).resolve({ status: 500, ok: false });
expect(err.disposition).toBe("held");
expect(err).toHaveSentFrame(/LLM error 500/);

// ── the destructive-action confirm gate ───────────────────────────────────
const dsnap = hello.receive(frame({ t: "snapshot", sid: "s1",
  elements: [{ ref: "e9", role: "button", name: "Delete account" }] }));
const confirm = dsnap.fetch(/llm\.stub/).resolve(claude(
  [{ type: "tool_use", id: "tu2", name: "click", input: { ref: "e9" } }]));
expect(confirm).toHaveSentFrame(/"t":"confirm"/);
expect(confirm.ctx.confirm_tool_id).toBe("tu2");
expect(confirm.ctx.pending_action).toEqual({ op: "click", id: "tu2", ref: "e9" });

// ── getReplay: model asks for server history → snapshot bounce ────────────
// (regression for the onLLM `refs` TDZ bug — pre-fix this activation threw.)
const gr = snap.fetch(/llm\.stub/).resolve(claude(
  [{ type: "tool_use", id: "tu3", name: "getReplay", input: {} }]));
expect(gr.disposition).toBe("held");
expect(gr).toHaveSentFrame(/"op":"snapshot"/);
expect(gr.ctx.replay_tool_id).toBe("tu3");

// ── terminal paths: bye frame + disconnect both release the chain ─────────
const bye = hello.receive(frame({ t: "bye" }));
expect(bye.disposition).toBe("terminal");
expect(bye.body).toBe("bye");

const gone = hello.disconnect();
expect(gone.disposition).toBe("terminal");
expect(gone.body).toBe("bye");
