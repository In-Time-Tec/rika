# Rika CLI

Thin Effect CLI shell and process composition root. Leaf command modules export command values. `src/command/root/rika.ts` exports the root command and testable `run(argv)`. `src/command/root/noninteractive.ts` owns JSONL parsing. `src/client-main.ts` interprets the client process; diagnostics load the performance evaluation only after command parsing selects it.

Do not initialize SQL, Generalist, models, MCP, plugins, or OpenTUI before command parsing selects an operation that needs them.

Use `*.test.ts` for Unit tests of one owned behavior or interface, even when they need real OpenTUI adapters.

For user-visible interactive behavior, add or update a mirrored in-process `*.tui.test.ts` using `test/support/tui-app.harness.ts`: the real Surface on the OpenTUI test renderer, the real interactive loop, and the real product stack with a scripted model. The TUI app suite runs through `bun run test-tui` in CI, not in `bun run check`; prefer extending an existing app instance over adding one. Provider models and network calls are forbidden. Tests that spawn servers, PTYs, or kill fixtures use `*.proc.test.ts` and run through `bun run test-proc` in CI. Use reducer or renderer tests as narrower support, not as a substitute for a TUI app test.
