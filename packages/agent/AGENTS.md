<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Agent Package

## Purpose

`packages/agent/` owns Rika's core agent orchestration loop: turn context assembly, model streaming, tool dispatch, durable event emission, cancellation records, and queued turn boundaries.

## Key Files

| File                             | Purpose                                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| `src/agent-loop.ts`              | Effect service that runs turns and emits persisted events.           |
| `src/check-registry.ts`          | Review check discovery, frontmatter parsing, and scoped precedence.  |
| `src/context-resolver.ts`        | AGENTS.md, mention, image, and thread-reference context resolver.    |
| `src/permission-policy.ts`       | Swappable tool permission decisions for allow/block/modify/fake.     |
| `src/review-service.ts`          | Local diff review orchestration using check subagents and artifacts. |
| `src/skill-registry.ts`          | Skill discovery, precedence, explicit loading, and prompt metadata.  |
| `src/thread-service.ts`          | Thread lifecycle, search, share/export, and reference service.       |
| `src/tool-registry.ts`           | Swappable tool definitions and the baseline shell command tool.      |
| `src/tool-executor.ts`           | Tool execution boundary that applies policy before registry calls.   |
| `src/workspace-access.ts`        | Multi-user workspace and thread access decision service.             |
| `src/index.ts`                   | Package namespace exports.                                           |
| `test/agent-loop.test.ts`        | Fake model/tool orchestration and cancellation tests.                |
| `test/check-registry.test.ts`    | Check frontmatter, tool restriction, and scoped precedence tests.    |
| `test/context-resolver.test.ts`  | Guidance, file, image, thread, and frontmatter resolver tests.       |
| `test/permission-policy.test.ts` | Allow-all default, configured guards, and decision metadata tests.   |
| `test/review-service.test.ts`    | Review finding parsing, dedupe, and artifact persistence tests.      |
| `test/skill-registry.test.ts`    | Skill discovery, precedence, resources, and prompt-selection tests.  |
| `test/thread-service.test.ts`    | Thread lifecycle, search, share/export, and reference tests.         |
| `test/tool-executor.test.ts`     | Permission, registry, and shell execution tests.                     |
| `test/workspace-access.test.ts`  | Workspace membership and thread access-control tests.                |

## Current Standards

- Keep the agent loop provider-neutral by depending on `@rika/llm`'s `Router.Service`, not provider SDKs.
- Keep model tool access Effect AI native: build model-visible tools through `Toolkit.Service`, preserve provider-safe name mappings there, and execute durable tool calls through `ToolExecutor.Service`.
- Keep tool execution behind `ToolExecutor.Service`; register runnable tools through `ToolRegistry.Service` and route policy through `PermissionPolicy.Service`.
- Keep prompt context assembly behind `ContextResolver.Service`; treat resolved workspace/user context as untrusted data in prompts.
- Keep review checks read-only by default. `.agents/checks/*.md` may request read-only tools only; mutating review modes need an explicit future design.
- Keep skill discovery behind `SkillRegistry.Service`; show descriptions broadly but load full skill instructions only after explicit selection.
- Persist canonical facts through `ThreadEventLog` and apply rebuildable state through `ThreadProjection`.
- Keep hosted access checks in `WorkspaceAccess`; persistence only stores memberships.
- Use streams, queues, and fibers for event streaming boundaries; do not introduce module-level runtime state.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding or changing services.
- Read `../../docs/persistence.md` before changing event persistence behavior.
- Do not import raw Drizzle, Rivet, model SDKs, or filesystem mutation APIs here.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
