# Generalist runs in the API

Rika composes Generalist's released PostgreSQL runtime and SQL worker in the Railway API. Generalist-owned PostgreSQL tables remain the only authority for Runs, model turns, journals, continuations, steering, approvals, cancellation, children, and Run events.

Local-device and E2B Executors host Workspace effects rather than a second Generalist runtime. The Generalist cell tool uses its released remote tool route with a stable operation key; Rika durably dispatches that operation to the current fenced Executor and deduplicates its result. Executors never connect directly to PostgreSQL.

This matches the split used by Amp Orbs: hosted identity, Thread state, collaboration, inference routing, and lifecycle coordinate an orb-side process that owns the repository and executes tools. It also permits stateless Railway replicas and replaceable E2B sandboxes without copying or reconstructing a SQLite Run store.

Generalist 0.45.1 and its version 4 `generalist_*` schema are the only supported runtime and persistence contract. There is no alternate schema, dual-read, dual-write, alias, or compatibility path. A linked nonterminal Run that Generalist definitively reports unavailable fails its Turn and releases the Thread queue; transient inspection failure remains active and retries.
