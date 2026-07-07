# @rika/web

Foldkit local web UI for observing and steering shared Rika threads during development.

## Architecture

- `src/app.ts` owns the Foldkit `Model`, `AppMessage`, commands, subscriptions, and pure `update` function.
- `src/view.ts` owns browser presentation only. It renders state and dispatches messages; it does not call the SDK directly.
- `components.json` and `foldcn.lock.json` are the canonical foldcn copy-in layer. Copied and ported components live under `src/components/ui/*`.
- `src/ui.ts` is a thin re-export/adapter over `src/components/ui/*` for app call sites. Do not add hand-rolled primitives there.
- `src/entry.ts` creates the Foldkit runtime, and `src/main.ts` reads browser/query/env flags.
- `vite.config.ts` owns the development proxy from `/api/rika/*` to the current local backend record.
- The FoldKit devtools MCP relay is enabled in development through `foldkit({ devToolsMcpPort: 9988 })`; keep it disabled for test runs.

## Sync rules

- Render only from `openThread` events plus `subscribeThreadEvents`; do not optimistically append submitted user turns.
- `startTurn` is submit-only. Clear the draft and wait for the shared subscription to deliver all visible state.
- Keep `last_sequence` and `subscription_after_sequence` explicit in the model. Deduplicate live events by sequence.
- The browser uses `/api/rika` by default so the Vite dev server can inject the local backend token without exposing it to client code.

## Foldkit rules

- Use callable messages from `foldkit/message` and Effect Schema for message/model contracts.
- Use `Command.define` for SDK calls and convert failures into typed app messages.
- Use `Subscription.make` for long-lived streams keyed by model dependencies.
- Keep `devTools: { Message: AppMessage }` wired in `src/entry.ts` so the FoldKit MCP can dispatch schema-checked messages.
- Keep views as functions of the model. Do not introduce React, hooks, or component-local state.

## Testing and verification

- `bun run --cwd apps/web test`
- `bun run --cwd apps/web typecheck`
- `bun run --cwd apps/web lint`
- `bun run --cwd apps/web build`
