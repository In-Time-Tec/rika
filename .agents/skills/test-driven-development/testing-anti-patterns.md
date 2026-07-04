# Testing Anti-Patterns

Load when adding testLayer overrides, mocks, or test utilities.

**Core principle:** test service behavior, not stub wiring. Strict **RED** prevents most of these.

## Iron laws

1. Never test stub behavior (call counts, spy state)
2. Never add test-only methods to production `Interface`
3. Never swap layers without understanding preserved semantics

## 1. Stub behavior

Assert outcomes through service behavior: stored state, events, typed provider responses, and typed errors; not `getWaitCalls === 1`.

**Gate:** "Am I testing the stub or the service?"

## 2. Test-only production API

Compose fresh memory layers in test helpers. Production services stay behavior-only.

**Gate:** "Is this method only used from tests?"

## 3. Blind testLayer override

Stubbing the service under test when the test depends on store writes, diagnostics, or emitted events proves the stub instead of the behavior. Use the dependency layer that preserves the behavior under test: memory for stateful stores, fake for external/provider seams, deterministic layers for time and IDs.

**Gate:** "Does this test depend on side effects I'm stubbing away?"

## 4. Incomplete memoryLayer

Partial memory layers that omit retry, duplicate, or failure paths break downstream code silently. For stateful stores, start from the package `memoryLayer`; override one method if needed.

## Rika-specific

| Anti-pattern              | Fix                                  |
| ------------------------- | ------------------------------------ |
| `vi.mock` package import  | provide `fakeLayer` or `memoryLayer` |
| raw promise-only test     | `Effect.runPromise`                  |
| real sleep                | deterministic time layer             |
| global mutable test state | fresh layer per test                 |
| product fixtures in core  | adapter tests                        |

## Red flags

Spy call counts; methods only in test files on `Interface`; testLayer >50% of test; cannot explain why stub exists; `vi.mock` on package imports.

Full TDD context: [rationalizations.md](rationalizations.md).
