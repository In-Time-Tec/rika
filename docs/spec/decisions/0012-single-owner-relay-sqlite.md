# ADR 0012: One Owner and One Runtime Graph per Relay SQLite File

Status: Accepted

## Context

Relay's embedded SQLite topology is single-process. Each published `SQLite.layer`, `SQLite.childFanOutLayer`, and `SQLite.workflowLayer` construction opens an independent SQLite client with its own one-permit semaphore. Equal filenames do not share that semaphore or the in-process notification graph. Rika previously built one runner, fan-out host, and workflow host for every model mode, allowing independent writers in one process and producing intermittent `effect/sql/SqlError: Failed to execute statement` errors even when the canonical Execution completed.

## Decision

One live owner holds a Relay SQLite file, and that owner constructs one process-lifetime Relay runtime graph over one shared SQLite client. Ownership is acquired before migrations or runtime layers start and is released only after every runtime-using fiber has terminated and the runtime has finalized. Modes and model tuning are immutable execution data routed through that graph; they never select or construct another database runtime. A second execution-capable process fails before opening the Relay database. Help, version, parse errors, and product-only commands remain lazy and do not acquire Relay ownership.

The dispatcher classifies parsed operations before constructing execution infrastructure. Interactive, run, review, workflow, and Thread continue require Relay. Config, doctor, extension, tool catalog, MCP, skill, and metadata-only Thread operations do not acquire the Relay lease or open its database. Interactive shutdown stops terminal input and rendering, awaits renderer initialization and tears down a renderer that arrives during shutdown, interrupts and awaits the snapshot of tracked fibers, and resumes the enclosing operation only after their cleanup, allowing runtime and ownership finalizers to run in scope order. No watcher or session fiber starts after shutdown has begun.

The published Relay package must expose composition that lets its runner, Child Run fan-out host, Workflow host, and Client share one SQLite client. Rika does not deep-import Relay internals or recreate that composition. Until that package contract is released and consumed, single-runtime completion remains blocked and release evidence must not claim the invariant is implemented.

## Consequences

Embedded Rika execution is deliberately single-owner. A TUI and a separate execution command cannot concurrently use the same Relay SQLite file; supporting concurrent clients requires a separately specified resident process with a typed WebSocket protocol. A cooperative process lease is containment rather than proof against older binaries that do not participate, so upgrades must stop or detect legacy owners before opening existing state.

Turn routing must persist the selected mode and non-secret resolved route identity before Relay acceptance so queued promotion and restart reconciliation use the original route. Ambiguous storage failure after Relay acceptance does not manufacture a terminal product status; only canonical Relay terminal state may terminalize the Turn.

Verification counts SQLite clients, migrations, runtime hosts, and notification graphs rather than inferring ownership from successful prompts. Process tests cover concurrent startup, graceful shutdown, `SIGKILL`, stale owner metadata, legacy binaries, and every acceptance-to-projection kill point.

## Rejected alternatives

- **WAL, busy timeout, or retries across independent clients:** rejected because they reduce lock frequency without creating one serialization or notification domain.
- **One Relay runtime per model mode:** rejected because mode is execution data and multiplying infrastructure by routing choice creates avoidable writers and recovery hosts.
- **A resident daemon now:** rejected because the product does not yet require concurrent execution clients and the protocol, lifecycle, authentication, replay, and upgrade surface is substantially larger than single-owner embedding.
- **Multi-process Relay SQLite:** rejected because Relay's SQLite notifications and worker ownership are process-local; true multi-process operation requires a server database and Relay's supported multi-node topology.

## Related docs

- `docs/spec/04-modes-and-model-routing.md`
- `docs/spec/05-threads-and-executions.md`
- `docs/spec/12-persistence.md`
- `docs/spec/15-testing.md`
- `docs/spec/decisions/0002-published-framework-dependencies.md`
- `docs/spec/decisions/0003-relay-execution-authority.md`
- `docs/spec/decisions/0005-effect-sql-sqlite.md`
