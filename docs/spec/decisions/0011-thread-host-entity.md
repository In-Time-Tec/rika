# ADR 0011: Thread Host Entity and Inbox Promotion

Status: Accepted

## Context

Pending Turn promotion was process-local: in-process drain loops and semaphores promoted queued turns, so a crash between enqueue and promotion stranded work until the next startup reconcile, and no durable fact represented "this Thread has a driver". Relay 0.1.0 ships named durable entities, a durable inbox with exactly-once delivery by idempotency key, and wake-on-message parking.

## Decision

Each Thread with durable work gets one perpetual Relay entity of kind `rika-thread` keyed by ThreadId, pinned to a deterministic in-process host model that answers every delivered promotion batch with the `promote_turn` tool. Promotion notifications are durable inbox sends: submit-time notifications use idempotency key `rika:turn:<turn-id>`; reconcile and completion nudges use time-scoped keys so re-notification always wakes the host. The `promote_turn` handler invokes an app-registered promoter that runs the existing claim-and-start sequence; FIFO ordering and wait-blocked rules stay in `claimNextQueued` SQL, and exactly-once Turn start stays anchored in that claim plus the Relay start idempotency key. Steering remains Relay steering and is never delivered through the inbox. The contract members are optional during the migration window; without them the app promotes in-process exactly as before.

## Consequences

Promotion survives process crashes and is observable as durable inbox facts. The Thread Host entity is a driver, not a container: Turns keep their `execution:<turn-id>` identity and per-Turn model routing. The host agent registers with a wait-turn limit far above the continue-as-new threshold, and Rika never mints the reserved `execution:entity:*`, `address:entity:*`, or `session:entity:*` namespaces. Run mode keeps its synchronous drain loop because a one-shot CLI must finish promotion before exit.
