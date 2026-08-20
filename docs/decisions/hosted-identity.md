# Better Auth owns hosted identity

Better Auth owns users, email and password identities, GitHub sign-in identities, sessions, OAuth grants, Organizations, memberships, and invitations in the API PostgreSQL database. Rika gives every user one Personal Owner and optionally authorizes an Organization Owner through Better Auth membership. Rika scopes Projects, Threads, grants, credentials, and audit records to that stable Hosted Owner; organization actions reference Better Auth membership identifiers without making membership mandatory for personal actions.

Each CLI installation is a public native OAuth client and signs in through device authorization with a proof-of-possession key and rotating refresh credentials stored in the operating-system credential store. Access tokens are short-lived and audience-bound to the Rika API. Browser approval displays the client, code, requested access, and server before accepting. Disabling one installation revokes only that installation's grants.

GitHub sign-in establishes identity only. Repository access uses a GitHub App installation and short-lived repository-scoped installation tokens so social login never grants implicit source access.
