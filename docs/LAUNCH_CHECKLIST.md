# Launch Checklist

Issue #30 is the first launch hardening pass. This checklist records what is ready, how it is verified, and what is intentionally not done yet.

## Verification matrix

| Gate          | Command                 | Purpose                                              |
| ------------- | ----------------------- | ---------------------------------------------------- |
| Format        | `bun run format:check`  | Repository formatting.                               |
| Lint          | `bun run lint`          | Oxlint repository lint.                              |
| Typecheck     | `bun run typecheck`     | Package TypeScript contracts through Turbo.          |
| Tests         | `bun run test`          | Unit/integration tests across packages.              |
| Build         | `bun run build`         | Package build graph.                                 |
| Docs          | `bun run docs:check`    | Required docs/scripts/guidance exist.                |
| Migrations    | `bun run db:migrate`    | Committed Drizzle migrations apply locally.          |
| Release smoke | `bun run package:smoke` | Compiled CLI starts, prints help, and runs `doctor`. |

CI runs the same launch gates except local database migration; migrations are covered by package tests and the explicit local gate.

## Amp-parity checklist

| Surface                             | Rika launch status                                                                                               | Evidence                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Agent modes                         | Implemented: `rush`, `smart`, `deep` as routing data.                                                            | `packages/llm/src/modes.ts`                                                        |
| Interactive CLI                     | Implemented MVP line-oriented TUI with Amp-like chrome.                                                          | `packages/tui/`                                                                    |
| Non-interactive execute             | Implemented NDJSON event stream on stdout.                                                                       | `packages/cli/src/execute.ts`                                                      |
| Durable threads                     | Implemented create/open/list/search/archive/share/reference/manual compact.                                      | `packages/agent/src/thread-service.ts`, `packages/agent/src/compaction-service.ts` |
| AGENTS.md guidance                  | Implemented resolver and subtree/frontmatter behavior.                                                           | `packages/agent/src/context-resolver.ts`                                           |
| File mentions/images/thread refs    | Implemented as resolved context entries.                                                                         | `packages/agent/test/context-resolver.test.ts`                                     |
| Built-in search/edit tools          | Implemented fff, hashline, semantic-search, ast-grep outline.                                                    | `packages/tools/`                                                                  |
| Subagents                           | Implemented isolated subagent runtime with local read-only default and orb full-tool mode.                       | `packages/agent/src/subagent-runtime.ts`                                           |
| Skills                              | Implemented discovery/list/inspect/load and Git-sourced add/remove with provenance lockfiles.                    | `packages/agent/src/skill-registry.ts`, `packages/cli/src/skill-installer.ts`      |
| Oracle/Librarian/Painter-like tools | Implemented as specialty tools over swappable model/artifact boundaries.                                         | `packages/tools/src/specialty-tools.ts`                                            |
| Code review checks                  | Implemented local review service and CLI.                                                                        | `packages/agent/src/review-service.ts`                                             |
| MCP                                 | Implemented client integration, CLI add/remove/doctor, workspace command approval, and skill-bundled `mcp.json`. | `packages/tools/src/mcp-client.ts`, `packages/cli/src/mcp.ts`                      |
| Plugins                             | Implemented trusted-local TypeScript plugin host.                                                                | `packages/plugin/src/plugin-host.ts`                                               |
| Self-extension                      | Implemented skill/plugin generation, verification, enable/disable/rollback.                                      | `packages/plugin/src/self-extension.ts`                                            |
| Remote control + SDK                | Implemented HTTP/NDJSON server and TypeScript SDK.                                                               | `packages/server/`, `packages/sdk/`                                                |
| IDE seam                            | Implemented remote-control IDE protocol and CLI helpers.                                                         | `packages/ide/`, `docs/ide-integration.md`                                         |
| Orb usage and tournaments           | Implemented running-minute intervals, `rika orb usage`, and judged orb tournaments; billing is out of scope.     | `packages/persistence/src/orb-store.ts`, `packages/cli/src/orb.ts`                 |
| Rivet actors                        | Implemented local/remote host config and ThreadActor contract.                                                   | `packages/rivet-host/`                                                             |
| Hosted access control               | Implemented workspace membership service/checks.                                                                 | `packages/agent/src/workspace-access.ts`                                           |
| Owner manual/security docs          | Implemented.                                                                                                     | `docs/OWNER_MANUAL.md`, `docs/SECURITY.md`                                         |
| Release artifacts                   | Implemented local Bun compile and smoke.                                                                         | `scripts/package-cli.ts`, `scripts/package-smoke.ts`                               |

## Known launch non-goals

- No hosted billing/pricing system.
- No telemetry upload by default.
- No plugin sandbox isolation yet; plugins are trusted local code.
- No App Store/Homebrew/npm distribution yet; first launch uses source/compiled artifacts.
- No fully featured IDE extension packages yet; the shared protocol and CLI helpers are ready.
- No legal terms beyond repository usage notes; add formal terms before public SaaS launch.

## Release steps

1. Pull main and install dependencies: `bun install`.
2. Run the full verification matrix.
3. Build release artifact: `bun run package`.
4. Smoke compiled artifact: `bun run package:smoke`.
5. Install/update local binary: `bun run install:local`.
6. Start local use: `rika doctor`, then `rika` or `rika --execute "..."`.
