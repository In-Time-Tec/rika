# Repository access

GitHub sign-in establishes user identity only. Repository access uses a separate GitHub App installation bound to one Hosted Owner. An authorized personal user or Organization owner or admin starts a short-lived installation intent; the setup callback records an untrusted candidate, then user authorization and an app-signed GitHub query verify that the same signed-in person may bind the installation.

The API mints installation tokens only when needed, narrows them to one repository and the required permissions, keeps them in memory until shortly before expiry, and never returns them to a client or stores them in a Workspace. Webhooks are authenticated over the exact raw body, deduplicated by delivery identifier, committed quickly, and reconciled against GitHub as authority for installation and repository state.

A Project binds an admitted GitHub repository identity and immutable checkout revision. Removing, suspending, or narrowing the installation denies new repository work and cancels affected leases. An already issued token may remain valid until GitHub rejects it or it expires, so reconciliation and fencing prevent its result from becoming current after revocation.
