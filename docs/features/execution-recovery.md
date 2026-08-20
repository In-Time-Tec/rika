# Execution recovery

After a replica stops, TenetKit's PostgreSQL worker leases allow another API replica to resume a nonterminal Run under a newer attempt fence. Rika projectors backfill durable event pages from their stored Hosted Owner cursor and apply each event idempotently. Replica or client replacement abandons process-local delivery only; it does not cancel the Run or change its Thread.

Workspace operations are dispatched with a stable operation key to the current fenced Executor. An Executor returns a durable prior receipt for a repeated completed operation. Work known not to have started may be reassigned; an operation lost after starting without a durable receipt enters TenetKit's unknown-outcome resolution when side effects are possible and is never blindly replayed. Stale assignment generations, lease epochs, TenetKit attempt fences, checkpoint proposals, and terminal frames cannot replace current state.

An E2B child-process failure restarts inside the same sandbox. A lost sandbox increments the assignment generation before replacement, restores the exact repository identity plus the newest verified Workspace artifact, and then accepts new operations. A missing or corrupt artifact falls back to an older verified checkpoint or a clean exact checkout and reports possible work loss; partial restore is never declared current.
