# Threads and Executions

## Thread

A Thread is Rika product state grouping user-visible Turns, metadata, references, and execution projections within one Workspace.

## Execution Mapping

- Each Turn has one deterministic top-level Relay Execution reference.
- Each Thread has one stable Relay Session reference.
- Child executions are projected beneath their parent Turn.
- Rika persists the last applied execution cursor with projection updates.
- Projection application is idempotent.
- Rika persists a product-owned semantic transcript projection. Relay events remain the execution record; the projection is the bounded read model used by clients.

Normal input accepted while a Turn is active becomes a product-owned Pending Turn. It receives a new top-level Execution only after promotion. Steering is the only user input added to the active Execution.

`@rika/runtime` is the adapter boundary around Relay. Its product-facing contract accepts Thread and Turn identifiers, ordered text/image prompt parts, timestamps, and cursors. Image parts contain a media type, base64 bytes, and optional filename and remain structured through Baton model input. It returns normalized execution status and product events. Relay identifiers, schemas, runtime layers, agent registration, and SQLite composition do not cross into `@rika/app`, tools, or TUI packages.

The runtime exposes a client-requiring adapter layer for deterministic tests. Production execution lives only in the Resident Rika Service. The service supplies the Relay client, runner runtime, language model, tool runtime, route-driven `ExecutionBackend`, and all Operation and Turn admission, following, promotion, and reconciliation fibers without changing the product-facing contract. CLI and TUI clients do not open execution persistence or run reconciliation.

The Relay Session identifier is `session:<thread-id>` and the top-level Relay Execution identifier is `execution:<turn-id>`. Starting the same Turn again uses the same idempotency key and returns the existing execution without duplicating visible events.

Every Thread with durable work has one Thread Host: a perpetual Relay entity of kind `rika-thread` keyed by the ThreadId. The runtime adapter registers the kind once per boot, establishes the instance idempotently through entity get-or-create, and exposes only product-vocabulary contract methods (`ensureThreadHost`, `notifyThreadHost`, `registerTurnPromoter`). The Thread Host drives Pending Turn promotion; Turns remain top-level Executions with unchanged identity, and entity identifiers never cross the adapter boundary. The reserved `execution:entity:*`, `address:entity:*`, and `session:entity:*` namespaces belong to Relay; Rika never mints them.

## Lifecycle

Rika supports creation, continuation, listing, search, rename, label, pin, archive, unarchive, delete, export, fork, and prior-turn navigation.

Durable execution terminal events control Turn terminal state. Model completion controls finalized assistant content only. Status derivation searches the event history for terminal state rather than assuming the terminal event is last, and replay, inspection, and follow reconcile missed terminal events before waiting or retaining a nonterminal projection.

Relay terminal failure detail is projected verbatim through the runtime boundary. A terminal event clears the active working state, and the app emits a synthetic generic failure only when a failed backend result contains no terminal failure event.

Following consumes Relay's uncapped live execution stream until it observes a canonical terminal event or an explicit externally actionable permission or tool-approval request. Internal waits do not stop top-level or child following. A missing resume cursor backfills through Relay's public bidirectional execution-event pages, then resumes the live stream from the newest applied cursor. A transport failure fails the adapter rather than fabricating terminal state.

The transcript projection stores semantic entries with stable keys, revisions, chronological ordering, source cursor bounds, and Schema-encoded product content. Replacing one Turn projection stores its newest checkpoint in the same row and transaction. The append interface applies an event and advances that checkpoint atomically; reapplying the same cursor is a no-op. A projection version mismatch rebuilds from Relay pages without changing canonical execution history.

Thread and transcript reads are keyset pages, never unbounded arrays. The initial read returns the newest fifty entries in chronological order plus the older-page cursor. Loading older history prepends the next chronological page while preserving the visible anchor. Raw Relay event pages never cross the product-facing runtime or resident interfaces.

Deletion removes Rika product metadata and invokes only supported Relay deletion/retention operations. It must not partially erase canonical execution state while presenting success.

Prior-message editing, restoring, and forking create a new branch of Thread state and new Executions. Completed canonical execution history is never mutated.

## Streaming

Resident service internals consume Effect Streams. Execution-capable CLI and TUI processes use the one current local typed WebSocket contract specified by ADR 0007. It carries Schema-tagged transcript page, prepend, keyed patch, and resync frames. Interactive frames name the exact wire contract. Page entries and patch frames carry projection revisions. Normal delivery is bounded; overflow collapses pending transcript deltas into one resync requirement rather than retaining an unbounded event list.

Threads, Turns, execution references, and execution projections remain durable in SQLite when a connection closes. A client-owned Interactive operation keeps one logical session and callback across socket close, heartbeat timeout, resident drain, and resident replacement. Its supervisor reconnects with bounded exponential delay, opens a fresh physical Interactive operation, requests the current transcript page and projection revision, and swaps the physical session behind the existing client session. Safe read actions may resume on the replacement. An in-flight mutation has an unknown outcome, emits `ExecutionFailed`, and is never resent automatically. Relay and product persistence continue to own their existing durable execution and projection behavior; the resident transport carries bounded read-model changes but does not become a second durable store.

Rika owns a durable Thread Summary projection for thread-facing views. It combines product Thread metadata with Turn status, last activity, read state, and edit totals derived from normalized execution events. The summary status is `running`, `waiting`, `queued`, or `idle`; ordering is pinned first, then most recent activity, then Thread identifier. Edit totals count unified-diff additions, removals, and paired replacements, and are omitted while historic projection repair is incomplete. Relay remains the execution truth. Rika replaces each per-Turn aggregate from Relay replay so projection is idempotent and restart-repairable.

Interactive clients receive an initial Thread Summary list and a bounded live replacement stream. Selecting a Thread marks it read. Activity in a different Thread makes it unread until selected. The in-memory notification stream is only an invalidation signal; SQLite remains the durable projection and a late subscriber queries the current snapshot before consuming further changes.

## Resident Service Lifecycle

One Resident Rika Service exists for each canonical Profile/data-root identity. Its state machine is explicit and monotonic except for the stated grace cancellation:

```text
starting -> ready -> grace -> draining -> stopped
               ^       |
               +-------+ new authenticated client
```

`starting` owns the bound listener and performs authentication setup, product and Relay migration, route registration, runtime acquisition, and startup reconciliation. It accepts handshakes but returns a typed `starting` response until it can serve requests. `ready` admits authenticated clients and work. Disconnect of the final authenticated client enters a bounded `grace` timer; a new authenticated client cancels that timer and returns the service to `ready`. Grace expiry or SIGINT/SIGTERM enters `draining`. Draining rejects new execution admission, stops accepting new clients, completes or interrupts owned request/subscription fibers according to their cancellation contract, flushes projections, stops Relay hosts, closes Relay then product SQLite, and only then closes the listener and reaches `stopped`. The listener remains bound throughout starting, ready, grace, and draining, including database close. `SIGKILL` performs no cleanup, but the OS releases the listener so a replacement may bind and reconcile durable state.

Startup-state messages require two-sided capability negotiation. Legacy clients keep the ready-only handshake. Startup timeout and heartbeat timeout are transport failures, not execution outcomes.

Startup races converge through the OS-owned exclusive bind on the derived loopback endpoint. The bind winner becomes the service. A bind loser connects, authenticates, verifies identity and protocol compatibility, and attaches; it never opens either database. PID files, directories, process metadata, and SQLite locks are diagnostics only and never establish service ownership.
