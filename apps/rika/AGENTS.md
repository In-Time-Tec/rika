# Rika CLI

Thin Effect CLI shell and process composition root. Leaf command modules export command values. `src/command.ts` exports the root command and testable `run(argv)`. `src/main.ts` alone interprets the process program.

Do not initialize SQL, Relay, models, MCP, plugins, or OpenTUI before command parsing selects an operation that needs them.

Use `*.test.ts` for Unit tests of one owned behavior or interface, even when they need real OpenTUI adapters.

For user-visible interactive behavior, add or update an in-process `*.tui.test.ts` on `test/tui-app.ts`: the real Surface on the OpenTUI test renderer, the real interactive loop, and the real product stack with a scripted model. The TUI app suite runs through `bun run test-tui` in CI, not in `bun run check`; prefer extending an existing app instance over adding one. Provider models and network calls are forbidden. Tests that spawn residents, PTYs, or kill fixtures use `*.proc.test.ts` and run through `bun run test-proc` in CI. Use reducer or renderer tests as narrower support, not as a substitute for a TUI app test.
