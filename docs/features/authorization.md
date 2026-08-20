# Authorization

Every operation derives an immutable principal from its authenticated session or Executor credential, then authorizes the full Organization, Project, Workspace, Thread, and Turn ancestry. Caller-supplied identifiers locate candidates only. Cross-Organization misses do not reveal whether a resource exists, and every mutation revalidates current membership and grants while holding the rows it changes.

Organization roles govern membership and integration administration. Product roles are `viewer`, `controller`, `operator`, and `owner`. Grants reference a Better Auth membership identifier rather than a user identifier, so removing and re-adding a person cannot resurrect old access. A local Thread is creator-only by default; an E2B Thread may inherit Project grants. A Thread may add an Organization member but cannot add a cross-Organization or public principal.

An Organization owner has audited break-glass owner access. An Organization admin may manage integrations, credentials, and grants but does not silently receive Thread content. Human credentials never authorize an Executor, and an Executor principal is restricted to its current Workspace assignment, lease, and protocol actions.
