// rove admin entry point. Hash-based router — no build step required.
//
// Routes:
//   #/login        → OIDC RP redirect (no form)
//   #/provision    → name your first instance (post-login, 0 owned)
//   #/instances    → list + create + delete + assign-domain
//   #/instance/:id → per-instance dashboard
//
// Auth: OIDC relying party. Every route except #/login calls
// `api.whoami()` before rendering. 401 → #/login (full-page redirect
// to the IdP). A signed-in account that owns no instance and isn't
// an operator is routed to #/provision. On success the platform sid
// cookie carries auth for every subsequent fetch.

import { api, ApiError } from "./api.js";
import * as login from "./pages/login.js";
import * as provision from "./pages/provision.js";
import * as instances from "./pages/instances.js";
import * as instance from "./pages/instance.js";
import * as cluster from "./pages/cluster.js";
import * as team from "./pages/team.js";
import * as invite from "./pages/invite.js";

// Route resolver. Static routes map exactly; `#/instance/:id`,
// `#/team/:aid`, and `#/invite/:token` are parameterized (prefix match).
function resolveRoute(hash) {
  if (hash === "#/login") return { page: login, params: {} };
  if (hash === "#/provision") return { page: provision, params: {} };
  if (hash === "#/instances") return { page: instances, params: {} };
  if (hash === "#/cluster") return { page: cluster, params: {} };
  if (hash === "#/team") return { page: team, params: {} };
  if (hash.startsWith("#/team/")) {
    const aid = decodeURIComponent(hash.slice("#/team/".length));
    if (aid.length > 0) return { page: team, params: { aid } };
  }
  if (hash.startsWith("#/invite/")) {
    const token = decodeURIComponent(hash.slice("#/invite/".length));
    if (token.length > 0) return { page: invite, params: { token } };
  }
  if (hash.startsWith("#/instance/")) {
    const id = decodeURIComponent(hash.slice("#/instance/".length));
    if (id.length > 0) return { page: instance, params: { id } };
  }
  return { page: instances, params: {} };
}

let currentTeardown = null;

async function route() {
  const hash = location.hash || "#/instances";
  const { page, params } = resolveRoute(hash);

  // Auth gate (one whoami per navigation). /v1/session →
  // {is_root,sub,accounts,active_account,owned} or null (401).
  const who = await api.whoami();
  if (page === login) {
    // Don't strand already-authed users on the login interstitial.
    if (who) {
      location.hash = "#/instances";
      return;
    }
  } else if (page === invite) {
    // The invite-accept page is auth-OPTIONAL: it renders for a logged-out
    // visitor (offering sign-in with return_to back to itself) so the email
    // magic-link survives the OIDC round-trip. It handles auth itself.
  } else {
    if (!who) {
      location.hash = "#/login";
      return;
    }
    // A signed-in non-operator with no instance in ANY account they belong
    // to is nudged to provision their first one; everyone else is kept off
    // the provisioning page.
    const hasInstance =
      (who.accounts || []).some((a) => (a.instances || []).length > 0) ||
      (who.owned || []).length > 0;
    const needsProvision = !who.is_root && !hasInstance;
    if (needsProvision && page !== provision) {
      location.hash = "#/provision";
      return;
    }
    if (!needsProvision && page === provision) {
      location.hash = "#/instances";
      return;
    }
  }

  if (typeof currentTeardown === "function") {
    try { currentTeardown(); } catch {}
  }
  currentTeardown = null;

  const root = document.getElementById("app");
  root.replaceChildren();

  try {
    const result = page.render(root, { goto, api, ApiError, params, who });
    if (typeof result === "function") currentTeardown = result;
  } catch (err) {
    root.textContent = `render failed: ${err.message}`;
    console.error(err);
  }
}

export function goto(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", route);

// Handy for console debugging.
window.__rove_api = api;
