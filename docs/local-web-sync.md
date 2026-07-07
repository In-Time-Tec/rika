# Local web sync

Rika local development uses one shared backend per workspace. Interactive terminal windows and the Foldkit web app are clients of that backend; none of them own thread state.

```diagram
╭────────────╮       ╭────────────────────╮       ╭───────────────╮
│ TUI window │──────▶│ Remote control API │──────▶│ Thread event  │
╰────────────╯       │ submit + subscribe │       │ log           │
╭────────────╮       │                    │       ╰──────┬────────╯
│ TUI window │──────▶│ ThreadLive pubsub  │◀─────────────╯
╰────────────╯       ╰─────────┬──────────╯
╭────────────╮                 │
│ Foldkit UI │◀────────────────╯
╰────────────╯
```

## Contract

- `startTurn` is submit-only. A successful response means the backend accepted the turn; it does not return turn events.
- `subscribeThreadEvents` is the shared source of UI truth. TUI and web clients render only events from initial thread open plus the live subscription.
- Presence frames may share the same NDJSON stream, but they are not thread events and do not have event `sequence` values. SDK consumers receive them through `onPresence`.
- TUI and web clients render other connected users from presence snapshots, show typing state, and prefix user messages from other `user_id` values.
- `ThreadEventLog` remains canonical durable truth. `ThreadLive` is notification and catch-up plumbing, not a second store.
- Clients subscribe with `after_sequence`. The server attaches to live events, catches up from the event log, deduplicates by `sequence`, and repairs gaps from the log.
- Clients must dedupe by `sequence` and must not optimistically append their own submitted user messages.
- Only one active turn per thread is accepted in the local MVP. A concurrent turn can return a typed `409` API error with `active_user_id`; clients keep the submitted message queued instead of retrying immediately.

## Local web app

Run a normal Rika TUI first so the shared backend exists:

```bash
rika
```

Then run the web app from the source checkout:

```bash
bun run web:dev
```

Open `http://127.0.0.1:4590`. The app loads the latest local thread automatically, or a specific thread with:

```text
http://127.0.0.1:4590/?thread=<thread-id>
```

Set the browser identity with `?user_id=<name>` or `VITE_RIKA_USER_ID`. The value is used for attribution and presence only; it is not an authorization credential.

The sidebar search input calls `GET /v1/threads/search` and accepts the same thread search filters as the CLI. The adjacent window selector applies `24h`, `72h`, `7d`, or `all` by setting the search `after` bound.

The Vite development server exposes `/api/rika/*`. That proxy reads `<workspace>/.rika/local-backend.json`, forwards requests to the current shared backend, injects the backend token server-side, and streams NDJSON responses through to the browser. The token is not exposed to browser code.

Set `RIKA_WORKSPACE_ROOT` or `RIKA_DATA_DIR` when the web dev server should follow a workspace other than the repository root. Set `VITE_RIKA_API_BASE_URL` only when intentionally bypassing the local Vite proxy.

## Foldkit architecture

The web app follows The Elm Architecture:

- one `Model` schema for browser state
- one `AppMessage` schema for user, command, and subscription messages
- one pure `update` function
- commands for health, thread list, open thread, create thread, and submit turn
- one subscription keyed by the opened thread and starting sequence

The foldcn layer is defined by `apps/web/components.json` and `apps/web/foldcn.lock.json`. Copied and ported components live under `apps/web/src/components/ui/*`; `apps/web/src/ui.ts` is only a thin re-export/adapter for app call sites.
