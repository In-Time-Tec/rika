# Better Auth owns hosted identity

Better Auth owns users, email and password identities, GitHub sign-in identities, sessions, OAuth grants, Organizations, memberships, and invitations in the control-plane PostgreSQL database. Rika references Better Auth member identifiers from its Project and Thread grants instead of duplicating identity tables.

The CLI is a public native OAuth client and signs in through device authorization with rotating refresh credentials stored in the operating-system credential store. Access tokens are short-lived and audience-bound to the Rika API. Browser approval displays the client, code, requested access, and server before accepting.

GitHub sign-in establishes identity only. Repository access uses a GitHub App installation and short-lived repository-scoped installation tokens so social login never grants implicit source access.
