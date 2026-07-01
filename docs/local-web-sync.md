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
- `ThreadEventLog` remains canonical durable truth. `ThreadLive` is notification and catch-up plumbing, not a second store.
- Clients subscribe with `after_sequence`. The server attaches to live events, catches up from the event log, deduplicates by `sequence`, and repairs gaps from the log.
- Clients must dedupe by `sequence` and must not optimistically append their own submitted user messages.
- Only one active turn per thread is accepted in the local MVP. A concurrent turn can return a typed `409` API error.

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

The Vite development server exposes `/api/rika/*`. That proxy reads `<workspace>/.rika/local-backend.json`, forwards requests to the current shared backend, injects the backend token server-side, and streams NDJSON responses through to the browser. The token is not exposed to browser code.

Set `RIKA_WORKSPACE_ROOT` or `RIKA_DATA_DIR` when the web dev server should follow a workspace other than the repository root. Set `VITE_RIKA_API_BASE_URL` only when intentionally bypassing the local Vite proxy.

## Foldkit architecture

The web app follows The Elm Architecture:

- one `Model` schema for browser state
- one `AppMessage` schema for user, command, and subscription messages
- one pure `update` function
- commands for health, thread list, open thread, create thread, and submit turn
- one subscription keyed by the opened thread and starting sequence

Local shadcn-style primitives live in `apps/web/src/ui.ts`. They are copyable Foldkit view helpers with local CSS classes, not imported React components. Keep them small and accessible, and prefer explicit attributes over a large component framework.
