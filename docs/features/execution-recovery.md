# Execution recovery

After a replica stops, Generalist's PostgreSQL worker leases allow another API replica to resume a nonterminal Run under a newer attempt fence. Rika projectors backfill durable event pages from their stored Hosted Owner cursor and apply each event idempotently. Replica or client replacement abandons process-local delivery only; it does not cancel the Run or change its Thread.

Workspace operations are dispatched with a stable operation key to the current fenced Executor. An Executor returns a durable prior receipt for a repeated completed operation. Work known not to have started may be reassigned; an operation lost after starting without a durable receipt enters Generalist's unknown-outcome resolution when side effects are possible and is never blindly replayed. Stale assignment generations, lease epochs, Generalist attempt fences, checkpoint proposals, and terminal frames cannot replace current state.

Generalist owns unknown-outcome resolution. The transcript presents an unknown operation as a waiting notification, not an ordinary execution error, and preserves the known Run and operation IDs through projection rebuilds and reconnects. An authenticated client inspects a Run with `rika thread recovery inspect <thread-id> <run-id>`, which returns the Run ID and Generalist's status. For `needs-resolution`, the response explicitly includes `operationDetails: { _tag: "Unavailable", reason: ... }`; successful inspection does not mean successful execution. Generalist 0.46.1 exposes no public unresolved-operation details, replay policy, or result schema. Rika does not invent those details or offer automatic replay based on a tool's name.

An authorized operator can explicitly resolve a known operation using:

```sh
rika thread recovery abort <thread-id> <run-id> <operation-id> "reason"
rika thread recovery retry <thread-id> <run-id> <operation-id>
rika thread recovery accept <thread-id> <run-id> <operation-id> '<json-value>'
```

Abort records operation failure; it does not undo side effects or mean cancellation of the entire Turn. Retry may repeat side effects. Even `shell_command_status` consumes buffered output, so a read-only label is not evidence of safe replay. Accept requires a known correct result, not a guessed JSON value. The API authorizes the Thread and Run, then records the explicit resolution through Generalist's public `resolveOperation` with its idempotency key and returns a receipt. Rika keeps no private view of Generalist's operation tables, does not poll for recovery, and does not map late Executor receipts onto Generalist operations. Reconnecting or submitting another prompt never guesses the outcome.

An E2B child-process failure restarts inside the same sandbox. A lost sandbox increments the assignment generation before replacement, restores the exact repository identity plus the newest verified Workspace artifact, and then accepts new operations. A missing or corrupt artifact falls back to an older verified checkpoint or a clean exact checkout and reports possible work loss; partial restore is never declared current.

Rika fails a linked nonterminal Turn whose durable Run is unavailable and drains queued Turns behind it. A link-less Turn remains blocked because Rika has no durable execution evidence from which to invent an outcome. An independent hosted reconciler inspects nonterminal Runs and persists a terminal Turn status directly from Generalist authority. Transcript projection rebuilds its presentation units from Generalist's durable `RunTree.watch` continuity and takes usage from the authoritative tree checkpoint; it retries silence, transport failures, and store failures from Generalist's cursor, and projection failure is observable but cannot cancel a Run, settle a Turn, or block terminal reconciliation.
