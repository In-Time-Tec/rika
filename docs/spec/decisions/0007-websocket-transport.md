# ADR 0007: Resident Service WebSocket Transport

Status: Accepted

## Context

Rika requires concurrent CLI and TUI clients to converge on one resident execution owner while preserving bidirectional events, steering, permission answers, and cancellation while connected.

## Decision

Use Effect Streams inside the Resident Rika Service and a typed Effect WebSocket protocol over an OS-owned loopback listener between clients and that service. Do not use SSE. Provider and MCP transports remain governed by their published package contracts.

The resident protocol is connection-bound and has one current contract. The first client frame is a Schema-encoded handshake containing the exact wire version, client kind and version, canonical Profile/data-root digest, proof of the owner-only service token, and the complete current capability set. Both peers reject any version or capability mismatch with close code 4403 before exposing resident state. The wire version is an invalidation marker, not a compatibility family: a breaking change replaces the contract and every caller together.

After the handshake, Schema-framed request and response messages correlate an operation for the lifetime of that connection. Interactive operations can carry events and client actions over the same socket. Protocol decoding and operation failures are returned as typed errors when the connection is still usable.

Each connection has one scoped supervisor, one bounded outbound queue and writer, and serialized inbound handling. Frames larger than 1 MiB are rejected. Queue overload, socket close, and cleanup are typed transport failures and settle every pending request, action, startup wait, and heartbeat wait. Heartbeat keeps one probe outstanding, normally probes every five seconds, allows fifteen seconds for liveness, and treats any valid inbound frame as liveness. Heartbeat failure closes the connection and is never an execution result.

The service responds with `accepted` in `starting`, followed by `startup-ready` or `startup-failed`. There is no negotiated reduced feature set.

The protocol does not provide durable request idempotency keys or reconnect replay for mutations. A logical Interactive client supervisor may reconnect and create a new connection-bound request while preserving its client callback and stable session interface. It restores only repeatable read state and actions. A disconnect or resident drain leaves an in-flight mutation's outcome unknown; the client reports a visible failure and does not resend it. The client never falls back to another contract. A mismatch or draining resident triggers bounded replacement retries, then a clear replacement failure if another process still owns the endpoint.

The current contract includes bounded transcript read-model delivery. Interactive frames carry the wire version; page entries and patch frames carry projection revisions. Each interactive event is acknowledged, and each action has a bounded unacknowledged window. The first overflow interrupts the action, emits one resync requirement, and then emits a terminal failure without retaining an unbounded backlog. ADR 0014 owns the projection and rendering contract.

## Consequences

One physical bidirectional connection carries product requests, interactive events, and control messages. Durable Threads and Executions remain in SQLite after transport loss, but transport request state does not. The Interactive client supervisor reconnects with bounded exponential delay, refreshes durable read state on a fresh physical session, and never retries an ambiguous mutation. Mutation requests have no durable idempotency or reconnect-replay guarantee; interactive event delivery is acknowledgement-bounded. Browser origins are not supported; this is an owner-authenticated native local protocol. Listener ownership, lifecycle, and token storage are defined by ADR 0012 and specs 05 and 12.

## Rejected Alternatives

- SSE plus HTTP mutation endpoints: rejected because it splits one bidirectional interaction across unrelated mechanisms.
- Separate runtime per client: rejected because Relay SQLite and runtime notifications require one process owner.
