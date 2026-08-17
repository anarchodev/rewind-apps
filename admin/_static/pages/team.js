// Team / members page (#/team/:aid). Lists active members + pending invites for
// one account. An owner can invite by email, promote/demote members, remove
// members, and revoke pending invites; any member can view. A non-personal
// account can be left (last-owner-guarded server-side). The target account is
// the route param, else the UI's active account, else personal.

import { ApiError } from "../api.js";

export function render(root, { goto, api, params, who }) {
  if (!who) { goto("#/login"); return; }
  const accounts = who.accounts || [];
  const wanted = params.aid || api.getActiveAccount() || who.active_account;
  const acct = accounts.find((a) => a.aid === wanted)
    || accounts.find((a) => a.is_personal) || accounts[0];
  if (!acct) { root.textContent = "No account."; return; }
  const aid = acct.aid;
  const amOwner = acct.role === "owner";

  const wrap = document.createElement("div");
  wrap.className = "instances";
  wrap.innerHTML = `
    <header class="page-header">
      <h1 class="team-title"></h1>
      <nav class="page-nav">
        <a href="#/instances">Instances</a>
        <button type="button" class="leave-team" hidden>Leave team</button>
        <button type="button" class="logout">Sign out</button>
      </nav>
    </header>
    <p class="error" hidden></p>
    <section class="forms">
      <form class="invite-form" hidden>
        <h2>Invite a member</h2>
        <label><span>Email</span>
          <input name="email" type="email" required placeholder="teammate@example.com"></label>
        <button type="submit">Send invite</button>
        <p class="invite-note" hidden></p>
      </form>
    </section>
    <section>
      <h2>Members</h2>
      <table class="instance-table">
        <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody class="members"></tbody>
      </table>
    </section>
    <section class="pending-section">
      <h2>Pending invites</h2>
      <table class="instance-table">
        <thead><tr><th>Email</th><th>Expires</th><th></th></tr></thead>
        <tbody class="pending"></tbody>
      </table>
    </section>
    <section class="export-section">
      <h2>Your data</h2>
      <p>Download this account's records — members, roles, instances and
        billing metadata — as JSON. Each instance's own data (KV and code)
        exports from its page's Settings tab.</p>
      <button type="button" class="account-export">Download account data (JSON)</button>
    </section>
    <section class="danger-zone acct-danger" hidden>
      <h3 class="danger-title"></h3>
      <p class="danger-copy"></p>
      <form class="acct-delete-form">
        <label>
          <span class="danger-confirm-label"></span>
          <input type="text" name="confirm" autocomplete="off" spellcheck="false">
        </label>
        <button type="submit" class="danger" disabled></button>
      </form>
    </section>
  `;

  wrap.querySelector(".team-title").textContent =
    "Team — " + (acct.name || (acct.is_personal ? "Personal" : aid.slice(0, 8)));
  const errorBox = wrap.querySelector(".error");
  const membersBody = wrap.querySelector("tbody.members");
  const pendingBody = wrap.querySelector("tbody.pending");
  const inviteForm = wrap.querySelector(".invite-form");
  const inviteNote = wrap.querySelector(".invite-note");
  const leaveBtn = wrap.querySelector(".leave-team");

  if (amOwner) inviteForm.hidden = false;
  if (!acct.is_personal) leaveBtn.hidden = false;

  function showError(m) { errorBox.textContent = m; errorBox.hidden = false; }
  function clearError() { errorBox.hidden = true; errorBox.textContent = ""; }
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString() : "—";

  function actionButton(label, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  async function reload() {
    clearError();
    let res;
    try {
      res = await api.listMembers(aid);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { goto("#/login"); return; }
      showError(`Load failed: ${e.message}`);
      return;
    }
    const members = res.members || [];
    const pending = res.pending || [];
    const ownerCount = members.filter((m) => m.role === "owner").length;

    membersBody.replaceChildren();
    for (const m of members) {
      const tr = document.createElement("tr");
      const email = document.createElement("td");
      email.textContent = m.email || m.hash.slice(0, 12) + "…";
      tr.appendChild(email);
      const role = document.createElement("td");
      role.textContent = m.role;
      tr.appendChild(role);
      const actions = document.createElement("td");
      actions.className = "actions";
      if (amOwner) {
        if (m.role === "member") {
          actions.appendChild(actionButton("Make owner",
            () => doRole(m.hash, "owner")));
        } else if (m.role === "owner" && ownerCount > 1) {
          actions.appendChild(actionButton("Make member",
            () => doRole(m.hash, "member")));
        }
        // Remove is allowed except for the last owner (server enforces; we
        // also hide it on the sole owner to avoid an obvious dead click).
        if (!(m.role === "owner" && ownerCount <= 1)) {
          actions.appendChild(actionButton("Remove",
            () => doRemove(m.hash, m.email)));
        }
      }
      tr.appendChild(actions);
      membersBody.appendChild(tr);
    }

    pendingBody.replaceChildren();
    for (const p of pending) {
      const tr = document.createElement("tr");
      const email = document.createElement("td");
      email.textContent = p.email || p.hash.slice(0, 12) + "…";
      tr.appendChild(email);
      const exp = document.createElement("td");
      exp.textContent = fmtDate(p.exp_ms);
      tr.appendChild(exp);
      const actions = document.createElement("td");
      actions.className = "actions";
      if (amOwner) {
        actions.appendChild(actionButton("Revoke",
          () => doRevoke(p.hash, p.email)));
      }
      tr.appendChild(actions);
      pendingBody.appendChild(tr);
    }
    wrap.querySelector(".pending-section").hidden = pending.length === 0 && !amOwner;
  }

  async function doRole(hash, role) {
    clearError();
    try { await api.setMemberRole(aid, hash, role); await reload(); }
    catch (e) {
      showError(e instanceof ApiError && e.status === 409
        ? "Can't change the last owner — promote another owner first."
        : `Failed: ${e.message}`);
    }
  }
  async function doRemove(hash, email) {
    if (!confirm(`Remove ${email || "this member"} from the team?`)) return;
    clearError();
    try { await api.removeMember(aid, hash); await reload(); }
    catch (e) {
      showError(e instanceof ApiError && e.status === 409
        ? "Can't remove the last owner."
        : `Remove failed: ${e.message}`);
    }
  }
  async function doRevoke(hash, email) {
    clearError();
    try { await api.revokeInvite(aid, hash); await reload(); }
    catch (e) { showError(`Revoke failed: ${e.message}`); }
  }

  inviteForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearError();
    inviteNote.hidden = true;
    const email = String(new FormData(inviteForm).get("email") || "").trim();
    if (!email) return;
    try {
      const res = await api.inviteMember(aid, email);
      inviteForm.reset();
      // Dev/test seam: no Resend key configured → the server hands back the
      // accept link so the flow is followable without a mailbox.
      if (res && res.accept_url) {
        inviteNote.textContent = "Invite link (no email configured): " + res.accept_url;
        inviteNote.hidden = false;
      } else {
        inviteNote.textContent = "Invitation emailed to " + email + ".";
        inviteNote.hidden = false;
      }
      await reload();
    } catch (e) {
      showError(e instanceof ApiError && e.status === 409
        ? "That person is already a member."
        : `Invite failed: ${e.message}`);
    }
  });

  leaveBtn.addEventListener("click", async () => {
    if (!confirm("Leave this team? You'll lose access to its instances.")) return;
    clearError();
    try { await api.leaveAccount(aid); goto("#/instances"); }
    catch (e) {
      showError(e instanceof ApiError && e.status === 409
        ? "You're the last owner — promote another owner before leaving."
        : `Leave failed: ${e.message}`);
    }
  });

  wrap.querySelector(".logout").addEventListener("click", () => {
    window.location.assign("/_rp/logout?return_to=" + encodeURIComponent("/#/login"));
  });

  // ── Account export + deletion (rove#340) ──────────────────────────
  wrap.querySelector(".account-export").addEventListener("click", async () => {
    clearError();
    try {
      const doc = await api.accountExport(aid);
      const blob = new Blob([JSON.stringify(doc, null, 2)],
                            { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "rewind-account-" + aid.slice(0, 8) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { showError(`Export failed: ${e.message}`); }
  });

  // The danger zone renders for the personal account (delete my account,
  // confirm = the account email) and for a team the caller owns (delete
  // the team, confirm = the team name). Deletion is IMMEDIATE — the copy
  // says so, and points at the exports first.
  const danger = wrap.querySelector(".acct-danger");
  const dForm = danger.querySelector(".acct-delete-form");
  const dInput = dForm.querySelector("input[name=confirm]");
  const dBtn = dForm.querySelector("button");
  const teamName = acct.name || "";
  const confirmWord = acct.is_personal ? (who.sub || "") : teamName;
  if (acct.is_personal || (amOwner && teamName)) {
    danger.hidden = false;
    if (acct.is_personal) {
      danger.querySelector(".danger-title").textContent = "Delete my account";
      danger.querySelector(".danger-copy").textContent =
        "Deletes your account and every instance it owns — handlers, KV "
        + "data, request history, and your sign-in itself. Immediate and "
        + "permanent: there is no grace period and no undo. Export your "
        + "data first (above, and each instance's Settings tab).";
      danger.querySelector(".danger-confirm-label").textContent =
        "Type your account email to confirm";
      dBtn.textContent = "Delete my account";
    } else {
      danger.querySelector(".danger-title").textContent = "Delete this team";
      danger.querySelector(".danger-copy").textContent =
        "Deletes the team \"" + teamName + "\" and every instance it owns, "
        + "for every member. Immediate and permanent — export first. "
        + "Members' personal accounts are untouched.";
      danger.querySelector(".danger-confirm-label").textContent =
        "Type the team name to confirm";
      dBtn.textContent = "Delete team";
    }
    dInput.placeholder = confirmWord;
    dInput.addEventListener("input", () => {
      dBtn.disabled = dInput.value !== confirmWord;
    });
    dForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (dInput.value !== confirmWord) return;
      clearError();
      dBtn.disabled = true;
      dBtn.textContent = "Deleting…";
      try {
        if (acct.is_personal) {
          await api.deleteAccount(dInput.value);
          // The account is going away under this session — leave it.
          window.location.assign("/_rp/logout?return_to=" + encodeURIComponent("/#/login"));
        } else {
          await api.deleteTeam(aid, dInput.value);
          api.setActiveAccount(who.active_account || "");
          goto("#/instances");
        }
      } catch (e) {
        if (e instanceof ApiError && e.body && e.body.error === "sole_owner_of_teams") {
          const names = (e.body.teams || [])
            .map((t) => t.name || t.aid.slice(0, 8)).join(", ");
          showError("You're the only owner of: " + names + ". Transfer "
            + "ownership or delete those teams first.");
        } else {
          const reason = (e instanceof ApiError && e.body && typeof e.body.error === "string")
            ? e.body.error : (e && e.message) || "unknown error";
          showError(`Delete failed: ${reason}`);
        }
        dBtn.disabled = false;
        dBtn.textContent = acct.is_personal ? "Delete my account" : "Delete team";
      }
    });
  }

  root.appendChild(wrap);
  reload();
}
