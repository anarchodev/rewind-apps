// Invite-accept page (#/invite/:token). Auth-OPTIONAL: a logged-out visitor is
// offered sign-in with return_to back to THIS url, so the emailed magic-link
// survives the OIDC round-trip. A logged-in visitor POSTs acceptInvite(token);
// acceptance is email-bound server-side (the session must be the invited
// address), so a wrong-email session gets a clear 403 message.

import { ApiError } from "../api.js";

export function render(root, { api, params, who }) {
  const token = params.token;
  const wrap = document.createElement("div");
  wrap.className = "login";
  root.appendChild(wrap);

  function show(title, body, link) {
    wrap.replaceChildren();
    const h = document.createElement("h1");
    h.textContent = title;
    wrap.appendChild(h);
    const p = document.createElement("p");
    p.textContent = body;
    wrap.appendChild(p);
    if (link) {
      const pp = document.createElement("p");
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = link.label;
      pp.appendChild(a);
      wrap.appendChild(pp);
    }
  }

  if (!who) {
    const dest = "/_rp/login?return_to=" +
      encodeURIComponent("/#/invite/" + encodeURIComponent(token));
    show("Team invitation",
      "Sign in with the invited email address to accept.",
      { href: dest, label: "Sign in to accept" });
    return;
  }

  show("Team invitation", "Accepting…");
  api.acceptInvite(token).then((res) => {
    if (res && res.aid) api.setActiveAccount(res.aid); // land in the joined team
    const name = res && res.name ? `"${res.name}"` : "the team";
    show("Invitation accepted", `You've joined ${name}.`,
      { href: "#/instances", label: "Go to your instances" });
  }).catch((e) => {
    let body = "Could not accept this invitation.";
    if (e instanceof ApiError) {
      if (e.status === 403)
        body = "This invitation was sent to a different email address. " +
               "Sign out and sign back in with the invited address to accept.";
      else if (e.status === 410)
        body = "This invitation has expired. Ask the team owner to send a new one.";
      else if (e.status === 404)
        body = "This invitation is no longer valid (already used or revoked).";
    }
    show("Team invitation", body, { href: "#/instances", label: "Continue" });
  });
}
