# Rika Specification

Read `CONTEXT.md`, `AGENTS.md`, and the owning feature branch before implementation.

## Feature Branches

| Area                                 | Specification                                 |
| ------------------------------------ | --------------------------------------------- |
| Product intent and scope             | `docs/spec/01-product-intent.md`              |
| Vocabulary and ownership             | `docs/spec/02-domain-and-authority.md`        |
| Non-functional requirements          | `docs/spec/03-non-functional-requirements.md` |
| Modes and model routing              | `docs/spec/04-modes-and-model-routing.md`     |
| Threads and execution projection     | `docs/spec/05-threads-and-executions.md`      |
| Tools and permissions                | `docs/spec/06-tools-and-permissions.md`       |
| Child runs and multi-agent work      | `docs/spec/07-child-runs.md`                  |
| Steering, queueing, and cancellation | `docs/spec/08-live-input.md`                  |
| Context, skills, and compaction      | `docs/spec/09-context-and-skills.md`          |
| MCP and plugins                      | `docs/spec/10-extensions.md`                  |
| TUI interaction and visuals          | `docs/spec/11-tui.md`                         |
| Effect SQL product persistence       | `docs/spec/12-persistence.md`                 |
| Effect CLI and automation            | `docs/spec/13-cli.md`                         |
| Dynamic workflows                    | `docs/spec/14-workflows.md`                   |
| Testing, evals, and parity evidence  | `docs/spec/15-testing.md`                     |
| Observability and diagnostics        | `docs/spec/16-observability.md`               |

## Feature Ledger

`docs/features/FEATURES.md` is the canonical implementation ledger. ADRs explain why architecture choices were made; the feature ledger records what the product does, where it is specified, its implementation status, and the evidence proving it.

## Decisions

| Decision                               | ADR                                                                 |
| -------------------------------------- | ------------------------------------------------------------------- |
| Local-only product                     | `docs/spec/decisions/0001-local-only.md`                            |
| Published Baton and Relay dependencies | `docs/spec/decisions/0002-published-framework-dependencies.md`      |
| Relay owns durable execution           | `docs/spec/decisions/0003-relay-execution-authority.md`             |
| Baton owns the agent loop              | `docs/spec/decisions/0004-baton-agent-loop.md`                      |
| Effect SQL SQLite product persistence  | `docs/spec/decisions/0005-effect-sql-sqlite.md`                     |
| OpenTUI visual boundary                | `docs/spec/decisions/0006-opentui-boundary.md`                      |
| WebSockets over SSE                    | `docs/spec/decisions/0007-websocket-transport.md`                   |
| No v1 compatibility                    | `docs/spec/decisions/0008-greenfield-v2.md`                         |
| No semantic search or ast-grep outline | `docs/spec/decisions/0009-reduced-tool-surface.md`                  |
| Effect CLI command contracts           | `docs/spec/decisions/0010-effect-cli.md`                            |
| One owner and runtime per Relay SQLite | `docs/spec/decisions/0012-single-owner-relay-sqlite.md`             |
| Config-owned gateways and role routes  | `docs/spec/decisions/0013-config-owned-gateways-and-role-routes.md` |

## Stop Gates

- No public feature exists without a feature-ledger row and owning spec.
- No stable architectural choice exists without an ADR.
- No framework source is copied into Rika.
- No Relay or Baton internal import is introduced to bypass a missing export.
- No command parses raw process arguments.
- No process transport uses SSE.
- No semantic search or ast-grep outline product tool is introduced.
