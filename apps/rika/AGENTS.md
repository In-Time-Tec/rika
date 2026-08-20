# Rika CLI

Hosted client and foreground local executor. The Railway API owns authentication, threads, commands, events, assignments, leases, fencing, and results. `src/client-main.ts` is the only executable entrypoint; `src/hosted/hosted-foreground.ts` owns the scoped outbound TUI session.

The client must not initialize or import a local server, listener, daemon, sidecar, SQLite/TenetKit authority, product store, or hidden helper. Local workspace paths and admission tickets stay in the foreground process and never cross the API boundary.

Use `*.test.ts` for unit tests of one owned behavior. Native E2B acceptance tests use `*.integration.proc.test.ts` and run through the Bun proc project. Do not load Bun-only E2B modules from the Node/unit project.
