# M3 Phase B contract — retained renderer → native Rika

The desktop retains opencode's SolidJS views and store shapes temporarily, but
all production transport and mutations cross Rika protocol v8 through
`@rika/client`. The compatibility facade is local renderer code; it is not an
opencode server adapter and never performs opencode HTTP or SSE requests.

## Rika primitives

- `Thread`: `new`, `last`, `top`, `continue`, `list`, `search`, `rename`,
  `label`, `pin`, `archive`, `unarchive`, `delete`, `usage`, `fork`, `export`.
- `Interactive`: `Submit`, `Shell`, `Steer`, `Cancel`, `ApproveAuthorization`,
  `DenyAuthorization`, `NewThread`, `SelectThread`, queue reads and previews.
- Events: `ThreadViewSnapshot`, revisioned `ThreadViewPatch`,
  `ResyncRequired`, thread summaries, lifecycle/control failures, retry
  scheduling, and shell completion.
- `Auth`: Rika-native OpenRouter login, status, and logout. The desktop
  exposes API-key login for the active Rika provider. Provider OAuth UI is not
  retained.

Rika has no Question or Todo contract. The desktop must not synthesize these
from authorization or lifecycle events. Rika-native MCP remains a separate
future surface; opencode MCP/LSP/VCS/file/PTY contracts are not emulated.

## Renderer method mapping

| Retained UI operation              | Native Rika owner                             | Contract                                                                          |
| ---------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| list/search Threads                | `Connection.run(Thread list/search)`          | Filter returned Threads to the directory runtime's workspace.                     |
| create                             | `Connection.run(Thread new)`                  | Project returned Thread, then select it.                                          |
| select/read                        | one cached `InteractiveSession` per workspace | One event consumer; selection is serialized with commands.                        |
| submit                             | `SelectThread` then `Submit`                  | Public prompt parts are text/image only.                                          |
| shell                              | `SelectThread` then interactive `Shell`       | Recorded shell, not an opencode PTY.                                              |
| cancel                             | `SelectThread` then `Cancel`                  | Does not fabricate another prompt.                                                |
| rename                             | `Thread rename`                               | Refresh the canonical Thread cache.                                               |
| archive/unarchive                  | `Thread archive/unarchive`                    | Both are first-class Rika operations.                                             |
| delete                             | `Thread delete`                               | First-class Rika operation.                                                       |
| fork                               | `Thread fork`                                 | Compatibility message IDs are mapped to owning Rika Turn IDs.                     |
| approve/deny                       | `ApproveAuthorization` / `DenyAuthorization`  | Resolve the exact `{turnId, authorizationId}` from a pending `AuthorizationCard`. |
| “always allow”                     | unsupported                                   | Reject honestly; Rika approval is binary and non-durable.                         |
| OpenRouter API key          | `Auth login`                                  | Never routed through opencode provider auth.                                      |
| question/todo/share/revert/compact | unsupported                                   | Controls are cut; no empty success or unrelated command mapping.                  |

## Projection and revision ownership

A Rika Turn projects deterministically to paired user and assistant Messages.
Thread View provider/model/mode gaps use documented view sentinels (`rika`,
`unknown`, `default`) only; they are not sent back to the server.

Units project to Parts ordered by the canonical encoded `Unit.order` followed
by Unit key. A `ThreadViewPatch.upsert` is a complete Unit replacement, not a
text delta. The adapter therefore:

1. caches a snapshot per Thread;
2. validates and applies patches with `ThreadView.apply`;
3. projects complete before/after views;
4. commits the replacement synchronously before feed acknowledgement;
5. emits stale removals, parent Message upserts, full
   `message.part.updated` replacements, permission transitions, and aggregate
   status.

A revision gap or `ResyncRequired` emits no partial compatibility events and
selects the Thread again for a fresh snapshot. Delta events are reserved for a
future proven-append optimization.

Only `AuthorizationCard(status: "pending")` projects to `permission.asked`.
Resolved cards remove the pending request. No question/todo events are
fabricated.

## Lifecycle and security boundary

Electron main owns the Rika profile, data root, server process, fd-3 readiness,
canonical endpoint resolution, publication validation, and token read. The
trusted main frame receives only `{url, token, identity}` through the existing
zero-argument `awaitInitialization` IPC method. Renderer code cannot choose a
path or read `server.json`/`server.token`.

`GlobalProvider` owns one scoped physical Rika Connection for the native
profile. It supplies cached directory runtimes; repeated compatibility
`createClient({directory})` calls do not create another connection or feed.
Runtime cleanup interrupts directory feeds before the connection scope closes.
Health uses signed Rika `Connection.ping`, not an opencode health endpoint.

## Unsupported surface cut

The Phase B shell removes the question, todo, revert, share, compact,
auto-accept, terminal/PTY, old MCP, LSP, file-review, and provider-OAuth
commands from active UI paths. Any missed invocation terminates locally with a
typed `RikaAdapterError`; the facade has no HTTP fallback.

## Proof

- pure snapshot/patch projection tests cover paired Messages, canonical Part
  ordering, full Unit replacement, stale revision rejection, retry status, and
  binary authorization indexing;
- adapter tests cover an empty profile (`last:false`), one feed consumer per
  workspace, real Thread listing, and selection-before-submit serialization;
- endpoint tests cover canonical publication/token validation and trusted-frame
  IPC confinement;
- app and Electron Vite builds must contain no opencode event subscription and
  a live desktop must connect, ping, create/select a Thread, and render native
  events without `[global-sdk] event stream failed`.
