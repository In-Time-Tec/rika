# Remote execution

This provider-neutral package owns protocol version 1 and executor-side runtime contracts shared by Runner and Orb targets. It has no provider lifecycle SDK and no API persistence.

The executor owns workspace cells, coding tools, child processes, PTYs, filesystem checkpoint staging, and its resumable protocol session. It never owns Generalist RunStore or agent-loop authority and never receives Postgres, E2B controller, or GitHub App credentials. Generalist remains the sole durable Run authority behind the product `ExecutionGateway`.

Protocol messages carry a complete assignment fence: target, assignment, generation, executor, and provider instance. A provider instance ID is routing evidence only; every executor-originated control operation also requires a short-lived bootstrap or session credential. Reconnect resumes from the controller-acknowledged executor cursor. PTY output has its own append-only cursor.

Recovery version 1 persists the executor session and workspace filesystem only. A checkpoint is an immutable object descriptor with a SHA-256 digest and byte length; an API object inspector must verify both before accepting it. Full-memory snapshots are not part of this protocol.
