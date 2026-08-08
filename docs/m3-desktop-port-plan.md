# M3 — Desktop fork + Rika-native port (execution plan)

Status: M0 (rename) + M0 (apps/server extraction) + M1 (P1 crypto, P4 spawn/health) + M2 (@rika/client) are DONE and committed on `refactor/apps-desktop` (7 commits, all gates green). This document is the execution plan for M3.
> **Step 2 DONE (2026-08-08): fork workspace restored (own bun install, 1623 pkgs, catalog), baseline `electron-vite build` green (~18s), desktop app launches (main/renderer/sidecar, window verified); Rika gates 23/23. Steps 3–5 pending.**

## Goal (from issue #284)

Fork opencode's desktop application (shell + renderer + UI packages) into Rika, port the renderer's data layer to Rika's model (Threads/Turns/Units/Blocks), cut opencode-specific features (LSP, snapshots/revert, ACP, provider OAuth UI), and own it outright (no upstream tracking). CLI/TUI/Server must stay green throughout.

## Source inventory (verified from the local opencode checkout, anomalyco/opencode @ dev)

- `packages/desktop` — Electron shell (main/preload/renderer). Engine-agnostic except the renderer import of `@opencode-ai/app` and the `virtual:opencode-server` sidecar.
- `packages/app` — the SolidJS renderer (~467 files). Imports from `@opencode-ai/client` (vendored tarball `app/vendor/opencode-ai-client-1.17.13-v2.tgz`), `@opencode-ai/sdk` (v2 client), `@opencode-ai/schema` (types), `@opencode-ai/core` (ONLY `util/{encode,path,binary,retry,array}` — no engine), `@opencode-ai/ui`, `@opencode-ai/session-ui`, `@pierre/trees`, `@pierre/diffs`, `ghostty-web`, solid-js.
- `packages/ui` — shared components (icons, tooltips, marked/shiki, worker pool); depends on `@pierre/diffs` + `@opencode-ai/core/util/*`.
- `packages/session-ui` — session components (diffs, review, line comments); depends on `@opencode-ai/{client,sdk,ui,core-utils}` + `@pierre/diffs`.

## Fork layout (three apps — plan of record)

```
apps/desktop/          ← forked opencode/packages/desktop (shell), Rika-owned
packages/opencode-app/ ← forked opencode/packages/app (renderer) — OR apps/desktop/src/renderer
packages/opencode-ui/  ← forked opencode/packages/ui
packages/opencode-session-ui/ ← forked opencode/packages/session-ui
packages/opencode-schema/ ← forked @opencode-ai/schema types only (rename to @rika/opencode-schema or fold into the port)
vendor/opencode-client-tarball/ ← vendored tarball (types only, runtime replaced by @rika/client)
```

DECISION NEEDED: keep the opencode packages as separate `packages/opencode-*` (simpler diff against upstream, but we're NOT tracking upstream) vs. nest renderer+ui inside `apps/desktop`. RECOMMENDATION: `apps/desktop` contains shell + renderer; `packages/opencode-ui` + `packages/opencode-session-ui` as separate packages (they're generic UI, reusable); schema types folded into a local `apps/desktop/src/schema` or `packages/opencode-schema`.

## Cut list (removed outright, not stubbed)

- LSP diagnostics surfaces (session context tab, file browser LSP states)
- Snapshots / revert dock
- ACP surfaces
- opencode provider-auth OAuth UX (Rika uses device-code auth — wire later)
- opencode server connection machinery: `context/server-sdk.tsx`, `server-sync.tsx`, `server.ts`, `utils/server*.ts`, `global-sync/*`, `@opencode-ai/sdk` + `@opencode-ai/client` runtime paths

## Port map (UI concept → Rika source)

| UI concept                           | Rika source                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Project                              | Workspace / data-root                                                        |
| Session                              | Thread                                                                       |
| Message                              | Turn / Unit (Entry)                                                          |
| Part (text/reasoning/tool/diff/file) | Block (Text/Reasoning/ToolCall/Diff/File/ImageAttachment/SubagentCard)       |
| Session events                       | ThreadViewSnapshot/Patch (revisioned) + model stream deltas via @rika/client |
| Permission dock                      | AuthorizationCard → ApproveAuthorization/DenyAuthorization                   |
| Question dock                        | interactive prompts (same command path)                                      |
| Terminal panel                       | Rika Shell/process output via transcript (interactive PTY bridge later)      |
| Model/provider pickers               | Config operations (providers, model route)                                   |
| Session list/search/archive          | Thread operations                                                            |
| Usage/cost                           | Thread view usage + turn.completed                                           |

## Execution phases (each ends with a green gate)

1. **Fork & baseline build (mechanical)**: copy the 4 opencode packages + schema + vendored client into the layout; add them to the workspace (turbo, tsconfig, policy edges); make `apps/desktop`'s Electron shell build with the opencode renderer UNCHANGED (proves the fork is sound before touching anything). Gate: `bun run check` green + `apps/desktop` electron build produces an app.
   - NOTE: opencode app builds with Vite/Solid (its own toolchain); Rika's `check` runs turbo over Bun/tsgo. Decide: give `packages/opencode-*` their own build scripts (vite build) and exclude from Rika's tsgo/unit gates initially (policy exceptions), OR port incrementally so they compile under tsgo. RECOMMENDATION: policy exceptions initially (forked code isn't Rika-native yet), removed as the port progresses — matches "Effect-native everywhere" as a porting goal, not a fork prerequisite.
2. **Port stores layer (the heart)**: replace `context/server-sdk.tsx` + `global-sync/*` with Rika stores built on `@rika/client`: ThreadViewSnapshot/Patch → sessions/messages/parts shapes the UI already consumes. Keep UI components compiling against the SAME store shapes (the port is store-internal first). Gate: app renders a thread from a live Rika Server.
3. **Port actions**: composer submit/steer/cancel/interrupt, permissions, paging, thread ops — through `@rika/client` session. Gate: end-to-end chat + approve/deny against a real server.
4. **Cut + cleanup**: remove LSP/snapshot/ACP/provider-OAuth surfaces and their routes/commands; delete dead code. Gate: `bun run check` green, no `@opencode-ai/sdk|client` runtime imports remain.
5. **Rika-native polish**: modes in composer, thread browser semantics (labels/fork/export), Rika authorizations, i18n/theme, Effect-native new code. Gate: full check + desktop E2E smoke (spawn server, chat, interrupt, restart).

## Verification per phase (from the objective)

- CLI: built binary `rika --version`, `rika doctor`
- Server: boot, `/health` 200, server.json, Node-only probe
- TUI: `bun run test-tui` (25 tests)
- Desktop: electron build + run against a live Rika Server (create thread, submit, stream, interrupt, restart persists)
- OpenRouter free models: note free endpoints reject Rika's full tool context (provider limitation, documented in M1) — use a local/scripted model for E2E if needed.

## Known risks

- Context budget: M3 is a fresh-context task (this session already consumed ~600k tokens). Start M3 in a new session with this doc.
- The opencode renderer is SolidJS (not Effect) — the port keeps Solid as the view layer; all new/store code is Effect-native (per D7).
- Two M2 subagents wrote concurrently to the worktree (killed; lesson: verify no ghost kernels before editing).
- Branches are behind 1 (origin/main advanced); rebase before push.
