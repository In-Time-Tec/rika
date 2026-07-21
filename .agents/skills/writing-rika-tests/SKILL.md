---
name: writing-rika-tests
description: "Use this skill when the user wants to add, repair, or reorganize Rika automated tests. Also use for regression coverage, test-first bug fixes, and interactive TUI checks. Do not use only to list possible cases before implementation; use test-case-design instead. Use testing-with-pilotty or testing-with-agent-tty for manual TUI comparison and visual evidence."
---

# Writing Rika tests

Turn one promised behavior or known failure into the smallest in-process test that proves it.

## Choose the test scope

Start at the interface people or callers use. Choose the lowest scope that can fail for the real reason:

| Scope   | Use when                                                                                       | File                                                       |
| ------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Unit    | One owner, rule, adapter, schema, state transition, or failure contract can prove the behavior | `*.test.ts` beside the matching path under `test/`         |
| TUI app | A user-visible interactive behavior depends on the TUI and product stack working together      | `*.tui.test.ts` on the `apps/rika/test/tui-app.ts` harness |
| Process | Process lifecycle or transport is the behavior: spawned residents, PTYs, kill fixtures         | `*.proc.test.ts` beside the matching path under `test/`    |

Real SQLite, filesystem, Relay, or OpenTUI adapters do not change a test's scope. Test scope follows the behavior being proved, not the runtime dependency. Unit tests never spawn child processes, never run packaged binaries, and never assert wall-clock durations — waits poll observable conditions with generous ceilings. TUI app and Process suites run through `bun run test-tui` and `bun run test-proc` in CI, not in `bun run check`.

Packaged-product verification is `bun run release-smoke` after `bun run package`; it runs in the release workflow, not in `bun run test`.

## Write the proof

1. State the public promise and the failure that would break it.
2. Read the owner, its supported interface, and nearby tests. Stop when the test seam and expected result are clear.
3. Write one failing check that reproduces the missing behavior. Prefer observable state, output, persisted data, or typed failure over private calls and mocks.
4. Run only that test and confirm it fails for the intended reason. A compile error, timeout, or unrelated setup failure is not a useful red state.
5. Implement the smallest correct behavior change when implementation is part of the request.
6. Run the focused test until green, then run the surrounding project. Use `bun run test` when the change can affect more than one area.

For an existing bug, keep the regression test after the fix. For a refactor, preserve behavior first and do not weaken assertions merely to make the new structure pass.

## Unit rules

- Use `@effect/vitest` for Effect behavior.
- Use `TestClock` for time, retries, debounce, and scheduling when the promise does not depend on wall-clock timing.
- Prefer real in-memory or temporary adapters when their semantics are part of the rule.
- Assert typed failures and recovery paths, not only success.
- Keep source and test paths aligned with the existing package layout.

## TUI app rules

- Build each test on `TuiApp.tuiApp({ script, ... })`: the real Surface on the OpenTUI test renderer, the real interactive loop from `apps/rika/src/main.ts`, and the real Operation, Relay, SQLite, and tool stack in one process.
- Script only the language model through `TuiApp.model`; provider models and network calls are forbidden.
- Drive input through `app.type`, `app.pressEnter`, `app.pressKey`, and friends; wait for visible evidence with `app.waitFrame(marker)` instead of sleeping blindly.
- Wait for a unique completion marker or tool result. Composer echo is not proof that a turn completed.
- Each test owns a fresh `tuiApp` instance with its own temp workspace and databases; end by `app.close()` then `yield* app.done`.
- Assert the visible frame and the important durable fact when both matter (read the temp workspace or database directly).

## Check discovery

Before finishing, make sure Vitest owns the file exactly once:

```sh
bun --bun vitest list --project unit
```

Run the narrowest matching test file while working. Then report what passed, what failed, what was not run, and what remains uncertain.

## Done when

- the test fails without the promised behavior and passes with it;
- it runs in one process with no provider request or uncontrolled external state;
- cleanup and important failure paths are covered; and
- Vitest discovers the file once in the unit project.
