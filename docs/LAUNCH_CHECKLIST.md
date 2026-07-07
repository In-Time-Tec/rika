# Launch Checklist

Issue #30 is the first launch hardening pass. This checklist records what is ready, how it is verified, and what is intentionally not done yet.

## Verification matrix

| Gate          | Command                 | Purpose                                              |
| ------------- | ----------------------- | ---------------------------------------------------- |
| Format        | `bun run format:check`  | Repository formatting.                               |
| Lint          | `bun run lint`          | Oxlint and ast-grep repository lint.                 |
| Typecheck     | `bun run typecheck`     | Package TypeScript contracts through Turbo.          |
| Tests         | `bun run test`          | Unit/integration tests across packages.              |
| Build         | `bun run build`         | Package build graph.                                 |
| Docs          | `bun run docs:check`    | Required docs/scripts/guidance exist.                |
| Migrations    | `bun run db:migrate`    | Committed Drizzle migrations apply locally.          |
| Release smoke | `bun run package:smoke` | Compiled CLI starts, prints help, and runs `doctor`. |

CI runs the same launch gates except local database migration; migrations are covered by package tests and the explicit local gate.

## Launch surface checklist

Code status means the Rika source surface exists. Parity status means Amp evidence, Rika evidence, diff or audit, focused verification, leak scan, and independent `PASS` review exist for the corresponding row in `parity/AMP_FEATURE_INVENTORY.md` and `parity/SCREENSHOT_LOG.md`.

| Surface                             | Code status                                                                                                      | Parity status                                                                                                                                                                                                    | Evidence                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Agent modes                         | Implemented: `rush`, `smart`, `deep` as routing data.                                                            | Partial; visible mode state and runtime behavior remain open in [Modes & models](parity/AMP_FEATURE_INVENTORY.md#modes--models).                                                                                 | `packages/llm/src/modes.ts`                                                        |
| Interactive CLI                     | Implemented MVP line-oriented TUI with Amp-like chrome.                                                          | Mismatch/unverified; visual chrome remains open in [UI chrome](parity/AMP_FEATURE_INVENTORY.md#ui-chrome-the-nitpicky-visual-surface--see-goalmd-6).                                                             | `packages/tui/`                                                                    |
| Non-interactive execute             | Implemented NDJSON event stream on stdout.                                                                       | Partial; scoped alias/error evidence exists, execute runtime and stream behavior remain open in [CLI & integrations](parity/AMP_FEATURE_INVENTORY.md#cli--integrations).                                         | `packages/cli/src/execute.ts`                                                      |
| Durable threads                     | Implemented create/open/list/search/archive/share/reference/manual compact.                                      | Unverified in [Threads](parity/AMP_FEATURE_INVENTORY.md#threads).                                                                                                                                                | `packages/agent/src/thread-service.ts`, `packages/agent/src/compaction-service.ts` |
| AGENTS.md guidance                  | Implemented resolver and subtree/frontmatter behavior.                                                           | Unverified in [Guidance, skills, plugins, MCP](parity/AMP_FEATURE_INVENTORY.md#guidance-skills-plugins-mcp).                                                                                                     | `packages/agent/src/context-resolver.ts`                                           |
| File mentions/images/thread refs    | Implemented as resolved context entries.                                                                         | Unverified in [Prompting & input](parity/AMP_FEATURE_INVENTORY.md#prompting--input).                                                                                                                             | `packages/agent/test/context-resolver.test.ts`                                     |
| Built-in search/edit tools          | Implemented fff, hashline, semantic-search, ast-grep outline.                                                    | Unverified in [Tools & subagents](parity/AMP_FEATURE_INVENTORY.md#tools--subagents).                                                                                                                             | `packages/tools/`                                                                  |
| Subagents                           | Implemented isolated subagent runtime with local read-only default and orb full-tool mode.                       | Partial; auto-spawn and transcript rendering remain open in [Tools & subagents](parity/AMP_FEATURE_INVENTORY.md#tools--subagents).                                                                               | `packages/agent/src/subagent-runtime.ts`                                           |
| Skills                              | Implemented discovery/list/inspect/load and Git-sourced add/remove with provenance lockfiles.                    | Unverified in [Guidance, skills, plugins, MCP](parity/AMP_FEATURE_INVENTORY.md#guidance-skills-plugins-mcp).                                                                                                     | `packages/agent/src/skill-registry.ts`, `packages/cli/src/skill-installer.ts`      |
| Oracle/Librarian/Painter-like tools | Implemented as specialty tools over swappable model/artifact boundaries.                                         | Unverified in [Tools & subagents](parity/AMP_FEATURE_INVENTORY.md#tools--subagents).                                                                                                                             | `packages/tools/src/specialty-tools.ts`                                            |
| Code review checks                  | Implemented local review service and CLI.                                                                        | Unverified in [Tools & subagents](parity/AMP_FEATURE_INVENTORY.md#tools--subagents).                                                                                                                             | `packages/agent/src/review-service.ts`                                             |
| MCP                                 | Implemented client integration, CLI add/remove/doctor, workspace command approval, and skill-bundled `mcp.json`. | Unverified except scoped help rows in [Guidance, skills, plugins, MCP](parity/AMP_FEATURE_INVENTORY.md#guidance-skills-plugins-mcp) and [CLI & integrations](parity/AMP_FEATURE_INVENTORY.md#cli--integrations). | `packages/tools/src/mcp-client.ts`, `packages/cli/src/mcp.ts`                      |
| Plugins                             | Implemented trusted-local TypeScript plugin host.                                                                | Unverified in [Guidance, skills, plugins, MCP](parity/AMP_FEATURE_INVENTORY.md#guidance-skills-plugins-mcp).                                                                                                     | `packages/plugin/src/plugin-host.ts`                                               |
| Self-extension                      | Implemented skill/plugin generation, verification, enable/disable/rollback.                                      | Unverified in [Guidance, skills, plugins, MCP](parity/AMP_FEATURE_INVENTORY.md#guidance-skills-plugins-mcp).                                                                                                     | `packages/plugin/src/self-extension.ts`                                            |
| Remote control + SDK                | Implemented HTTP/NDJSON server and TypeScript SDK.                                                               | Unverified in [Threads](parity/AMP_FEATURE_INVENTORY.md#threads) and [CLI & integrations](parity/AMP_FEATURE_INVENTORY.md#cli--integrations).                                                                    | `packages/server/`, `packages/sdk/`                                                |
| IDE seam                            | Implemented remote-control IDE protocol and CLI helpers.                                                         | Unverified in [CLI & integrations](parity/AMP_FEATURE_INVENTORY.md#cli--integrations).                                                                                                                           | `packages/ide/`, `docs/ide-integration.md`                                         |
| Orb usage and tournaments           | Implemented running-minute intervals, `rika orb usage`, and judged orb tournaments; billing is out of scope.     | Unverified; no Amp parity claim.                                                                                                                                                                                 | `packages/persistence/src/orb-store.ts`, `packages/cli/src/orb.ts`                 |
| Rivet actors                        | Implemented local/remote host config and ThreadActor contract.                                                   | Unverified; no Amp parity claim.                                                                                                                                                                                 | `packages/rivet-host/`                                                             |
| Hosted access control               | Implemented workspace membership service/checks.                                                                 | Unverified; no Amp parity claim.                                                                                                                                                                                 | `packages/agent/src/workspace-access.ts`                                           |
| Owner manual/security docs          | Implemented.                                                                                                     | Documentation exists; Amp parity is not implied.                                                                                                                                                                 | `docs/OWNER_MANUAL.md`, `docs/SECURITY.md`                                         |
| Release artifacts                   | Implemented local Bun compile and smoke.                                                                         | Release mechanics exist; Amp parity is not implied.                                                                                                                                                              | `scripts/package-cli.ts`, `scripts/package-smoke.ts`                               |

## Pending parity lab captures

These visual-chrome rows still need Ghostty + pinned Amp binary capture or recapture before they can move to `match`: startup screen, status line, tool-call card collapse/expand, scroll-while-streaming, diff rendering, and cost display. Current source pointers only prove code presence; they do not satisfy the evidence gate in `goal.md`.

## Known launch non-goals

- No hosted billing/pricing system.
- No telemetry upload by default.
- No plugin sandbox isolation yet; plugins are trusted local code.
- No App Store/Homebrew/npm distribution yet; first launch uses source/compiled artifacts.
- No fully featured IDE extension packages yet; the shared protocol and CLI helpers are ready.
- No live vector/TurboPuffer backend for `semantic_search` yet; the launch tool reports the local lexical backend as degraded until a real vector engine is wired.
- No legal terms beyond repository usage notes; add formal terms before public SaaS launch.

## Release steps

1. Pull main and install dependencies: `bun install`.
2. Run the full verification matrix.
3. Build release artifact: `bun run package`.
4. Smoke compiled artifact: `bun run package:smoke`.
5. Install/update local binary: `bun run install:local`.
6. Start local use: `rika doctor`, then `rika` or `rika --execute "..."`.
