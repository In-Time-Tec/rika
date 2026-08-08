# Plan 030: A failed message says what failed

## Goal

After this work:

- a failed send names its cause on the first line, without expansion;
- a missing provider credential names the variable, the provider, and the settings file that asked for it;
- a stale client process cannot hand a new invocation an environment the user never had;
- every failure that reaches the transcript is also in the diagnostics log; and
- `rika diagnostics status` reports configuration health, not only a log path.

This plan fixes one reproduced defect and the three surfaces that hid it. Plan 031 owns the wider error, retry, and recovery model.

## Reproduction

`pilotty` against the installed 0.3.5 build, `~/projects/Rika`:

```
 ┃ say hello

 ✖ ERROR: Message failed ▸
   Next: Press Enter to try again.
```

The `▸` disclosure does not open on `Up`, `Right`, or `Enter`. The transcript never names a cause.

The same send through the non-interactive path names it immediately:

```
$ rika -x "say hello"
ConfigError(SchemaError(Invalid data <redacted>
  at ["SWITCHBOARD_API_KEY"]))
```

## Root cause

`SWITCHBOARD_API_KEY` is exported in `~/.zshenv` and is present in the user's login shell. It never reaches the server process.

Verified by process inspection. A freshly spawned server, launched from a shell that exported both `SWITCHBOARD_API_KEY` and a canary variable, carried neither, while unrelated credentials from an older shell (`EXA_API_KEY`, `BASETEN_API_KEY`) were present:

```
server 94714 <- ppid 91775
/Users/dallen.pyrah/.local/share/rika/current/bin/.rika-interactive   started 11 minutes earlier
```

The parent was a long-lived `.rika-interactive` client from an earlier session. A new `rika` invocation hands off to that resident client, and the resident client spawns the server from its own frozen `process.env` through `serverProcessEnvironment(process.env, ...)` in `apps/rika/src/server/process/server-process-spawn.ts:22`. Every later server inherits the environment of whichever shell first started the client, not the shell the user actually typed in.

Killing the resident client resolves it with no other change:

```
$ pkill -9 -f '\.rika-interactive'; pkill -9 -f '\.rika-server'
$ rika -x "reply with exactly OK"
OK
```

This is the same mechanism behind the message the user already sees regularly:

```
Rika server replacement is delayed because server PID 63648 owns active execution work.
```

Both are one defect: process reuse across shells with divergent environments, with no reconciliation and no diagnosis.

## Why it was invisible

Three independent surfaces each dropped the cause.

**The product replaces every unrecognized error with one sentence.** `packages/product/src/operation/operation-error.ts:45`:

```ts
return "Rika could not complete that action. Run rika diagnostics status if it keeps happening."
```

`operationFailureDetail` returns a real message only for `OperationError`, `QueuedTurnUnavailable`, `StaleQueuedTurns`, or a gateway failure whose text happens to contain `"cursor did not advance"` (`:36-44`). A `StartTurnFailure` carrying `ConfigError(... ["SWITCHBOARD_API_KEY"])` matches none of those, so the transcript received the fallback. The advice it gives is also wrong: `rika diagnostics status` prints a directory and a file count and validates nothing.

**The TUI hides the detail behind an unreachable disclosure.** `packages/terminal/src/opentui/rendering/opentui-render-unit.ts:411` renders `block.detail` only when `expanded`. The reducer does populate it (`terminal-overlay-reducer.ts:190`, `:236`), and the row reports itself expandable (`transcript-row.ts:210`), but no key opened it in the reproduction. A one-line failure is therefore all a user ever sees.

**Nothing was logged.** The server diagnostics file for the failing run contains three INFO lines — `process.started`, `server.listener.ready`, `server.product.loaded` — and no record of the failure. A failure the user can see must not be absent from the log the error message tells them to read.

## Work

### 1. Reconcile the environment on client handoff

A resident client must not serve an invocation whose environment differs in provider credentials.

On handoff, compare the requesting invocation's credential-relevant variables (every `apiKeyEnv` named by effective settings, plus every web-search credential variable) against the resident client's. On divergence, replace the resident client rather than reuse it, exactly as a version mismatch already does.

If replacement is blocked by active execution work, say which variable diverged and which is in effect. The current message names neither.

### 2. Preserve the cause in `operationFailureDetail`

`operation-error.ts:45` becomes the last resort for a genuinely unknown defect, not the default. A typed failure that carries a message keeps it. The `"cursor did not advance"` substring test at `:42` is deleted — a message-text match is not a classification.

Provider credential failures get a named shape rather than a decoded `ConfigError`. `packages/execution/src/baton-route.ts:108` already knows the variable name and provider when it builds `Config.redacted(...)`; a missing variable should fail as a typed Rika error naming the variable, the provider, and the settings path that requested it.

`packages/execution/test/baton-route.test.ts` already asserts the readable form for a missing key. That test passes today, so this is a plumbing gap between Baton and the transcript, not a Baton defect.

### 3. Put the cause on the first line

An error block renders its cause without expansion. Expansion carries the long tail — stack, run id, checkpoint — not the only sentence that matters.

Fix or delete the disclosure. A `▸` affordance that no key opens is worse than no affordance.

Recovery text must be specific. "Press Enter to try again" is wrong for a missing credential, which will fail identically forever. Retry is offered only when retry can succeed; see plan 031.

### 4. Log every failure that reaches the transcript

Any error rendered in the transcript is written to the diagnostics log with its cause and correlation id. The reproduced failure appeared on screen and nowhere on disk.

### 5. Make `rika diagnostics status` earn its mention

The generic message tells users to run it, so it must answer the question. It reports: resident client and server pids with start times, whether their environments diverge from the current shell, which credential variables the effective settings require, and which are missing — by name, never by value.

## Acceptance

- a send that fails on a missing credential names the variable on the first transcript line
- that message names the provider and the settings file that requested the variable
- no failure renders as "Rika could not complete that action" unless it is genuinely unclassified
- starting `rika` from a shell whose credentials differ from a resident client replaces the client or explains precisely why it cannot
- the blocked-replacement message names the divergent variable
- every transcript error has a matching diagnostics entry
- `rika diagnostics status` reports missing credential variables by name
- the reproduction above returns a model reply with no manual process cleanup

## Verification

```bash
bun run check
bun run test
bun run test-tui
```

Manual, with the pilotty skill: unset a required credential in the launching shell, send a message, and confirm the first line names the variable. Repeat with a resident client started from a shell that has it.

## Stop conditions

Stop and report if fixing this requires a credential value to reach a log, a transcript, or a process listing. Names only.

Stop if the disclosure cannot be made to open. Then the detail belongs on the first line unconditionally, and the disclosure is deleted rather than left inert.
