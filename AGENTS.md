# Rika

Rika is a collaborative coding-agent CLI and OpenTUI application written in Effect TypeScript. A local Runner works in a user-controlled checkout; an explicitly selected Orb works in an isolated E2B workspace. The hosted API owns identity, access, Threads, and product state, while Generalist owns durable execution and the agent loop.

Read [PRODUCT.md](PRODUCT.md) for product direction and [CONTEXT.md](CONTEXT.md) for exact vocabulary and ownership. Current behavior belongs in [docs/features](docs/features), lasting choices in [docs/decisions](docs/decisions), and meaningful costs in [docs/tradeoffs](docs/tradeoffs).

## Commands

This repository pins Bun 1.4.0 in `package.json`.

| Task                                  | Command                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Install dependencies                  | `bun install --frozen-lockfile`                                                                                                  |
| Build every workspace                 | `bun run build`                                                                                                                  |
| Run the development stack             | `bun run dev`                                                                                                                    |
| Deploy a personal Railway stack       | `bun run dev:remote`                                                                                                             |
| Destroy that personal Railway stack   | `bun run dev:remote:destroy`                                                                                                     |
| Run the source CLI                    | `bun run --cwd apps/rika start -- --workspace "$PWD"`                                                                            |
| Lint                                  | `bun run lint`                                                                                                                   |
| Type-check                            | `bun run typecheck`                                                                                                              |
| Run all deterministic unit tests      | `bun run test`                                                                                                                   |
| Run one unit test                     | `bun --bun vitest run --project unit path/to/file.test.ts`                                                                       |
| Run one process or TUI test           | `bun --bun vitest run --project proc path/to/file.proc.test.ts` or `bun --bun vitest run --project tui path/to/file.tui.test.ts` |
| Run tests touched by the current diff | `bun run test-changed`                                                                                                           |
| Format the repository                 | `bun run format`                                                                                                                 |

The full CI-equivalent check is:

```bash
bun run check
bun run test
bun run test-proc
bun run test-tui
```

`bun run check` runs type-checking, ast-grep, oxlint, and repository lint. `bun run test` does not include process or TUI tests. Keep `*.test.ts`, `*.proc.test.ts`, and `*.tui.test.ts` in their matching Vitest projects; see the `writing-rika-tests` skill.

In an Amp orb, `.amp/services.yaml` owns the Docker daemon, secret service, development stack, readiness check, and Portal. Start or repair it with `amp orb services ensure`; do not start a second `bun run dev` beside it.

## Real product flows

Use a published install from [README.md](README.md), or run the current checkout through the `rika-acceptance` skill. Its script packages the current host target, checks the release inventory, version, and help, then can launch that packaged binary.

- **Local Runner:** `rika --workspace "$PWD"` opens the TUI and creates a Runner Thread by default. The same process registers that checkout as its Runner. See [Runner and Orb execution](docs/features/execution-placement.md).
- **Headless Runner:** `rika --no-tui --workspace "$PWD" --allow-remote-thread-creation` keeps the checkout available for remotely created Runner Threads. Use `--deny-remote-thread-creation` when that must be forbidden explicitly.
- **Orb:** choose `new in Orb` from the TUI command palette, or run `rika thread new`; the CLI command creates an Orb Thread from the current workspace seed and prints its ID. An Orb is prepared only after its first prompt and never silently becomes a Runner.
- **Reconnect:** transport reconnect is automatic. To reopen after process exit, run `rika thread continue --last` or `rika thread continue <thread-id>`. Closing the TUI does not cancel hosted work. See [server lifecycle](docs/features/server-lifecycle.md) and [server transport](docs/features/server-transport.md).
- **Continue work:** submit another prompt with Enter. If a Turn is active, Enter durably queues a Pending Turn; `rika run --thread <thread-id> "<prompt>"` submits one noninteractive follow-up to an existing Thread. See [execution control](docs/features/execution-control.md) and [the pending queue](docs/features/pending-turn-queue.md).
- **Cancel:** while work is active, Ctrl+C sends a durable cancellation request; a second Ctrl+C force-quits the client. There is no CLI cancellation subcommand. When idle, Ctrl+C opens the exit menu instead. See [terminal lifecycle](docs/features/terminal-lifecycle.md).

The exhaustive local Runner, Orb, restart, cancellation, and recovery acceptance contract is [VERIFICATION.md](VERIFICATION.md). Use the `testing-with-pilotty` skill for fast interaction checks and `testing-with-agent-tty` for reviewer-facing recordings.

## Sources of truth

- `apps/rika` owns the packaged CLI, TUI process, hosted client, and local Runner.
- `apps/api` owns hosted composition, HTTP and WebSocket entry points, model routing, command workers, and Executor assignment.
- `apps/web` owns browser rendering and browser-local interaction only. `apps/proxy` is the only public Railway ingress.
- `packages/product` owns Rika product contracts and rules. `packages/product-store` owns their PostgreSQL persistence and migrations.
- `packages/execution` is Rika's Generalist boundary. Generalist remains the authority for Runs, model turns, tool operations, retries, cancellation, and Run events; see [execution authority](docs/decisions/execution-authority.md).
- `packages/execution` owns the four native workspace tool implementations (`bash`, `edit`, `read`, and `shell_command_status`) and routes remote calls through durable outer operation identities.
- `packages/terminal` owns terminal state and presentation. Keep OpenTUI imports behind that adapter.
- `packages/e2b-executor`, `packages/remote-execution`, and `infra/e2b` own Orb execution. E2B is the only remote workspace provider; see [the E2B decision](docs/decisions/e2b-remote-execution.md).
- `scripts/packaging/package-contract.ts`, `scripts/packaging/package-target.ts`, and `.github/workflows/publish.yml` own the current release artifact contract.

Use released Generalist, Effect, FoldKit, and OpenTUI package exports. Browser Thread control is a FoldKit program; client and Executor transport uses WebSockets.

Keep temporary run state under a distinct `.agents/state/<run>/` directory. It is ignored and must never become implemented product truth or be force-added to Git.

## Production and shipping

Treat these paths as production-sensitive:

- `packages/identity/migrations`, `packages/product-store/migrations`, and `apps/api/src/database/migrate.ts` change PostgreSQL authority.
- `apps/api/src/config`, `apps/api/src/security`, `packages/credential-vault`, `packages/identity`, and `packages/github-app` handle production identity, authorization, credentials, or repository access.
- `apps/proxy/Caddyfile` and `apps/*/railway.json` define public ingress and Railway deployment behavior. Production follows `main`; pull requests receive isolated Railway environments as described in [the Railway decision](docs/decisions/railway-api.md).
- `infra/e2b`, `packages/e2b-executor`, and `.github/workflows/executor-image.yml` define the immutable production Executor image and E2B template promotion.
- `.github/workflows/publish.yml`, `install.sh`, and `scripts/packaging` define release installation and publication.

Do not print secrets or put credentials in source, logs, Executor payloads, snapshots, or artifacts. Do not run production migrations, deploy, promote an Executor image, publish packages, create a release, or push a tag unless the user explicitly requests that exact external action.

`bun run dev:remote` is a live Railway mutation. It creates one isolated personal project using the ignored
`.alchemy/rika-dev-stage` identity. Never replace that identity with `production`, `staging`, or `pr-*`, and never
delete `.alchemy` while resources may remain. `bun run dev:remote:destroy` retains the identity and Alchemy state
so failed cleanup can be retried. Railway provisioning credentials stay in the Alchemy process and must not be
added to service variables. Set `RAILWAY_WORKSPACE_ID` explicitly before any personal deployment.

CI has separate `quality`, `tui`, and `proc` jobs. A `v*` tag runs the publish workflow: the tag must equal `v` plus `apps/rika/package.json`'s version, the tagged commit must have green CI unless an explicit audited override is used, native archives are built for `darwin-arm64`, `linux-arm64`, and `linux-x64`, and the workflow verifies inventory, architecture, checksums, and provenance before publishing GitHub and npm artifacts. The Executor image is promoted only by its separate manual workflow with a new generation and `promote=true`.
