# Hosted identity

Users may create an account with email and password or sign in with GitHub. Every hosted user has exactly one Personal Owner and can use it without joining an Organization. A user may explicitly select an Organization Owner when an active Better Auth membership authorizes it; login defaults to the Personal Owner and selection is reversible. Organization roles remain `owner`, `admin`, and `member`.

`rika project create`, `rika project list`, and `rika project use` manage the selected Hosted Owner's Project boundary. Creating a Project selects it immediately; changing Hosted Owner clears Project selection. `rika secret set` and `rika secret revoke` manage encrypted environment values at the selected personal, Organization, or Project scope. Secret values are read from a hidden prompt, never accepted as command-line arguments, and the CLI prints only opaque revision metadata.

Orb egress remains confined by phase. When an Owner or Project has no stored policy, setup may
reach only `github.com` and `registry.npmjs.org` in addition to Rika's control endpoint, while
runtime has no default public destination. A stored phase policy replaces that default, including
with an empty allowlist. This lets a new Orb clone its assigned repository and install JavaScript
dependencies without silently opening runtime egress.

Each CLI installation registers as a constrained public native OAuth client and binds its device grant to a proof-of-possession key. It requests a device code, prints and optionally opens the verification page, polls at the server-provided interval, and handles pending approval, slower polling, denial, expiry, interruption, rate limits, and transport failure without exposing a browser session to the terminal. The resulting refresh token, private key, access token, and absolute access-token expiry are saved atomically in an owner-only local credential file. The CLI reuses the access token until 30 seconds before expiry; refresh is serialized across processes, and a protected request that returns 401 refreshes and retries at most once. The selected server and Hosted Owner remain non-secret profile settings. Signing out revokes that installation and removes local credentials. Signing out everywhere revokes every session and native-client grant for that user.

GitHub sign-in and GitHub repository authorization are independent. Connecting repositories requires a GitHub App installation selected by a user authorized for the Hosted Owner.
