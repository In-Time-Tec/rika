# Baton runs in the control plane

Rika composes Baton's released PostgreSQL runtime and SQL worker in the Railway control plane. Baton-owned PostgreSQL tables remain the only authority for Runs, model turns, journals, continuations, steering, approvals, cancellation, children, and Run events.

Local-device and E2B Executors host Workspace effects rather than a second Baton runtime. The Baton cell tool uses its released remote tool route with a stable operation key; Rika durably dispatches that operation to the current fenced Executor and deduplicates its result. Executors never connect directly to PostgreSQL.

This matches the split used by Amp Orbs: hosted identity, Thread state, collaboration, inference routing, and lifecycle coordinate an orb-side process that owns the repository and executes tools. It also permits stateless Railway replicas and replaceable E2B sandboxes without copying or reconstructing a SQLite Run store.
