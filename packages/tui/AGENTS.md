# @rika/tui

Interactive terminal UI for Rika, built on `@opentui/core`. The goal is to look and behave exactly like Amp's TUI.

## Conventions

Do not put comments in code anywhere in this repo. Capture rationale here, in `CONTEXT.md`, or in a skill file. Read `../../docs/effect-module-conventions.md` before adding or changing services. Do not import Drizzle, Rivet, provider SDKs, or filesystem mutation APIs here.

## Architecture

One pure model, one native adapter, one loop:

- `src/view-state.ts` — the single source of truth. A pure `ViewState` + `applyEvent` reducer plus pure helpers (input editing, focus, expand, queue, thinking, palette). The transcript is ONE ordered `entries: TranscriptEntry[]` list so user messages interleave with tool/skill cards in the exact order events arrived. `messages`/`cards` are kept alongside for focus and tests. `hasActivity(state)` is true once `entries` is non-empty.
- `src/keymap.ts` — pure `resolve(context, pending, key)` mapping keys and 2-key chords to `Action`s. No I/O.
- `src/palette.ts` — pure command registry (`category` + `action` + slash `command`) and `filter`.
- `src/keys.ts` — `Key` type + `fromOpenTui` (alt = meta || option).
- `src/ticker.ts` — `Ticker.Service`, a fixed-interval `Stream<void>` driving spinner/orb animation.
- `src/controller.ts` — the only place with control flow. A merged `Queue<AppEvent>` (keys, ticks, model events, resizes) drained sequentially. Per-turn streams are fully contained: a turn failure renders a notice and the loop continues — it never drops to the shell. Turn lifecycle: submit-while-idle forks a turn fiber; submit-while-busy enqueues; Esc-Esc interrupts the fiber and discards queued steering messages; Enter-Enter steers; Ctrl+C Ctrl+C quits.
- `src/adapter.ts` — the ONLY module that touches OpenTUI. Owns the `CliRenderer` + a `Surface` renderable tree, exposes `render(state)`, `keys`, `resizes`. A memory layer records states + replays scripted keys for tests.
- `src/session.ts` / `src/remote-session.ts` — local (`AgentLoop.streamTurn`) and remote (`@rika/sdk`) backends behind a shared `SessionBackend`, both driven by `controller.run`. Default interactive runtime is remote/shared-backend; keep the local seam for ephemeral sessions and tests.

## Amp visual rules (must hold)

- Inherit the terminal theme — never force a background color.
- No boxes around messages or cards. The transcript is flat.
- Markdown: teal bold headers, bold white `**bold**`, amber `` `code` ``, literal `-`/`1.` bullets, green fenced ``` blocks.
- User messages: a heavy green left bar with green text. Assistant messages: flat markdown.
- Cards are single lines: `<status icon> <dim title> <faint meta> ▸` (▸ collapsed, ▾ expanded). `context.resolved` is hidden. Raw `{"tool_call":…}` assistant JSON is hidden.
- No top header. Cost (2 decimals, dim) — mode (colored) sits on the top-right input border; cwd (dim) on the bottom-right; the activity spinner + label sit in a cutout on the bottom-left border.
- Mode accent colors: deep = green, smart = blue, rush = amber. The mode label, activity spinner, and welcome orb are tinted by the active mode and recolor on switch.
- Mode switching (Ctrl+S) is only allowed before a thread is active; Amp locks it once active.
- Input box: rounded, a few rows tall (`minHeight`), real cursor, `?` shortcuts help rendered inside it.
- Command palette (Ctrl+O): centered, `>` filter line, right-aligned dim `category` + bright `action`, full-width amber selected bar.
- Overlays (palette, `@` file picker) window/scroll around the selected row when the list is taller than the box — never compress or sample rows. Rows are `flexShrink: 0` so they clip rather than overlap.
- Messages submitted while a turn is busy are queued and stacked inside the input box. ↑/↓ select a queued message (selected = bold) and show an `enter to steer · backspace to dequeue` hint on the border; Backspace dequeues the selected message, Enter steers it to the front of the queue. The queue drains into the next turn when the current one completes.
- On quit, after the alternate screen tears down, a compact summary (a teal Rika mark, the workspace path, the thread id, and a `rika --thread <id>` resume command) is printed to the terminal scrollback via the adapter's `setExit`.
- Multi-line input: Ctrl+J (reported by OpenTUI as `name: "linefeed"`), Shift+Enter, and a trailing `\` + Enter all insert a newline; the input box auto-grows with content.
- Spinners animate continuously via the ticker; tool/context cards are collapsed by default; thinking is hidden by default (Alt+T toggles details/thinking).

## Backend coupling

Rika uses Effect AI native tool calls. Provider tool parameter deltas arrive as typed tool events, not assistant text. The TUI renders assistant text only from `model.stream.chunk` and renders tools only from `tool.call.*` events; any JSON tool-call scrubber is a legacy migration guard, not correctness logic.

## Testing and verification

Keep all logic pure and unit-tested (view-state, keymap, palette). The adapter is exercised via `@opentui/core/testing` (`createTestRenderer` + `captureCharFrame`) and a memory layer; never spawn the native renderer in tests. Run `bun run typecheck`, `bun run test`, and `bun run lint` from this package or the repo root.
