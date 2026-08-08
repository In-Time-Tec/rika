# M3 Phase B contract — opencode SDK client surface → Rika operations

Grounded in the staged fork: `sdk/js/src/v2/gen/sdk.gen.ts` (endpoint classes),
`app/src/**` usage, and Rika's `product-operation.ts` / `interactive-command.ts`
/ `thread-view.ts` contracts. The adapter (`app/src/rika/adapter.ts`) exposes an
opencode-shaped client to the UI while executing Rika operations.

## Rika primitives (verified)

- Inputs: `Interactive` (prompt, mode?, threadId?, last?, ephemeral, workspace?,
  clientWorkspace?), `Run`, `Review`, `Thread` (action: new|last|top|continue
  |list|search|rename|label|fork|export), `Config` (edit), `Auth`, `Mcp` (add),
  `Skill` (list/add), `ToolCatalog` (list/show), `Extension` (list), `Doctor`
- InteractiveCommands: `Submit` (prompt + promptParts), `Shell`, `Steer`,
  `Cancel`, `InterruptAndSend`, `ApproveAuthorization`, `DenyAuthorization`,
  `NewThread`, `SelectThread`, `ReadQueue`, `PreviewThread`, `ReopenThread`,
  `Quit`
- InteractiveEvents: `ThreadViewSnapshot`, `ThreadViewPatch` (revision-based),
  turn/status/todo/permission/question events, `ExecutionFailed`

## Adapter method contract (UI calls → Rika)

| opencode v2 client method | Rika operation | Notes |
|---|---|---|
| `session.list({directory, search, limit})` | `Thread list` (+ `Thread search`) | workspace = directory |
| `session.get(sessionID)` | interactive attach → `ThreadViewSnapshot` | via `runThreadFeed` |
| `session.create({title, directory})` | `Thread new` | then attach |
| `session.prompt(sessionID, {prompt})` | interactive `Submit` on attached session | incl. promptParts (text/image) |
| `session.promptAsync(...)` | `Run` input (non-interactive) | |
| `session.abort(sessionID)` | interactive `Cancel` | |
| `session.interrupt(sessionID)` | `InterruptAndSend` / `Cancel` | |
| `session.update` (rename) | `Thread rename` | archive → defer |
| `session.delete(sessionID)` | — (no Rika delete op) | **CUT** in Phase D; UI hides |
| `session.status(sessionID)` | interactive status events | via session feed |
| `session.todo(sessionID)` | todo events | via session feed |
| `session.fork` | `Thread fork` | |
| `session.command/shell` | `Shell` command | terminal support |
| `session.summarize` | — | **CUT** (no Rika summarize) |
| `session.revert/unrevert/share/unshare` | — | **CUT** (snapshot/revert + share not in Rika) |
| `permission.reply/respond` | `ApproveAuthorization` / `DenyAuthorization` | authorizationId from permission event |
| `question.reply/reject` | `ApproveAuthorization` / `DenyAuthorization` | questionId maps to authorizationId |
| `event.subscribe(...)` | session `events(dispatch)` | translation layer → opencode Event shapes (port-map §Phase B) |
| `project.list/current` | workspace (clientWorkspace) scoping | project = workspace in Rika |
| `project.update/initGit/directories` | — | **CUT/defers**; workspace config in Phase E |
| `config.get/update` | `Config edit` | Rika settings shape |
| `global.health` | `/health` (HTTP) or connection ping | |
| `global.dispose/event` | connection close | |
| `command.list` | Rika CLI commands | defer to Phase E |
| `vcs.get/status/diff/apply` | Rika VCS events (branch.updated) | diff/apply **CUT** in Phase D |
| `find.files/symbols/text` | — | **CUT** (LSP/search not in Rika) |
| `file.list/read` | Rika file ops (workspace FS) | Phase E |
| `tool.list/ids` | `ToolCatalog list/show` | |
| `agent.list`, `app.agents/log/skills` | — | **CUT** (agents/skills in Rika differ; defer) |
| `auth.set/remove`, `provider.*` | `Auth` (Rika provider config) | provider-OAuth UI **CUT**; Rika auth via config |
| `mcp.*` | `Mcp add` + Rika MCP tools | NOT cut — Rika has MCP (server catalog: @batonfx/mcp); map in Phase E |

## Event translation (Rika → opencode shapes)

Consumed by `global-sync/event-reducer.ts` (verified cases): session.created/
updated/deleted/renamed/usage.updated/archived/moved/diff, message.updated/
removed, message.part.updated/removed/delta, todo.updated, session.status,
permission.asked/replied, question.asked/replied/rejected, vcs.branch.updated,
reference.updated.

- `ThreadViewSnapshot` → `session.updated` + `message.updated` per turn
  (Turn→Message, Unit→Part mapping from the port map)
- `ThreadViewPatch` → `message.part.delta` / `message.part.updated` /
  `session.updated` (revision diff)
- permission/question InteractiveEvents → `permission.asked` /
  `question.asked` (+ `replied` after Approve/Deny)
- turn lifecycle events → `session.status` + `message.updated`
- todo events → `todo.updated`

## Build order for Phase B

1. `rika/adapter.ts` — `createRikaClient({connection, threadId, workspace})`
   implementing the table above (core: list/get/create/prompt/abort/
   permission/question/event subscribe; rest stubbed with honest errors)
2. `context/server.tsx` — slim to Rika endpoint + connection lifecycle
3. `context/server-sdk.tsx` — `createClient` → Rika adapter; keep the
   `ServerSDK.event` emitter fed by the translation layer
4. Verify: `bun test src/rika/*` green; `electron-vite build` green; app
   launches; renderer shows Rika-connected state (no global-sdk failure)
