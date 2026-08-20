# Better Auth owns hosted identity

Better Auth owns users, email and password identities, GitHub sign-in identities, sessions, OAuth grants, Organizations, memberships, and invitations in the API PostgreSQL database. Rika references Better Auth member identifiers from its Project and Thread grants instead of duplicating identity tables.

Each CLI installation is a public native OAuth client and signs in through device authorization with a proof-of-possession key and rotating refresh credentials stored in the operating-system credential store. Access tokens are short-lived and audience-bound to the Rika API. Browser approval displays the client, code, requested access, and server before accepting. Disabling one installation revokes only that installation's grants.

GitHub sign-in establishes identity only. Repository access uses a GitHub App installation and short-lived repository-scoped installation tokens so social login never grants implicit source access.
