# Known issues

## Session single-writer fencing awaits the Baton/Relay releases

The upstream fixes are implemented on local branches and validated end to end with
locally built packages wired into this repo's node_modules: batonfx
`feat/session-fencing-and-sync-diagnostics` (owner-token threading, SessionConflict
"fenced", bounded SessionSync.Diagnostics on the prefix invariant, bare provider
registration exports) and relayfx `feat/session-single-writer-and-cancellation-quiescence`
(cancellation interrupts and joins the execution tree before journaling the terminal
event, durable per-session owner and fencing epoch claimed at accept and released at
terminal, fenced session appends and checkpoints, migration 14). Rika's admission
gate and title-session isolation remain as defense in depth.

Remaining until the releases ship: publish batonfx 0.9.0, then relayfx sdk 0.6.0
(its packaged-consumer gate needs baton 0.9.0 on npm), then bump this repo's
catalogs and run a real bun install. Residual known gap: a start the session
owner rejects after the turn is already marked running is retried by copying the
prompt into a fresh queued turn, leaving the original as a cancelled husk row;
preserving the same turn id needs either a running-to-queued repository
transition or a two-phase admission/start contract in the backend, tracked as
follow-up.

## A starved follow can drop wait.woken and stall the live active timer

Under heavy CPU contention the root execution follow can resume after a tool
approval without ever delivering the `wait.woken` event, so the live projection
never reopens the active interval and the status line keeps showing only the
work measured before the approval. Relay's durable event log is complete, so the
value is correct again as soon as the thread is reopened, and reopening is what
`apps/rika/test/app.tui.test.ts` asserts. Fixing this needs the actionable-wait
stop and resume path in `packages/runtime/src/execution-backend.ts` to prove it
cannot skip an event between the stop cursor and the resume cursor.
