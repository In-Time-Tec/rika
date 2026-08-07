# Plan 034: One error chokepoint — classify once, retry on policy, never show instructions

> **Status**: PROPOSED (research-backed; not yet dispatched)
> **Priority**: P1 · **Effort**: L · **Risk**: MED · **Category**: direction + UX
> **Depends on**: none (supersedes the presentation half of 031)
> **Research**: OpenCode (`sst/opencode`) `provider/error.ts`, `session/retry.ts`,
> `session/processor.ts`, `session/status.ts`, `packages/tui` prompt status line.
>
> **Executor note**: this plan is written for review first. It removes the
> recovery/instruction root from user-visible errors, replaces the fragmented
> retry classification with one chokepoint, and adds a real retry state machine.
> Breaking changes are welcome in this repo; do not preserve old fields.

## Why this matters

A rate-limited turn today renders two instruction-bearing error blocks, and
beneath them sit **four independent classification/retry mechanisms** that never
agree. The user asked for: no "next" instructions anywhere in errors, a single
categorization of retryable vs not, and one state machine that decides and
shows retry — modeled on OpenCode, which does this well.

## Evidence — current behavior (traced)

### User-visible errors still carry instructions

- Error blocks render `Next: <recovery>` (`packages/terminal/src/opentui/rendering/opentui-render-block.ts`, Error case) fed by `recovery` strings from `packages/baton-execution/src/failure-presentation.ts`, `packages/product/src/execution/lifecycle/execution-authority-reconciliation.ts` (`missingExecutionRecovery`), and `packages/terminal/src/state/reducer/terminal-overlay-reducer.ts` (`errorRecovery` maps `retry` → "Press Enter to try again." / "Fix the issue above, then resend.").
- Tool failures embed prose instructions into their messages: `coding-tool-runtime.ts` builds `"... Next action: <nextAction>."` from ~15 `nextAction` strings.
- Baton's internal retries surface as Notification blocks: "Retrying model request …", "Trying another model …" (`baton-tree-projector.ts` `ModelRetryScheduled` / `ModelFallbackScheduled`).

### Four areas classify retry, inconsistently

1. `packages/baton-execution/src/failure-presentation.ts` — model categories + `transient | terminal` classification from Baton, collapsed into prose (title/detail/recovery).
2. `packages/product/src/operation/operation-failure.ts` — `Failure { tag, message, retry: "user"|"automatic"|"never", actor }` + `makeFailure` substring classification. **"automatic" is never produced** (dead branch); `retry` is consumed only by the prose generator.
3. `packages/terminal/src/state/reducer/terminal-overlay-reducer.ts` — `errorTitle`/`errorRecovery` turn the enum into copy.
4. Hardcoded `retry: "user"` at five sites: `terminal-interactive-feed.ts:93`, `process-runtime.ts:215`, `server-message-codec.ts:45`, `server-client-reconnect.ts:118/147/160`.

Nothing retries. There is no retry state, no attempt counter, no backoff policy the user can see; the enum only decides which instruction sentence to print.

## OpenCode research — what we copy

`provider/error.ts` + `session/retry.ts` + `session/processor.ts` + `session/status.ts`:

1. **Normalize at the boundary.** `parseAPICallError` / `parseStreamError` convert every provider error into one structured shape: `{ type: "context_overflow" | "api_error", message, statusCode, isRetryable, responseHeaders }`. Classification is never inferred from prose.
2. **One pure decision function.** `SessionRetry.retryable(error, provider) → Retryable | undefined`. Context overflow → never retried (triggers compaction instead). API errors → `isRetryable` OR status ≥ 500 OR message/body patterns (`429|500|502|503|504|524`, rate-limit phrases, overloaded, network errors, timeouts, "resource exhausted"). Quota/upsell → structured `action { reason, provider, title, message, label, link }`, never prose.
3. **Retry as a declarative policy.** `SessionRetry.policy` is an Effect `Schedule` that per attempt: decides via `retryable()`, honors `Retry-After` headers, applies exponential backoff with caps (2s base, ×2, 30s cap without headers), and publishes status `{ type: "retry", attempt, message, action, next }`. When not retryable → `Cause.done(attempt)` → retries stop and the error surfaces.
4. **One status surface.** `SessionStatus` store + `session.status` events; the TUI prompt bar renders a spinner + `{message} [retrying in Xs attempt #N]` with a live countdown from `next`. No instruction prose anywhere; when retries exhaust, the error is attached to the assistant message and the user simply sends again.

## Target model

### One closed classification, assigned where the failure is created

Rework `Failure` (wire + terminal message) to:

```
Failure = {
  tag: string
  category: FailureCategory          // closed union, see below
  message: string                    // what happened, no instruction suffix
  retryable: boolean                 // would an identical attempt ever succeed?
  retry: "automatic" | "none"        // does Rika retry it? (automatic only when retryable)
  actor: "user" | "environment" | "rika"   // kept for diagnostics logging
  correlationId?: string
}
```

`FailureCategory` is a closed schema union: the twelve Baton model categories + `tool` + `operation` + `transport` + `execution-unavailable` + `defect`. A new failure that is not classified fails to compile — no substring fallbacks.

### One classifier in `@rika/product`

New module `packages/product/src/operation/failure-policy.ts`:

- `classifyModelFailure({ category, classification })` — uses Baton's structured event (never the message):
  - transient (rate-limit, transport, provider-response, timeout, overloaded/5xx) → `retryable: true, retry: "automatic"`
  - terminal → `retryable: false, retry: "none"`; authentication → `retryable: false` + `action` (open settings/doctor); context-overflow → `retryable: false` (never retried, per OpenCode)
- `classifyOperationError(error)` — absorbs `makeFailure`, deleting the substring checks and the dead `"automatic"` branch.
- `classifyToolFailure(details)` — maps coding-tools `category`/`outcome`/`recovery` to the union (`rate_limited`, `dependency_unavailable`+later → automatic; `invalid_input`, `access_denied`, unsafe timeouts → none).
- `classifyTransportFailure(reason)` — degraded wire failures → automatic (the reconnect loop is the mechanism; its failures flow through the policy).

### One retry state machine (OpenCode `policy` equivalent)

`TurnRetryPolicy` in `@rika/product`: when a turn settles failed with `retry: "automatic"`, re-run the turn with the same prompt — bounded attempts (e.g. 3), `Retry-After`-aware exponential backoff with jitter and a cap — publishing interactive activity events `TurnRetryScheduled { attempt, budget, message, next }` and, on exhaustion, the final `ExecutionFailed`. This is a second layer above Baton's attempt-level retries: it only sees `ModelCallFailed` events, i.e. failures that outlived Baton's own retries (persistent rate limits, long provider outages).

### One status surface, one renderer

- The TUI model gains retry status (mirroring OpenCode's footer): the activity/status area shows `Provider is overloaded — retrying in 4s (attempt 2 of 3)` with a countdown; error blocks show message + detail only.
- `ModelRetryScheduled` / `ModelFallbackScheduled` Notification blocks are removed: retry visibility now lives in the single status surface.
- Error block schema drops `recovery` and gains `category` + `retryable`; `terminal-interactive-feed.ts`, `process-runtime.ts`, and `server-message-codec.ts` derive the `Failure` from the last Error unit's structured fields instead of hardcoding `retry: "user"`.

### No instructions anywhere

- `Next:` line deleted from the error renderer; `recovery` deleted from the Error block schema, all producers, and all tests.
- `failure-presentation.ts` becomes `{ message, category, retryable }` — copy drops instruction suffixes ("Wait a moment, then try again." → "The provider limited how often requests are accepted."). **Decision point:** the earlier approved copy included "then try again"; the state machine's status line replaces that guidance.
- `coding-tools` messages drop `" Next action: …"` prose; the structured `category`/`outcome`/`recovery` fields remain for the model and the classifier.

## Work

**Phase 1 — chokepoint + no-instruction rendering (no behavior change):**

1. `failure-policy.ts`: closed `FailureCategory`, reworked `Failure`, `classifyModelFailure` / `classifyOperationError` / `classifyToolFailure` / `classifyTransportFailure`; delete `operation-failure.ts` substring logic and dead `"automatic"`.
2. Transcript schema + terminal model: Error block loses `recovery`, gains `category` + `retryable` (schema, fixtures, projection).
3. Producers: `baton-diagnostic-projection.ts` (set structured fields, drop recovery param), `execution-authority-reconciliation.ts` (drop recovery), overlay reducer `errorBlock` (drop recovery; delete `errorTitle`/`errorRecovery` prose).
4. Renderers: delete the `Next:` line from `opentui-render-block.ts`; errors render `title` + `detail` only.
5. Feed/process/codec: derive `Failure` from structured Error-unit fields; delete the five hardcoded `retry: "user"` sites.
6. `failure-presentation.ts` copy cleanup; `coding-tools` prose removal (guarded by scripted-model tests that the agent loop still corrects after tool failures).
7. Update all unit, characterization, and integration test expectations; add policy classification-table tests.

**Phase 2 — retry state machine (behavior):**

8. `TurnRetryPolicy` service + `TurnRetryScheduled`/`TurnRetryExhausted` activity events; wire into interactive and CLI turn dispatch.
9. TUI retry status line with countdown; remove retry/fallback Notification blocks from the projector.
10. Transport failure classification through the policy; CLI `Turn <id> failed:` line uses the classified message.

**Phase 3 — structured actions (optional):** `action` buttons for fixable failures (auth → settings/doctor, quota → link), matching OpenCode's `Retryable.action`.

## Acceptance

- `rg "Next:"` / `rg "Press Enter to try again"` / `rg "Next action"` in user-facing paths returns nothing; `recovery` is gone from the Error block schema and producers.
- Every user-visible failure carries `category` + `retryable`; adding an unclassified failure fails typecheck.
- Retry decisions come from exactly one function (`failure-policy.ts`).
- A transient provider failure retries automatically with a visible countdown and recovers without user action; a terminal failure shows once, with no instructions.
- The five hardcoded `retry: "user"` sites are gone.
- `bun run check`, `bun run test-unit`, `bun run test-tui` pass; scripted-model tests confirm the agent loop still recovers from tool failures after prose removal.

## Stop conditions

- Stop if classification must be inferred from message prose — Baton already emits structured `category` + `classification`; use it.
- Stop if removing tool-error `nextAction` prose measurably degrades the agent loop in scripted-model tests — restore structured-only guidance instead of prose.
- Do not keep `recovery` or any "for safety" fallback string: its presence is why instructions re-appear.

## Verification

```bash
bun run check
bun run test-unit
bun run test-tui
```

`*.tui.test.ts` coverage per kind: transient provider failure shows retry progress and settles without user action; terminal failure renders once with no instruction; a missing credential offers no retry. Manual acceptance with the pilotty skill: force a rate limit, confirm one message and a countdown, then exhaustion with no "Next:" anywhere.
