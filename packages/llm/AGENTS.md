<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# LLM Package

## Purpose

`packages/llm/` owns provider-neutral model contracts, agent mode routing, and Effect AI provider composition. It must use `effect/unstable/ai` plus provider packages such as `@effect/ai-openai`; do not hand-roll model-provider HTTP or SSE adapters.

## Key Files

| File               | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `src/provider.ts`  | Rika request/response schemas plus bridge to Effect AI language models. |
| `src/modes.ts`     | Rush/smart/deep mode definitions as data.                               |
| `src/router.ts`    | High-level LLM router service consumed by agent loops.                  |
| `src/live.ts`      | Provider registry composition for enabled model providers.              |
| `src/openai.ts`    | OpenAI live layer composed from `@effect/ai-openai`, not raw HTTP/SSE.  |
| `src/anthropic.ts` | Anthropic live layer composed from `@effect/ai-anthropic`.              |
| `src/retry.ts`     | Shared transient retry classification and schedules.                    |
| `src/index.ts`     | Package namespace exports.                                              |

## Current Standards

- Agent orchestration code depends on `Router.Service`; Effect AI/provider-package details stay in this package.
- Compose enabled providers through `Live.layer(Live.optionsFromEnv(env))` at process or host boundaries; do not make callers know individual provider layers.
- Tests use `Provider.fakeLayer` or fake registries; they must not require network or model credentials.
- Keep modes as data so custom modes and providers can be added without changing actors or CLI code.
- Normalize Effect AI streams into Rika `Provider.StreamEvent` values before exposing them outside this package. Tool parameter parts must remain typed tool events; never downgrade them to assistant text.

## Streaming resilience

`streamWithLanguageModel` wraps construction in `Stream.suspend` so each subscription (including retry attempts) allocates a fresh `StreamState`. `Stream.catchReason("AiError", "InvalidOutputError")` salvages provider-executed tool-call parts (e.g. `image_generation`) that the zero-toolkit decoder rejects, turning them into a clean `response.completed` instead of crashing the turn. A trailing `Stream.catch` salvages any failure that occurs after content has streamed so retries never replay or duplicate deltas; only handshake failures with no content yet propagate. The retry middleware in `src/openai.ts` (`Stream.retry` with a jittered exponential `Schedule` gated by `Retry.isTransient`) therefore only retries pre-content transient errors and never `InvalidOutputError`. The agent loop in `@rika/agent` feeds a failure back to the model once so it can recover and continue.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before changing services or layers.
- Do not add raw `fetch`, provider response parsing, or SSE decoding for model providers; compose official Effect AI providers instead.
- Keep provider-specific request defaults in thin layer-composition modules such as `src/openai.ts` and `src/anthropic.ts`.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
