# Native reviews

`rika review` runs one review Turn for the supplied request. The Turn has one root execution and an immutable initial fan-out with three ordered lanes:

- `correctness` checks behavioral defects, regressions, invalid assumptions, and missing acceptance coverage.
- `security` checks authority leaks, unsafe inputs, sensitive-data exposure, and denial-of-service risks.
- `quality` checks maintainability, boundaries, reliability, and verification problems that affect production use.

The initial fan-out is admitted atomically with concurrency `3`. Generalist waits for all lanes, including failed or cancelled lanes, before the fan-out joins. The fan-out admission key makes repeated starts for the same Turn idempotent. A restart returns the same execution link instead of admitting another review.

Cancellation requests cancellation for the root and admitted review lanes. Rika exposes projected progress and results through its five-operation execution gateway: `startTurn`, `cancelTurn`, `steerTurn`, `watchTurn`, and `inspectTurn`. Projected events include fan-out admission and join counts, child lifecycle, lane model output, and terminal execution status.

Review state does not use a Rika review ledger or table. Generalist owns the durable execution records; Rika consumes their projected events.
