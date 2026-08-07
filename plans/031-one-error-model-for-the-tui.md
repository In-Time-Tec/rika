# Plan 031: One error model for the whole TUI

## Goal

After this work:

- every user-visible failure states what happened, why, and what to do next, in that order;
- retry is offered only where retrying can succeed, and retried automatically where the user has no decision to make;
- a defect that must end the session prints one actionable line, not a stack trace over a torn screen;
- error presentation is one owned surface rather than four independent ones; and
- adding a new failure without classifying it is a type error, not a silent fallback.

This plan owns the model. Plan 030 fixes the specific defect that exposed it and can land first.

## Current state

### Four titles carry every failure

Every error a user can see in the transcript comes from one of four strings:

```
Cancellation not completed
Message failed
New thread
Steering not delivered
```

Behind `Message failed` sit provider credential errors, transport failures, admission conflicts, model overload, and cancellation races. The title is the shape of the _operation_, not the failure. A user cannot tell a missing API key from a dropped connection.

### One sentence absorbs everything unclassified

`packages/product/src/operation/operation-error.ts:45` returns

```
Rika could not complete that action. Run rika diagnostics status if it keeps happening.
```

for any error that is not one of four recognized types. This is the default path, not the exception. It also prescribes a command that validates nothing.

### Recovery text is a constant

`terminal-overlay-reducer.ts:190` and `:236` attach `"Press Enter to try again."` to every failure. For a missing credential, retrying is guaranteed to fail again. The product tells the user to do the one thing that cannot work.

### Retry exists in one place

Ten `Schedule`/`retry` occurrences across all of `src`, one of them on the execution path: `packages/baton-execution/src/baton-execution.ts:129`. There is no shared policy, no classification of what is retryable, and no user-visible retry state. A transient provider blip and a permanently bad configuration are handled identically: not at all.

### Presentation is spread across four surfaces

Error text is produced in `terminal-overlay-reducer.ts`, rendered in `opentui-render-unit.ts`, sometimes surfaced as a toast through `opentui-toast-controller.ts` and `terminal-toast-layout.ts`, and separately reached through `transcript-agent-response.ts`. Each decides independently what to show and how much. A detail that renders in one is invisible in another.

### Defects end the process without a message

Eleven `Effect.die` / `orDie` sites exist in `apps/rika/src` and `packages/terminal/src`. They print a raw Effect defect over a TUI that has already taken the alternate screen buffer. The user gets a wall of internal text with no statement of what to do.

## Model

### Every failure is one of four kinds

Classification decides presentation and retry. It is assigned where the failure is created, never inferred from message text.

| Kind            | Meaning                                                                         | Retry                                 | Presentation                                                |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `Misconfigured` | The environment or settings are wrong. Identical input fails identically.       | Never                                 | Name the setting and the file. Offer the exact fix.         |
| `Transient`     | A dependency was briefly unavailable.                                           | Automatic, bounded                    | Show the attempt inline. Surface only if it exhausts.       |
| `Rejected`      | The request was understood and refused. Budget, policy, conflict, cancellation. | Only after the user changes something | State the constraint and the decision that would change it. |
| `Defect`        | Rika is broken. An invariant did not hold.                                      | Never                                 | One line, a correlation id, and where the log is.           |

The union is closed. A new failure type that is not classified fails to compile, so the fallback in `operation-error.ts:45` becomes unreachable rather than default.

### Retry belongs to the kind, not the call site

`Transient` retries on one shared policy with jitter and a bounded ceiling, and reports attempts on the row that will settle. The user watches one thing progress rather than seeing a failure they must act on.

`Misconfigured` and `Rejected` never auto-retry. Offering "Press Enter to try again" for a missing credential is a defect in itself.

Manual retry is offered only when the kind can succeed on retry. When the user must change something first, the recovery text says what.

### Presentation is one owned surface

One module turns a classified failure into what the user sees, and every surface renders that. Three severities:

- **inline** — attaches to the row that failed; the default
- **banner** — persists until resolved; session-scoped conditions like a missing credential
- **exit** — Rika cannot continue

Toasts are for transient confirmations, never for errors that need a decision. An error that matters must survive long enough to read.

### The first line is the message

Cause on line one, always. Expansion carries the long tail — stack, run id, correlation id, provider response — and never carries the only sentence that matters. An expansion affordance that does not open is deleted.

### Dying is a designed exit

`Effect.die` at a process boundary must restore the terminal, print one line naming what failed and what to do, and give the correlation id. It must never paint a defect over the alternate screen.

Audit all eleven sites. Most are invariant assertions that should be typed failures. The genuine ones — a diagnostics path that is a symlink, an unavailable data root — are `Misconfigured` and should say so.

## Work

1. **Define the closed failure union** in `@rika/product` with the four kinds and required fields per kind: `Misconfigured` names setting, file, and fix; `Transient` names the dependency and attempts; `Rejected` names the constraint; `Defect` carries a correlation id.
2. **Classify at the boundary.** Every place that builds a product-visible failure assigns a kind. Delete the substring test at `operation-error.ts:42` and the unconditional fallback at `:45`.
3. **Move retry onto the kind.** One shared `Transient` policy. Remove ad-hoc retry from call sites, or classify what it guards.
4. **Build the presentation module** and route the transcript, toast, and banner surfaces through it. Delete per-surface formatting.
5. **Replace the four titles.** A title states the failure, not the operation. `Message failed` becomes the specific cause; the operation is already visible from the row it attaches to.
6. **Convert the die sites.** Restore the terminal, print one line, exit with a correlation id.
7. **Log every user-visible failure** with kind and correlation id, so the id on screen finds the entry on disk.

## Acceptance

- every user-visible failure carries a kind
- a missing credential shows the variable, the file, and the fix, and offers no retry
- a transient dependency failure retries automatically and surfaces only on exhaustion
- a rejected request states the constraint and what would change it
- a defect prints one line plus a correlation id on a restored terminal
- the correlation id on screen locates the diagnostics entry
- no user-visible failure renders "Rika could not complete that action"
- adding an unclassified failure fails typecheck
- error text is produced in exactly one module

## Verification

```bash
bun run check
bun run test
bun run test-tui
```

`*.tui.test.ts` coverage per kind: a `Misconfigured` failure offers no retry; a `Transient` failure shows progress and recovers without user action; a `Defect` restores the terminal. Manual acceptance with the pilotty skill, including a forced defect, to confirm the screen is restored before anything is printed.

## Stop conditions

Stop if classification cannot be assigned at creation and would have to be inferred from message text. That is the current defect, and inferring it again reproduces it.

Stop if a credential value would reach a log, transcript, or process listing. Names only.

Do not keep a generic fallback "for safety". Its presence is why a missing environment variable read as a mystery for weeks.
