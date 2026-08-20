const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const dataAttribute = (name: string) => name.replaceAll(/([A-Z])/g, "-$1").toLowerCase()

const layout = (title: string, page: string, content: string, attributes: Readonly<Record<string, string>> = {}) => {
  const bodyAttributes = Object.entries({ page, ...attributes })
    .map(([name, value]) => ` data-${escapeHtml(dataAttribute(name))}="${escapeHtml(value)}"`)
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Rika</title>
  <link rel="stylesheet" href="/assets/web.css">
  <script src="/assets/web.js" defer></script>
</head>
<body${bodyAttributes}>
  <main>
    <a class="brand" href="/">Rika</a>
    ${content}
    <p id="status" role="status" aria-live="polite"></p>
  </main>
</body>
</html>`
}

const field = (input: {
  readonly id: string
  readonly label: string
  readonly type?: string
  readonly autocomplete?: string
  readonly minlength?: number
  readonly value?: string
}) => `<label for="${input.id}">${input.label}</label>
<input id="${input.id}" name="${input.id}" type="${input.type ?? "text"}"${
  input.autocomplete === undefined ? "" : ` autocomplete="${input.autocomplete}"`
}${input.minlength === undefined ? "" : ` minlength="${input.minlength}"`}${
  input.value === undefined ? "" : ` value="${escapeHtml(input.value)}"`
} required>`

export const loginPage = (redirect: string) =>
  layout(
    "Log in",
    "login",
    `<h1>Log in</h1>
<form id="login-form">
  ${field({ id: "email", label: "Email", type: "email", autocomplete: "email" })}
  ${field({ id: "password", label: "Password", type: "password", autocomplete: "current-password" })}
  <button type="submit">Log in</button>
</form>
<button id="github" class="secondary" type="button">Continue with GitHub</button>
<p><a href="/forgot-password">Forgot password?</a></p>
<p>New to Rika? <a href="/signup?redirect=${encodeURIComponent(redirect)}">Create an account</a>.</p>`,
    { redirect },
  )

export const signupPage = (redirect: string) =>
  layout(
    "Create account",
    "signup",
    `<h1>Create an account</h1>
<form id="signup-form">
  ${field({ id: "name", label: "Name", autocomplete: "name" })}
  ${field({ id: "email", label: "Email", type: "email", autocomplete: "email" })}
  ${field({ id: "password", label: "Password", type: "password", autocomplete: "new-password", minlength: 12 })}
  <p class="hint">Use at least 12 characters.</p>
  <button type="submit">Create account</button>
</form>
<button id="github" class="secondary" type="button">Continue with GitHub</button>
<p>Already have an account? <a href="/login?redirect=${encodeURIComponent(redirect)}">Log in</a>.</p>`,
    { redirect },
  )

export const verifyEmailPage = () =>
  layout(
    "Verify email",
    "verify-email",
    `<h1>Verify your email</h1>
<p>Use the link in your email, or request a new verification message.</p>
<form id="verify-form">
  ${field({ id: "email", label: "Email", type: "email", autocomplete: "email" })}
  <button type="submit">Send verification email</button>
</form>
<p><a href="/login">Return to login</a></p>`,
  )

export const forgotPasswordPage = () =>
  layout(
    "Forgot password",
    "forgot-password",
    `<h1>Reset your password</h1>
<p>We will send reset instructions if the address belongs to an account.</p>
<form id="forgot-form">
  ${field({ id: "email", label: "Email", type: "email", autocomplete: "email" })}
  <button type="submit">Send reset email</button>
</form>
<p><a href="/login">Return to login</a></p>`,
  )

export const resetPasswordPage = (input: { readonly token: string; readonly error: string }) =>
  layout(
    "Reset password",
    "reset-password",
    `<h1>Choose a new password</h1>
${input.error.length === 0 ? "" : `<p class="error">This password reset link is invalid or expired.</p>`}
<form id="reset-form">
  ${field({ id: "password", label: "New password", type: "password", autocomplete: "new-password", minlength: 12 })}
  <button type="submit"${input.token.length === 0 ? " disabled" : ""}>Reset password</button>
</form>`,
    { token: input.token },
  )

export const newOrganizationPage = (redirect: string) =>
  layout(
    "Create organization",
    "organization-new",
    `<h1>Create your organization</h1>
<p>Every Rika account belongs to an organization.</p>
<form id="organization-form">
  ${field({ id: "name", label: "Organization name", autocomplete: "organization" })}
  ${field({ id: "slug", label: "Organization slug" })}
  <button type="submit">Create organization</button>
</form>`,
    { redirect },
  )

export const invitationPage = (input: { readonly id: string; readonly redirect: string }) =>
  layout(
    "Organization invitation",
    "invitation",
    `<h1>Organization invitation</h1>
<div id="invitation-details" aria-live="polite">Loading invitation…</div>
<div class="actions">
  <button id="accept" type="button">Accept invitation</button>
  <button id="reject" class="secondary" type="button">Decline</button>
</div>`,
    { invitation: input.id, redirect: input.redirect },
  )

export const devicePage = (input: { readonly userCode: string; readonly redirect: string }) =>
  layout(
    "Connect a device",
    "device",
    `<h1>Connect the Rika CLI</h1>
<p>Enter the code displayed by your CLI.</p>
<form id="device-form">
  ${field({ id: "user-code", label: "Device code", autocomplete: "one-time-code", value: input.userCode })}
  <button type="submit">Continue</button>
</form>`,
    { redirect: input.redirect },
  )

export const deviceApprovalPage = (input: { readonly userCode: string; readonly redirect: string }) =>
  layout(
    "Approve device",
    "device-approve",
    `<h1>Approve this device?</h1>
<dl id="device-details"><dt>Code</dt><dd>${escapeHtml(input.userCode)}</dd></dl>
<div class="actions">
  <button id="approve" type="button">Approve</button>
  <button id="deny" class="secondary" type="button">Deny</button>
</div>`,
    { userCode: input.userCode, redirect: input.redirect },
  )

export const consentPage = (input: { readonly query: URLSearchParams; readonly redirect: string }) => {
  const scopes =
    input.query
      .get("scope")
      ?.split(" ")
      .filter((scope) => scope.length > 0) ?? []
  const scopeList = scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")
  return layout(
    "Authorize application",
    "consent",
    `<h1>Authorize application</h1>
<p><strong>${escapeHtml(input.query.get("client_id") ?? "Unknown client")}</strong> requests access to:</p>
<ul>${scopeList}</ul>
<div class="actions">
  <button id="allow" type="button">Allow</button>
  <button id="cancel" class="secondary" type="button">Cancel</button>
</div>`,
    { redirect: input.redirect },
  )
}

export const accountPage = () =>
  layout(
    "Account",
    "account",
    `<h1>Your account</h1>
<section id="account">Loading account…</section>
<button id="logout" class="secondary" type="button">Log out</button>`,
  )

export const webStyles = `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, sans-serif;
  line-height: 1.5;
}
body {
  margin: 0;
  background: #111827;
  color: #f9fafb;
}
main {
  box-sizing: border-box;
  width: min(100% - 2rem, 34rem);
  margin: 4rem auto;
  padding: 2rem;
  border: 1px solid #374151;
  border-radius: 0.75rem;
  background: #1f2937;
}
.brand { color: #a5b4fc; font-weight: 700; text-decoration: none; }
h1 { line-height: 1.2; }
form { display: grid; gap: 0.75rem; }
label { font-weight: 600; }
input {
  box-sizing: border-box;
  width: 100%;
  padding: 0.7rem;
  border: 1px solid #6b7280;
  border-radius: 0.375rem;
  background: #111827;
  color: inherit;
  font: inherit;
}
button {
  margin-top: 0.75rem;
  padding: 0.7rem 1rem;
  border: 0;
  border-radius: 0.375rem;
  background: #818cf8;
  color: #111827;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
button.secondary { background: #d1d5db; }
button:disabled { cursor: not-allowed; opacity: 0.6; }
a { color: #c7d2fe; }
.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.hint { margin-top: -0.4rem; color: #d1d5db; font-size: 0.9rem; }
.error, #status.error { color: #fca5a5; }
#status.success { color: #86efac; }
dt { font-weight: 700; }
dd { margin: 0 0 0.75rem; }
`

export const webScript = `const body = document.body
const status = document.querySelector("#status")
const setStatus = (message, kind = "") => {
  status.textContent = message
  status.className = kind
}
const safePath = (value, fallback = "/") => {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback
  const destination = new URL(value, window.location.origin)
  return destination.origin === window.location.origin
    ? destination.pathname + destination.search + destination.hash
    : fallback
}
const signedQuery = () => window.location.search.slice(1)
const api = async (path, bodyValue, method = "POST") => {
  const options = { method, headers: { accept: "application/json" } }
  if (bodyValue !== undefined) {
    options.headers["content-type"] = "application/json"
    options.body = JSON.stringify(bodyValue)
  }
  const response = await fetch(path, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error_description || "The request failed")
  return data
}
const oauthBody = (value) => window.location.search.includes("sig=") ? { ...value, oauth_query: signedQuery() } : value
const finishAuthentication = async (result) => {
  if (result && result.url) {
    window.location.assign(result.url)
    return
  }
  window.location.assign(safePath(body.dataset.redirect, "/"))
}
const socialSignIn = async () => {
  setStatus("Opening GitHub…")
  const destination = safePath(body.dataset.redirect, "/")
  const result = await api("/api/auth/sign-in/social", oauthBody({
    provider: "github",
    callbackURL: destination,
    newUserCallbackURL: destination,
  }))
  if (result.url) window.location.assign(result.url)
}
if (body.dataset.page === "login") {
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    setStatus("Logging in…")
    try {
      const result = await api("/api/auth/sign-in/email", oauthBody({
        email: document.querySelector("#email").value,
        password: document.querySelector("#password").value,
        callbackURL: safePath(body.dataset.redirect, "/"),
      }))
      await finishAuthentication(result)
    } catch (error) { setStatus(error.message, "error") }
  })
  document.querySelector("#github").addEventListener("click", () => socialSignIn().catch((error) => setStatus(error.message, "error")))
}
if (body.dataset.page === "signup") {
  document.querySelector("#signup-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    setStatus("Creating account…")
    try {
      const result = await api("/api/auth/sign-up/email", oauthBody({
        name: document.querySelector("#name").value,
        email: document.querySelector("#email").value,
        password: document.querySelector("#password").value,
        callbackURL: safePath(body.dataset.redirect, "/"),
      }))
      if (result.token === null) setStatus("Check your email to verify your account.", "success")
      else await finishAuthentication(result)
    } catch (error) { setStatus(error.message, "error") }
  })
  document.querySelector("#github").addEventListener("click", () => socialSignIn().catch((error) => setStatus(error.message, "error")))
}
if (body.dataset.page === "verify-email") {
  document.querySelector("#verify-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    try {
      await api("/api/auth/send-verification-email", { email: document.querySelector("#email").value, callbackURL: "/organizations/new" })
      setStatus("Check your email for a verification link.", "success")
    } catch (error) { setStatus(error.message, "error") }
  })
}
if (body.dataset.page === "forgot-password") {
  document.querySelector("#forgot-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    try {
      await api("/api/auth/request-password-reset", { email: document.querySelector("#email").value, redirectTo: "/reset-password" })
      setStatus("If the account exists, reset instructions are on the way.", "success")
    } catch (error) { setStatus(error.message, "error") }
  })
}
if (body.dataset.page === "reset-password") {
  document.querySelector("#reset-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    try {
      await api("/api/auth/reset-password", { newPassword: document.querySelector("#password").value, token: body.dataset.token })
      window.location.assign("/login")
    } catch (error) { setStatus(error.message, "error") }
  })
}
if (body.dataset.page === "organization-new") {
  const name = document.querySelector("#name")
  const slug = document.querySelector("#slug")
  name.addEventListener("input", () => { slug.value = name.value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") })
  document.querySelector("#organization-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    try {
      await api("/api/auth/organization/create", { name: name.value, slug: slug.value })
      window.location.assign(safePath(body.dataset.redirect, "/"))
    } catch (error) { setStatus(error.message, "error") }
  })
}
if (body.dataset.page === "invitation") {
  const invitationId = body.dataset.invitation
  const details = document.querySelector("#invitation-details")
  api("/api/auth/organization/get-invitation?id=" + encodeURIComponent(invitationId), undefined, "GET")
    .then((invitation) => { details.textContent = "You were invited to join " + invitation.organizationName + " as " + invitation.role + "." })
    .catch((error) => setStatus(error.message, "error"))
  document.querySelector("#accept").addEventListener("click", async () => {
    try { await api("/api/auth/organization/accept-invitation", { invitationId }); window.location.assign(safePath(body.dataset.redirect, "/")) }
    catch (error) { setStatus(error.message, "error") }
  })
  document.querySelector("#reject").addEventListener("click", async () => {
    try { await api("/api/auth/organization/reject-invitation", { invitationId }); window.location.assign("/") }
    catch (error) { setStatus(error.message, "error") }
  })
}
if (body.dataset.page === "device") {
  document.querySelector("#device-form").addEventListener("submit", (event) => {
    event.preventDefault()
    const code = document.querySelector("#user-code").value.trim().toUpperCase()
    window.location.assign("/device/approve?user_code=" + encodeURIComponent(code))
  })
}
if (body.dataset.page === "device-approve") {
  const code = body.dataset.userCode
  const details = document.querySelector("#device-details")
  api("/api/auth/device?user_code=" + encodeURIComponent(code), undefined, "GET")
    .then((device) => {
      const client = document.createElement("dd")
      client.textContent = device.client_id || "Unknown client"
      const title = document.createElement("dt")
      title.textContent = "Client"
      details.append(title, client)
      const scopeTitle = document.createElement("dt")
      scopeTitle.textContent = "Requested access"
      const scope = document.createElement("dd")
      scope.textContent = device.scope || "None"
      details.append(scopeTitle, scope)
    })
    .catch((error) => setStatus(error.message, "error"))
  const decide = async (action) => {
    await api("/api/auth/device/" + action, { userCode: code })
    setStatus(action === "approve" ? "Device approved. Return to your CLI." : "Device denied.", "success")
    document.querySelector("#approve").disabled = true
    document.querySelector("#deny").disabled = true
  }
  document.querySelector("#approve").addEventListener("click", () => decide("approve").catch((error) => setStatus(error.message, "error")))
  document.querySelector("#deny").addEventListener("click", () => decide("deny").catch((error) => setStatus(error.message, "error")))
}
if (body.dataset.page === "consent") {
  const decide = async (accept) => {
    const result = await api("/api/auth/oauth2/consent", { accept, scope: new URLSearchParams(location.search).get("scope") || undefined, oauth_query: signedQuery() })
    if (result.url) window.location.assign(result.url)
  }
  document.querySelector("#allow").addEventListener("click", () => decide(true).catch((error) => setStatus(error.message, "error")))
  document.querySelector("#cancel").addEventListener("click", () => decide(false).catch((error) => setStatus(error.message, "error")))
}
if (body.dataset.page === "account") {
  const accountElement = document.querySelector("#account")
  api("/api/account", undefined, "GET").then((account) => {
    const identity = document.createElement("p")
    identity.textContent = account.user.name + " · " + account.user.email
    const list = document.createElement("ul")
    for (const membership of account.memberships) {
      const item = document.createElement("li")
      item.textContent = membership.organization.name + " (" + membership.role + ")"
      list.append(item)
    }
    accountElement.replaceChildren(identity, list)
  }).catch((error) => setStatus(error.message, "error"))
  document.querySelector("#logout").addEventListener("click", async () => { await api("/api/auth/sign-out", {}); window.location.assign("/login") })
}
`
