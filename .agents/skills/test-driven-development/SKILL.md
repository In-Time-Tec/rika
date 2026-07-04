---
name: test-driven-development
description: RED-GREEN-REFACTOR for Rika features and bugfixes with Bun tests, Effect programs, and service/layer seams before production code. Triggers: TDD, red-green-refactor, failing test first, test before code, reproduce before fix.
---

# Test-Driven Development

Defer to the nearest `AGENTS.md` and `CONTEXT.md`; project-local rules override this skill.

If you did not watch RED fail, you do not know if the test proves the behavior.

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Code before RED? Delete it. Start over. Throw away reference copies.

Effect service shape: [add-effect-service](../add-effect-service/SKILL.md). Mocks and stubs: [testing-anti-patterns.md](testing-anti-patterns.md). Tempted to skip: [rationalizations.md](rationalizations.md).

## RED - write one failing test

One `test`, one behavior, clear name. Assert through the public package API, service method, or command surface.

Run Effect programs with `Effect.runPromise` or `Effect.runPromiseExit`. Compose dependencies with `Effect.provide`, `Layer.provide`, `Layer.provideMerge`, and fake, memory, deterministic, or test layers through the service tag. Prefer `memoryLayer` for stateful stores and projections; prefer `fakeLayer` for external or provider seams. Assert typed failures with `Effect.flip`, `Exit`, or `_tag`. Use deterministic time layers before real sleep.

```bash
bun test packages/<package>/test/<file>.test.ts
```

**Done when:** test fails (not errors); failure is missing behavior, not a typo; you can state why it failed.

Test passes immediately? You're testing existing behavior; fix the test. Test errors? Fix until it fails correctly.

## GREEN - minimal code

Simplest layer/service code to pass. No extra features, no drive-by refactors.

**Done when:** scoped test passes; no new warnings in output.

Test still fails? Fix code, not the test.

## Verify GREEN - full scope

```bash
bun test packages/<package>/test/<file>.test.ts
bun run test
```

**Done when:** scoped and related tests pass; output pristine.

## REFACTOR - after green only

Remove duplication, improve names, extract test layer helpers. No new behavior.

**Done when:** tests still pass.

## Repeat

Next behavior -> next RED.

## Exceptions

Throwaway prototypes, generated code, config-only changes: ask your human partner. "Just this once" is rationalization.

## Bugfixes

RED reproduces the bug. Same cycle. Never fix without a failing test.

## Done when

- [ ] Every new behavior has a Bun test that failed first for the right reason
- [ ] GREEN was minimal; REFACTOR stayed green
- [ ] Layers not mocks; deterministic time not sleep; services expose fake, memory, deterministic, or test layers where tests need replacement
- [ ] `bun run test` passes

Otherwise: not TDD. Start over.
