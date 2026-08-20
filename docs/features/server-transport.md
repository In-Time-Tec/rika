# Server transport

Clients and Executors use separate authenticated, versioned WebSocket contracts. A client first exchanges its short-lived proof-bound access token for a one-use connection ticket. An Executor proves possession of its enrolled device credential and current assignment. Neither protocol accepts bearer credentials in a query string, and every mutation is authorized again against current membership, grants, generation, and lease inside its database transaction.

Client commands carry explicit Organization and resource identifiers plus a UUID command identifier. The command ledger provides exactly-once-in-effect mutation results. Durable events are ordered per Organization, delivered at least once, acknowledged by cursor, and safe to resume on any replica. Presence and previews are separate best-effort frames. Bounded slow consumers reconnect from durable cursors rather than retaining unbounded process memory.

Executor commands and events carry assignment generation, lease epoch, directional sequence, and idempotency identity. Reconnect replays durable safe work and rejects every stale frame. Terminal output is cursor-based and multi-reader; terminal input requires the current single-writer lease. Client disconnect and `Quit` are local presentation events and never imply Turn cancellation.
