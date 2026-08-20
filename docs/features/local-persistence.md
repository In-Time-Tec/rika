# Persistence

PostgreSQL is the only authoritative durable store. Rika stores Hosted Owners, Organizations, Projects, Workspace Identities, Threads, Turns, commands, ordered events, projections, executor assignments, checkpoint manifests, credential metadata, integrations, and audit records in Rika-owned schemas. TenetKit stores Runs, registrations, operations, continuations, claims, and execution events in TenetKit-owned PostgreSQL tables. A release migration job applies ordered migrations before stateless API replicas become ready.

Clients persist only non-secret selection state and durable cursors. Their refresh credential and proof-of-possession private key stay in the operating-system credential store. A local Executor persists an opaque Workspace binding, highest observed fencing values, and encrypted idempotency receipts needed to reconnect safely. These local records cannot create product events, choose a Turn, resolve an approval, or replace PostgreSQL authority.

Executor filesystems, kernels, processes, PTYs, E2B pause state, and local caches are replaceable capability state. Verified content-addressed Workspace checkpoint artifacts live in object storage with their current manifest in PostgreSQL. Neither a local path, an E2B sandbox identifier, nor a provider snapshot is product identity or recovery authority.
