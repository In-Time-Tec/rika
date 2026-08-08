# M3 Port Map — opencode desktop data layer → Rika

Ground truth: `apps/desktop/fork` (upstream commit 284214c78d, build+launch verified
2026-08-08) + `packages/client` (`@rika/client`, protocol v8, token auth, HMAC proofs).

## Strategy (unchanged from rika#284 §4)

Keep every UI store shape and reducer in the fork as-is. Replace only the
transport (`ServerConnection`/SDK client) with `@rika/client` and translate
Rika's Thread/Turn/Unit/Block stream into the opencode `Event` shapes the
reducers already consume. No adapter that wraps opencode server — this is a
native Rika-backed data layer.

## What the UI consumes (verified from code)

### Events fed into `app/src/context/global-sync/event-reducer.ts` (store updates)

`global.disposed`, `server.connected`, `server.instance.disposed`,
`session.created|updated|deleted|renamed|usage.updated|archived|moved|diff`,
`todo.updated`, `session.status`, `message.updated|removed`,
`message.part.updated|removed|delta`, `vcs.branch.updated`,
`permission.asked|replied`, `question.asked|replied|rejected`,
`lsp.updated`, `reference.updated`

### Store types (from `@opencode-ai/sdk/v2/client`)

`Message`, `Part`, `PermissionRequest`, `Project`, `QuestionRequest`,
`Session`, `SessionStatus`, `Todo`

### Actions invoked by components (via `ServerSDK.client`, `server-sdk.tsx`)

session prompt/submit, steer, cancel, interrupt, permission reply, question
reply, session create/rename/delete/archive, project list/open, todo update.

## Rika ↔ opencode mapping

| Rika (protocol v8 / @rika/client)                                        | opencode fork type/event                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `Thread` (threadId)                                                      | `Session` (sessionId) — 1:1 id mapping                                                                  |
| `Turn` (user/assistant/steer/tool)                                       | `Message`                                                                                               |
| `Unit`                                                                   | `Part` (text, tool, tool-call, file, reasoning…)                                                        |
| `Block` (text blocks inside units)                                       | part content fragments                                                                                  |
| `ThreadViewSnapshot` / `ThreadViewPatch`                                 | `session.updated` / `message.updated` / `message.part.updated` / `message.part.delta` (revision → diff) |
| `InteractiveEvent` (turns, permissions, questions)                       | `permission.asked/replied`, `question.asked/replied`, `session.status`, `todo.updated`                  |
| `InteractiveCommand` (`Prompt`, `Steer`, `Cancel`, `Approve`, `Deny`, …) | `session.prompt`, `session.steer`, `session.cancel`, `permission.reply`, `question.reply`               |
| `clientKind: "desktop"` + token (server.token)                           | `ServerConnection` auth (same loopback model — Rika already token-authenticated)                        |

## File-by-file port plan

### Phase A — transport (new `app/src/rika/`) — **DONE**

1. `rika/connection.ts` — `@rika/client` `connect()` wrapper: URL from Rika
   server.json/port derivation (env `RIKA_INTERNAL_SERVER_*` + dataRoot), token
   from `<dataRoot>/server.token`, `clientKind: "desktop"`, reconnect policy.
2. `rika/events.ts` — subscribe per-thread `events(dispatch)`; translate
   `ThreadViewSnapshot`/`ThreadViewPatch`/`InteractiveEvent` → opencode `Event`
   shapes (the table above), emitting into the existing `createGlobalEmitter`.

### Phase B — adapter (replace `context/server.tsx` + SDK client surface)

3. `rika/adapter.ts` — `createRikaClient({connection, threadId})` exposing the
   subset of the opencode v2 client API the UI actually calls (session.prompt,
   steer, cancel, create, rename, delete, archive; permission.reply;
   question.reply; project.list) mapped to `InteractiveCommand` invokes via
   `makeInteractiveSession`/`invoke`.
4. `context/server.tsx` — slim to: resolve Rika endpoint + token, own the
   connection lifecycle (replaces opencode `ServerConnection` WS client).
5. `context/server-sdk.tsx` — `createClient` returns the Rika adapter; the
   `ServerSDK.event` emitter is fed by `rika/events.ts`. **~everything else in
   this file is unchanged.**

### Phase C — sync + stores (mostly unchanged)

6. `global-sync/event-reducer.ts`, `session-load.ts`, `session-cache.ts`,
   `child-store.ts`, `queue.ts`, `bootstrap.ts` — unchanged (consume the same
   event shapes from Phase A).
7. `server-sync.tsx` / `server-session.ts` — replace opencode session-view
   fetch with ThreadViewSnapshot (initial load = snapshot; updates = patches).
8. `sync.tsx` optimistic merge — unchanged.

### Phase D — cut list (delete, not stub)

- `app/src/context/file/{watcher,tree-store,content-cache}.ts` LSP/file-watch
  surfaces + all `lsp.*` event handling (reducer case stays inert or removed).
- snapshots/revert (`revert.ts` schema + UI), ACP (`integration.ts`),
  provider-OAuth (`credential.ts` OAuth flow + settings UI), `mcp.ts` stores,
  `server-session-v2-reducer.ts` if opencode-v2-only.

### Phase E — Rika-native polish

- modes/thread ops (Rika thread lifecycle), i18n/theme (already fork-side),
  OpenRouter provider config (free models) in Rika Server settings surfaced
  from Rika's own config, not opencode's provider registry.

## Build order + verification per phase

1. Phase A + B: `bunx electron-vite build` green; app launches; renderer shows
   Rika server connection (no `global-sdk event stream failed` once the real
   Rika server is reachable — use `apps/server` + `RIKA_INTERNAL_SERVER_*` env).
2. Phase C: end-to-end turn in the desktop app against a real Rika Server turn
   (ScriptedModel or OpenRouter free model), TUI/CLI/Server gates re-run.
3. Phase D: build + gates + TUI/CLI/Server untouched (they don't import the fork).
4. Phase E: desktop-only; final full `bun run check` 23/23 + TUI 25/25 + server
   wire tests + desktop launch.

## Verification tooling (existing)

- `apps/server` spawn contract (fd-3 handshake, server.json, /health)
- Node-only probe `test/node-handshake/node-handshake.mjs`
- `bun run check` (23 tasks), `bun run test-tui`, `bun --bun vitest run packages/client/test/*`
- fork: `cd apps/desktop/fork/desktop && bunx electron-vite build && bunx electron .`
