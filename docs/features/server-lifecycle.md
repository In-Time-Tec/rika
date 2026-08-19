# Server process lifecycle

Control-plane replicas are disposable. Readiness requires compatible Rika and Baton PostgreSQL schemas and the services needed to authorize and admit work. Deployments stop admission on a draining replica, release its claims and leases, and let another replica recover durable work. WebSocket reconnect uses database-backed session state and cursors; it never depends on routing back to the previous process.

Client lifecycle is independent from execution lifecycle. Quitting or losing the TUI removes one viewer but does not cancel a Turn, release an Executor assignment, or close a PTY. Cancellation is an explicit durable command. Revocation closes affected connections best-effort and immediately prevents newly committed mutations or feed events for that principal.

An Executor that cannot renew its lease stops accepting new side effects and loses the right to publish authoritative results. Local assignment loss requires explicit recovery rather than automatic duplicate execution. An idle E2B assignment checkpoints, pauses without memory after fifteen minutes, cold-resumes on authorized work, and is replaced under a higher generation only when provider reconciliation proves recovery is required.
