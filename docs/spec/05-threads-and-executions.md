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

Relay terminal failure detail is projected verbatim through the runtime boundary. A terminal event clears the active working state, and the app emits a synthetic generic failure only when a failed backend result contains no terminal failure event.

Following consumes Relay's uncapped live execution stream until it observes a canonical terminal event or an explicit externally actionable permission or tool-approval request. Internal waits do not stop top-level or child following. A missing resume cursor replays from the beginning with cursor deduplication, while a transport failure fails the adapter rather than fabricating terminal state. Relay 0.2.10 removes the former implicit 1,000-event stream cap, so terminal content and failure detail remain observable beyond the first replay page.

Deletion removes Rika product metadata and invokes only supported Relay deletion/retention operations. It must not partially erase canonical execution state while presenting success.

Prior-message editing, restoring, and forking create a new branch of Thread state and new Executions. Completed canonical execution history is never mutated.

## Streaming

In-process clients consume Effect Streams. If a future process boundary is introduced, the transport is a typed WebSocket protocol with cursor replay, heartbeats, bounded queues, cancellation, and reconnect semantics.
