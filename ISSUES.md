# Known issues

## Cancellation quiescence still needs upstream Relay/Baton fencing

Rika now gates every successor-admission path (submit, queue promotion, thread-host wake,
reconcile restart and promotion, non-interactive run) on an observable quiescence check of
cancelled or failed predecessors: the predecessor's execution tree must be terminal with no
pending tool calls before a replacement may start on the shared `session:<thread-id>` Relay
Session, and the gate cancels any live descendants it finds. This is downstream containment for
"Session projection is not a prefix of authoritative Chat history", not the full fix. Remaining
upstream work in Relay/Baton (@relayfx/sdk 0.4.2 and @batonfx/core 0.7.1 expose no such APIs):

- a linearizable cancellation fence that seals child/tool/wait/compaction admission, joins live
  work, and rejects stale Session writes before publishing terminal finality;
- durable single-writer Session admission (owning execution id, fencing epoch, recovery across
  resident restart, idempotent duplicate starts, two-phase admission/start for queued turns);
- bounded structural mismatch diagnostics in Baton's Session synchronization instead of the bare
  prefix error.

A Baton loop can still append or compact between two gate polls, so the race is narrowed, not
closed. One historical projection failure did not follow a cancellation and should be
re-investigated with the improved upstream diagnostics once they exist. An in-process TUI test
showing the replacement staying pending until quiescence is also still owed; the behavior is
covered at the operation layer today.

The `research-synthesis pins its definition and survives SIGKILL without duplicate effects`
scenario in `packages/runtime/test/workflow.test.ts` is skipped. On slower machines (reproduced
consistently on 4-vCPU CI runners, never on a fast local machine), killing the host mid-fan-out
and recovering leaves the run in `running` forever: the oracle member is dispatched a second time
after recovery, and the run never reaches `completed` even after every dispatched child is
released. Budgets up to 180 seconds do not help, so this looks like a genuine recovery defect in
the workflow fan-out replay path (or in @relayfx/sdk 0.4.2's workflow recovery), exposed when the
SIGKILL lands in a specific persistence window. Re-enable the scenario once recovery is fixed.
