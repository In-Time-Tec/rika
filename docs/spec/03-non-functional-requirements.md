# Non-Functional Requirements

## Correctness

- Durable side effects use stable idempotency keys.
- Cursor replay is monotonic and duplicate-safe.
- Failed dependencies produce typed failures rather than silent fallback.
- Configuration and persisted values are Schema-decoded at boundaries.

## Local Operation

- SQLite is the only required database.
- No daemon, Docker, Postgres, Rivet engine, or hosted Rika service is required.
- The packaged artifact restores the terminal immediately and exactly once on success, failure, defect, signal, interruption, renderer initialization failure, and cleanup-step failure, before awaiting slower client cleanup.

## Performance

- Input remains responsive during streaming and tool execution.
- Render work is frame-bounded and does not block durable event consumption.
- Tool output and model context are bounded.
- Parallel work has explicit concurrency limits.
- Opening a Thread loads at most fifty transcript entries before the first interactive frame.
- The TUI mounts at most two hundred transcript entries, including overscan, regardless of durable history size.
- A live delta changes only its keyed transcript entry and fixed chrome. It never walks or recreates the complete transcript.
- Renderer updates are coalesced to at most one normal frame per sixteen milliseconds. Terminal results, permission requests, and resync frames bypass that delay.
- Resident interactive delivery uses bounded queues. A slow consumer receives a typed resync requirement rather than unbounded buffered history.
- The transcript benchmark covers 1, 10, 100, and 1,000 Turns. Input dispatch and a one-entry live patch stay under sixteen milliseconds at p95 on the supported packaged development target, and mounted renderable count stays constant after the window is full.
- The file-sidebar benchmark covers 10,000 changed or Workspace files. Opening builds one cached hierarchy, only viewport rows plus overscan enter OpenTUI content, and later composer updates stay under sixteen milliseconds at p95.

## Maintainability

- Baton and Relay are external dependencies used only through public exports.
- Every behavior-bearing service has a test or memory layer.
- Public behavior is specified before implementation.
- Feature completion requires real-flow evidence.
