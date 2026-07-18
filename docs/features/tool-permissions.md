# Tool permissions

Built-in coding tools carry default permission metadata, and specialist agents receive only the capabilities required by their role. Workspace shell policy applies equally to shell commands entered by the user and shell calls requested by a model or Task agent: `allow` runs directly, `ask` waits for an explicit decision, and `deny` refuses without starting a process.

Only an explicit permission wait creates an actionable approval. Refusing the shell prompt or lacking a pinned capability returns a tool failure without running the operation, and cancellation ends the wait rather than granting access. A pending durable tool decision survives client restart, while a cancelled local shell prompt grants nothing and must be requested again.
