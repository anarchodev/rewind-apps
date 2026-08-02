// First-instance provisioning. Reached after a successful OIDC login
// when the authenticated account owns no instance yet (app.js routes
// here). Identity is the server-verified id_token `sub`; the only
// input is the instance name (auth-domain-plan §4.7 "3-6 part 2").

import { ApiError } from "../api.js";

export function render(root, { goto, api }) {
  const wrap = document.createElement("div");
  wrap.className = "login";
  wrap.innerHTML = `
    <h1>Name your instance</h1>
    <p>You're signed in. Pick a name for your first instance.</p>
    <form class="provision-form">
      <label>
        <span>Instance name</span>
        <input type="text" name="name" autocomplete="off" required
               minlength="1" maxlength="63"
               pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
               title="lowercase letters, digits and hyphens"
               spellcheck="false">
        <small class="hint">The name becomes your instance's subdomain —
          lowercase letters, digits and hyphens.</small>
      </label>
      <button type="submit">Create instance</button>
      <p class="error" hidden></p>
    </form>
  `;
  const form = wrap.querySelector(".provision-form");
  const nameInput = form.querySelector("input[name=name]");
  const submit = form.querySelector("button[type=submit]");
  const err = form.querySelector(".error");

  function showError(msg) {
    err.textContent = msg;
    err.hidden = false;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const name = nameInput.value.trim();
    if (!name) {
      showError("Enter an instance name.");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Creating…";
    try {
      const created = await api.provisionInstance(name);
      // Straight to the new instance — its Code tab is where the first
      // deploy happens, and the header carries the URL it now answers on.
      goto("#/instance/" + encodeURIComponent(created?.name || name));
    } catch (e) {
      // Prefer the server's own sentence: the control plane is the only
      // party that knows WHICH rule a name broke, and guessing here is how
      // the form ended up advertising underscores it never accepted.
      const reason = (e instanceof ApiError && e.body && typeof e.body.error === "string")
        ? e.body.error
        : null;
      if (reason === "account_limit_reached") {
        showError(`Your plan allows ${e.body.limit} instance${e.body.limit === 1 ? "" : "s"}, and you have ${e.body.owned}.`);
      } else if (reason) {
        showError(reason[0].toUpperCase() + reason.slice(1) + ".");
      } else if (e instanceof ApiError) showError(`Provisioning failed (${e.status}).`);
      else showError(`Provisioning failed: ${e.message}`);
      submit.disabled = false;
      submit.textContent = "Create instance";
    }
  });

  nameInput.focus();
  root.appendChild(wrap);
}
