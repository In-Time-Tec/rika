# Orbs Hosted Control Plane

The Hosted Control Plane is a remote implementation of the local orb control-plane services. It owns hosted authentication, orb lifecycle records, central event mirroring, and multi-client fan-out while preserving the local `OrbManager` and Remote Control contracts.

Spike proof: [`spike/orb-control-plane-http-seam-66`](https://github.com/dallenpyrah/rika/tree/spike/orb-control-plane-http-seam-66), commit [`3234e0a`](https://github.com/dallenpyrah/rika/commit/3234e0a). The branch is intentionally not merged. It proves an HTTP client layer can provide `OrbManager.Service` and pass provision, pause, resume, kill, schema decode, and typed failure mapping against a hosted stub.

## Decision

Hosted orbs use a small Hosted Control Plane as the authority for orb lifecycle, workspace access, and event fan-out. The local CLI keeps the same user-facing commands. `RIKA_CONTROL_PLANE_URL` switches the CLI/server runtime from local `OrbManager` and local `OrbStore` layers to remote client layers that implement the same Effect service interfaces.

## Problem

Local-first orbs already work because the user's machine owns the SQLite orb registry, talks to E2B, and mirrors in-orb events locally. Hosted clients need the same behavior when the user's laptop is offline.

What is true now:

- `OrbManager` creates and manages E2B sandboxes from a local process.
- `OrbStore` and `OrbMirror` persist local orb records and mirror in-orb event streams into local SQLite.
- `ThreadActor` exists, but it has no live event-stream action equivalent to `subscribeThreadEvents`.

What must remain true:

- `startTurn` stays submit-only.
- Clients render from `subscribeThreadEvents`.
- The append-only Event Log remains canonical.
- Workspace authorization uses `WorkspaceAccess`, not self-asserted `user_id`.
- Local-first CLI use keeps working without hosted credentials.

What should become true:

- A hosted service can provision, pause, resume, kill, and mirror orbs while clients use the same SDK and command shapes.
- Hosted web/TUI/SDK clients can subscribe to live events without keeping a local backend online.

Core tradeoff: this design centralizes orb control-plane state for hosted reliability while keeping the existing local service interfaces to avoid a second product/runtime model.

## Topology

```text
CLI / TUI / Web / SDK
        |
        | Remote Control HTTP+NDJSON
        v
Hosted Control Plane
        |
        +-- WorkspaceAccess
        +-- HostedOrbManager -> E2B
        +-- HostedOrbStore   -> hosted DB
        +-- HostedOrbMirror  -> orb Remote Control stream
        |
        v
ThreadActor
        |
        v
ThreadEventLog + projections
```

The Hosted Control Plane is not a new client protocol. It is a deployment of existing ports behind remote adapters.

| Interface               | Local layer                    | Hosted layer                          | Hides                                                        |
| ----------------------- | ------------------------------ | ------------------------------------- | ------------------------------------------------------------ |
| `OrbManager.Service`    | E2B SDK adapter in `@rika/orb` | HTTP client to Hosted Control Plane   | Sandbox provider, endpoint token handling, lifecycle retries |
| `OrbStore.Service`      | local SQLite                   | hosted DB repository                  | Orb rows, endpoint credentials, usage intervals              |
| `OrbMirror.Service`     | local process stream consumer  | hosted stream consumer                | In-orb event catch-up, idempotent local/hosted append        |
| `RemoteControl.Service` | local server process           | hosted API process                    | Thread routes, typed errors, event subscriptions             |
| `ThreadActor`           | local/parallel adapter today   | hosted turn router and fan-out entity | Active turn serialization and hot subscriptions              |

## Authentication

Hosted API access uses API tokens per user. Tokens are bearer credentials issued by the Hosted Control Plane and stored by the client in the same local secret boundary as the existing local backend token. The token identifies the caller. The request `user_id` remains attribution and presence data only.

Token rules:

- Tokens are scoped to a user and may carry workspace grants or refer to server-side grants.
- Tokens are stored hashed server-side.
- Tokens are never written to thread events, orb records, diagnostics, or project env.
- Every hosted request resolves the token to an authenticated principal before reading `user_id`.
- Machine callers, such as the hosted orb mirror, use separate machine tokens scoped only to the orb endpoint and thread stream they must mirror.

Authorization rules:

- Workspace and thread reads call `WorkspaceAccess` before returning data.
- Orb lifecycle mutations require workspace write access for the orb's project/workspace.
- Administrative project and membership mutations require owner access.
- `user_id` without a valid hosted token is rejected in hosted mode; local mode keeps the no-user local-first behavior.

## Hosted Persistence

The hosted DB owns central records that must outlive local clients:

- `orb_records`: the existing orb shape, with endpoint credentials behind the same narrow credential accessor.
- `orb_usage_intervals`: the existing usage interval model.
- `workspace_memberships`: existing durable membership rows.
- `thread_events`: append-only hosted event log.
- `thread_projections`: rebuildable thread summaries and access/search fields.
- `projects`: hosted project profiles, env names, template ids, and secret references.

The hosted DB adapter stays behind persistence services. Raw Drizzle handles do not cross into server, actor, CLI, or SDK packages.

Hosted orb endpoint tokens follow the local rule: normal orb reads omit tokens; only the Hosted Control Plane's `OrbStore.endpointCredentials` equivalent can retrieve them for mirror/resume calls.

## Central Event Mirror

The hosted mirror consumes each running orb backend's `subscribeThreadEvents` stream and appends events into hosted `thread_events` idempotently by `(thread_id, sequence)`. Clients subscribe to the Hosted Control Plane, not directly to the sandbox, so the user's laptop does not need to remain online.

Mirror lifecycle:

1. `HostedOrbManager.provisionForThread` starts the sandbox and stores endpoint credentials.
2. `HostedOrbMirror.mirror(orb_id)` starts or resumes the stream from the latest hosted sequence.
3. Each event is validated against the orb's thread id before append.
4. Appended events update projections and publish through ThreadActor fan-out.
5. Stream failure inspects sandbox lifecycle, marks the orb paused/killed when observable, and interrupts any active turn with a typed failure event.

The mirror is at-least-once. The event log idempotency key makes replay safe.

## Rivet Placement

Rivet belongs between Remote Control and the Event Log as the hosted per-thread turn router and live fan-out owner. The per-thread `ThreadActor` serializes active turns, replays state from `ThreadEventLog`, and publishes live event frames to subscribers.

The first Rivet work item is a live event-stream action on `ThreadActor`.

Current actor actions:

- `EnsureThread`
- `AcceptTurn`
- `ReplayThread`
- `GetSnapshot`

Required hosted action:

```ts
SubscribeThreadEvents(input: {
  readonly thread_id: ThreadId
  readonly after_sequence?: number
}): Stream<Event | PresenceFrame, ThreadActorActionError>
```

Until that action exists, the Hosted Control Plane may expose Remote Control streams from the API process directly, but hosted multiplayer fan-out is not complete.

## Thread Visibility

Hosted sharing uses thread visibility levels:

- `private`: only the creator can read the thread.
- `workspace`: workspace members can read the thread.
- `unlisted`: anyone with the thread id and a valid hosted token can read the thread.

Schema sketch:

```sql
ALTER TABLE thread_projections
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
```

Allowed values are `private`, `workspace`, and `unlisted`. `ThreadProjection` derives the field from thread visibility events. `WorkspaceAccess.authorizeThread` enforces the matrix:

| Visibility  | Creator | Workspace member | Token holder with id | Local no-user |
| ----------- | ------- | ---------------- | -------------------- | ------------- |
| `private`   | allow   | deny             | deny                 | allow         |
| `workspace` | allow   | allow            | deny                 | allow         |
| `unlisted`  | allow   | allow            | allow                | allow         |

The no-user allowance is only for local-first mode.

Thread visibility enforcement is implemented for local and Remote Control paths. Storage lives in `packages/persistence/src/schema/event-log.ts`; visibility events live in `packages/schema/src/event.ts`; `ThreadService.setVisibility` appends `thread.visibility.set` events in `packages/agent/src/thread-service.ts`; `WorkspaceAccess` enforces the visibility matrix in `packages/agent/src/workspace-access.ts`; Remote Control exposes the HTTP route in `packages/server/src/http-server.ts`; the SDK exposes `setThreadVisibility` in `packages/sdk/src/client.ts`; and the CLI exposes `rika threads visibility` plus `rika threads share` through `packages/cli/src/args.ts` and `packages/cli/src/threads.ts`.

The remaining open hosted work is the multi-tenant authentication path: hosted tokens must identify the principal before the existing `WorkspaceAccess` checks run. The local no-user allowance stays local-first only.

## Migration Path

Local-first remains the default.

```text
No RIKA_CONTROL_PLANE_URL
  -> local OrbManager
  -> local OrbStore
  -> local OrbMirror
  -> local SQLite

RIKA_CONTROL_PLANE_URL=https://...
  -> remote OrbManager client layer
  -> remote OrbStore client layer
  -> hosted mirror
  -> hosted DB
```

Client configuration:

| Variable                     | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `RIKA_CONTROL_PLANE_URL`     | Enables hosted control-plane adapters.                        |
| `RIKA_CONTROL_PLANE_TOKEN`   | Bearer token for hosted API calls.                            |
| `RIKA_CONTROL_PLANE_USER_ID` | Optional local attribution default after token auth succeeds. |

Migration sequence:

1. Ship remote client layers for `OrbManager` and read-only `OrbStore` behind `RIKA_CONTROL_PLANE_URL`.
2. Add hosted API endpoints that delegate to the same service interfaces used locally.
3. Move `OrbMirror` into the hosted service and keep local mirror for local-only orbs.
4. Add ThreadActor live stream action and route hosted subscriptions through actors.
5. Wire hosted authentication into the existing thread visibility enforcement path.
6. Make project secrets hosted-secret references in hosted mode; local Project secrets remain local.

Rollback is setting `RIKA_CONTROL_PLANE_URL` off. Existing local commands keep using local SQLite and local E2B credentials.

## Failure Modes

| Failure                                         | Behavior                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Hosted token invalid                            | Reject before workspace lookup; log auth failure without token value.                 |
| Hosted DB unavailable                           | Orb lifecycle calls fail typed; no sandbox mutation starts without durable row write. |
| E2B create succeeds but DB endpoint write fails | Kill sandbox before returning failure, same cleanup invariant as local provisioning.  |
| Mirror stream drops                             | Resume from latest hosted event sequence; duplicate frames are ignored.               |
| ThreadActor unavailable                         | API can reject new turns with 503; event log remains canonical and replayable.        |
| Visibility projection corrupt                   | Rebuild projections from event log before serving hosted reads.                       |

## Non-Goals

- No production hosted implementation in #66.
- No new public client protocol.
- No hosted billing model.
- No direct browser access to orb endpoint tokens.
- No replacement for local-first execution.

## Follow-Up Implementation Issue Drafts

### Hosted OrbManager HTTP adapter

Implement `HostedOrbManager` server endpoints and a CLI/runtime client layer selected by `RIKA_CONTROL_PLANE_URL`. The client layer must provide `OrbManager.Service`; the server layer must delegate to the existing local `OrbManager` implementation behind hosted authz. Acceptance: the #46 fake provisioning sequence passes through the remote client layer, and invalid tokens fail before any sandbox mutation.

### Hosted OrbStore and project persistence

Add hosted persistence adapters for orb records, endpoint credentials, usage intervals, projects, and project secret references. Acceptance: local code depends only on `OrbStore.Service` and `ProjectStore.Service`; hosted mode stores endpoint tokens behind the same credential accessor and normal reads omit token values.

### Hosted OrbMirror worker

Move continuous orb event mirroring into the Hosted Control Plane. Acceptance: a running orb can be mirrored into hosted `thread_events` while all clients are remote; stream reconnect resumes from the latest stored sequence; duplicate frames are idempotent.

### ThreadActor live stream action

Add a live `SubscribeThreadEvents` action to `ThreadActor` and route hosted Remote Control subscriptions through it. Acceptance: replay after `after_sequence` and live events share one stream; presence frames remain ephemeral and are not appended to the Event Log.

### Hosted token service

Add user API token issue/revoke/list flows with hashed token storage and audit diagnostics. Acceptance: hosted API calls authenticate before workspace access; token values never appear in events, diagnostics, or normal API responses.
