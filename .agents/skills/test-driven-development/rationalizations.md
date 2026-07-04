# TDD Rationalizations

Load when tempted to skip RED, write tests after, or keep code written before the test.

| Excuse                     | Reality                             |
| -------------------------- | ----------------------------------- |
| Too simple to test         | Simple code breaks                  |
| I'll test after            | Passing immediately proves nothing  |
| Already manually tested    | Ad-hoc, no re-run record            |
| Deleting work is wasteful  | Unverified code is debt             |
| Keep as reference          | You'll adapt it; that's tests-after |
| Need to explore first      | Throw away exploration, start RED   |
| Test hard = design unclear | Hard to test = hard to use          |
| TDD will slow me down      | Debugging after is slower           |
| I'll mock the dependency   | Use the service layer seam first    |

**Red flags - delete implementation, start RED:** code before test; test passes immediately; cannot explain the failure; `vi.mock` on package imports; real sleeps; raw promises instead of `Effect.runPromise` or `Effect.runPromiseExit`.

Tests-after ask "what does this do?" RED asks "what should this do?"
