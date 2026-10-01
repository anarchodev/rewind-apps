// The dashboard's API base is its own origin and nothing else. Run with node
// (`node admin/_tests/_api_base.node.mjs`) — this exercises the BROWSER bundle
// (`_static/`), which `rewind test` (the handler engine) does not load; the
// leading `_` keeps `rewind test` from treating it as a handler suite.
//
// The page is loaded the way a crafted link would load it — `?api=` naming
// another origin, and a value already sitting in storage from an older build —
// and every request it makes must still go to the page's own origin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ORIGIN = "https://app.rewindjs.com";
const EVIL = "https://evil.example";
const KEY = "rove.admin.api_base";

const store = new Map([[KEY, EVIL]]);
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const calls = [];
globalThis.window = {
  location: { origin: ORIGIN, search: "?api=" + encodeURIComponent(EVIL), href: ORIGIN + "/?api=" + EVIL },
  localStorage,
};
globalThis.localStorage = localStorage;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return { ok: true, status: 200, statusText: "OK", headers: { get: () => "application/json" },
           json: async () => ({}), text: async () => "" };
};

// 1. Every inline script in index.html runs before the bundle; none may take
//    the query parameter (or anything else) as an API base.
const here = fileURLToPath(new URL(".", import.meta.url));
const html = readFileSync(here + "../_static/index.html", "utf8");
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
  vm.runInNewContext(m[1], { window: globalThis.window, localStorage, location: globalThis.window.location, URLSearchParams });
}
assert.equal(globalThis.window.__rove_api_base, undefined, "index.html must not set an API base");

// 2. The bundle: requests go to the page's origin, and the stored value an
//    older build persisted is gone.
const { api, adminBase } = await import("../_static/api.js");
assert.equal(adminBase(), ORIGIN);
await api.whoami();
await api.provisionInstance("x");
assert.ok(calls.length >= 2, "expected the calls to reach fetch");
for (const url of calls) assert.ok(url.startsWith(ORIGIN + "/"), "request left the origin: " + url);
assert.equal(store.has(KEY), false, "the persisted override must be cleared");

console.log("ok — API base pinned to the page origin (" + calls.length + " requests checked)");
