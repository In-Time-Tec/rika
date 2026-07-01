<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-28 | Updated: 2026-06-28 -->

# Server Package

## Purpose

`packages/server/` owns Rika's local-first remote control adapter. It exposes HTTP/NDJSON endpoints over shared protocol schemas and delegates all state changes to agent, thread, artifact, and IDE bridge services.

## Key Files

| File                          | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `src/remote-control.ts`       | Effect service API for thread, turn, interrupt, artifact, and IDE calls. |
| `src/http-server.ts`          | Bun HTTP adapter for the remote-control service.                         |
| `src/thread-live.ts`          | In-process live thread event notification and catch-up service.          |
| `src/index.ts`                | Package namespace exports.                                               |
| `test/remote-control.test.ts` | SDK/server contract tests over local Effect services.                    |

## Current Standards

- Keep the server as an adapter. It must not own durable state separate from `ThreadEventLog`, `ThreadProjection`, or artifacts.
- API payloads use `@rika/schema` remote/event/artifact schemas; do not invent untyped response shapes.
- `startTurn` is submit-only. All clients must render from `subscribeThreadEvents`, not from the turn submission response.
- `ThreadLive` is notification plumbing only: attach live, catch up from `ThreadEventLog`, dedupe by event `sequence`, and recover gaps from the log.
- Localhost starts without auth for the MVP. If a token is configured, require `Authorization: Bearer <token>`.
- Turn execution and permission behavior must continue through `AgentLoop.Service` and `ToolExecutor.Service`.
- Hosted user requests must pass through `WorkspaceAccess.Service`; local requests without `user_id` remain local-first.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before changing services.
- Do not import provider SDKs, Drizzle, Rivet internals, or filesystem mutation APIs here.
- Keep hosted/multi-user access checks delegated to `WorkspaceAccess.Service`; the server only adapts request identity into service calls.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
