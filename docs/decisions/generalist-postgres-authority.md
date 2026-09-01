# Generalist runs in the API

Rika composes Generalist's released PostgreSQL runtime and SQL worker in the Railway API. Generalist-owned PostgreSQL tables remain the only authority for Runs, model turns, journals, continuations, steering, approvals, cancellation, children, operations, waits, and Run events.

Local-device and E2B Executors host Workspace effects rather than a second Generalist runtime. Generalist routes each native tool operation with a stable outer operation key. Rika durably dispatches that operation to the current fenced Executor, retains cancellation, and deduplicates its result. Executors never connect directly to PostgreSQL. Raw machine calls are not independently provider-idempotent, so an ambiguous unsafe `bash` or `edit` outcome remains unknown rather than being replayed.

This permits stateless Railway replicas and replaceable E2B sandboxes without copying or reconstructing a second Run store. Generalist 0.46.1 and its released schema are the only supported runtime and persistence contract. There is no alternate schema, dual-read, dual-write, alias, or compatibility path.
