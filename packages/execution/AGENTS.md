# @rika/execution

Owns the released Generalist adapter, Railway PostgreSQL API composition, Run schema hook, RuntimeWorker loop, model-provider registration, built-in Agent definitions, and projection from Run events to Rika execution events. PostgreSQL contains only Generalist execution state and remains separate from Rika product tables.

The API alone receives PostgreSQL, RunStore, claims, RuntimeWorker, and agent-loop authority. Runner and Orb executors receive no database services; they execute the four native workspace tools through `RemoteTools`, deduplicated by Generalist's stable operation key. In-memory Runtime layers exist only for deterministic tests.

Generalist remains the sole authority for Runs, model turns, journals, continuations, steering, approvals, cancellation, children, and events. Do not duplicate its tables, query them directly, or invent a parallel Run protocol.
