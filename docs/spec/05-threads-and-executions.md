# Threads and Executions

## Thread

A Thread is Rika product state grouping user-visible Turns, metadata, references, and execution projections within one Workspace.

## Execution Mapping

- Each Turn has one deterministic top-level Relay Execution reference.
- Each Thread has one stable Relay Session reference.
- Child executions are projected beneath their parent Turn.
- Rika persists the last applied execution cursor with projection updates.
- Projection application is idempotent.

Normal input accepted while a Turn is active becomes a product-owned Pending Turn. It receives a new top-level Execution only after promotion. Steering is the only user input added to the active Execution.

`@rika/runtime` is the adapter boundary around Relay. Its product-facing contract accepts Thread and Turn identifiers, ordered text/image prompt parts, timestamps, and cursors. Image parts contain a media type, base64 bytes, and optional filename and remain structured through Baton model input. It returns normalized execution status and product events. Relay identifiers, schemas, runtime layers, agent registration, and SQLite composition do not cross into `@rika/app`, tools, or TUI packages.

The runtime exposes a client-requiring adapter layer for deterministic tests and a SQLite production composition layer. The production layer supplies the Relay client, runner runtime, language model, and tool runtime without changing the product-facing contract.

The Relay Session identifier is `session:<thread-id>` and the top-level Relay Execution identifier is `execution:<turn-id>`. Starting the same Turn again uses the same idempotency key and returns the existing execution without duplicating visible events.

Every Thread with durable work has one Thread Host: a perpetual Relay entity of kind `rika-thread` keyed by the ThreadId. The runtime adapter registers the kind once per boot, establishes the instance idempotently through entity get-or-create, and exposes only product-vocabulary contract methods (`ensureThreadHost`, `notifyThreadHost`, `registerTurnPromoter`). The Thread Host drives Pending Turn promotion; Turns remain top-level Executions with unchanged identity, and entity identifiers never cross the adapter boundary. The reserved `execution:entity:*`, `address:entity:*`, and `session:entity:*` namespaces belong to Relay; Rika never mints them.

## Lifecycle

Rika supports creation, continuation, listing, search, rename, label, pin, archive, unarchive, delete, export, fork, and prior-turn navigation.

Durable execution terminal events control Turn terminal state. Model completion controls finalized assistant content only. Status derivation searches the event history for terminal state rather than assuming the terminal event is last, and replay, inspection, and follow reconcile missed terminal events before waiting or retaining a nonterminal projection.

Following does not complete normally at an internal child wait or an unexpectedly exhausted Relay stream. Rika reconnects from the latest public cursor on a spaced schedule and reconciles public replay and inspection state until it observes a terminal event or an explicit externally actionable permission request. This bounded-delay safeguard covers Relay 0.0.50 history pages that can omit a terminal event beyond the first 1,000 rows and remains interruptible with its caller scope.

Deletion removes Rika product metadata and invokes only supported Relay deletion/retention operations. It must not partially erase canonical execution state while presenting success.

Prior-message editing, restoring, and forking create a new branch of Thread state and new Executions. Completed canonical execution history is never mutated.

## Streaming

In-process clients consume Effect Streams. If a future process boundary is introduced, the transport is a typed WebSocket protocol with cursor replay, heartbeats, bounded queues, cancellation, and reconnect semantics.
