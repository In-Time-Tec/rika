# Terminal interface

OpenTUI stays behind one adapter. Pure view state owns interaction semantics; a client controller owns resident events, paging, resync, and frame scheduling. The TUI consumes product messages rather than Relay, Baton, SQL, or provider types.

The transcript is bottom-anchored and mounts at most two hundred semantic entries. Keyed entries retain object identity; streaming changes patch the final entry. Follow intent, anchor-preserving prepend, loading states, sidebars, overlays, the composer, cursor lifecycle, terminal suspension, and shutdown remain explicit state.

Queued Turns stack in a compact bordered strip joined to the composer. Each row shows only its prompt; the selected row is emphasized, its hint follows it, and the newest arrival is selected automatically. Up moves into and toward the oldest queued Turn; Down moves toward the newest and returns to the composer after it. Enter steers the selected prompt into the active Turn, Backspace dequeues it, and Ctrl+E edits it in the composer. Enter saves through `EditQueued`; Escape cancels edits or exits queue navigation and restores the composer.

Markdown tables render as bounded rounded grids with header and body separators. Cells wrap within their column widths and never truncate content. When a grid cannot fit, its cells stack without losing content. Markdown headings retain depth hierarchy and inline styles.

The renderer inherits the terminal-default transparent background and paints no application background. Wrapping is bounded by terminal display-cell width, including CJK and emoji. Thread previews use a two-cell content gutter. Automatic composer and queue heights follow their wrapped line counts. Rapid resize bursts are coalesced at the trailing edge and converge to the exact final terminal size.

Users select modes, and each mode sends its configured reasoning effort. Fast mode remains a separate toggle; the terminal has no reasoning-effort override.

Read and search calls form exploration groups. Shell and edits use family groups; unknown tools remain generic. A single-file edit expands directly to its diff. Multi-file edits and multi-command shell groups have independently expandable children. Process waits name the original command. Subagents reveal their delegated task. Every underlying call appears once.

Tool-call argument deltas update the final ToolCall row. A running patch expands automatically and streams per-file diff lines. The result replaces that preview on the same row, without a draft row or delayed duplicate.

Workspace-relative path targets may carry line and column. The adapter renders them as clickable text; the app rejects paths outside the Workspace and suspends the terminal while opening the configured editor.
