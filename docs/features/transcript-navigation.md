# Transcript navigation and detail

The transcript follows new output while the user is at the bottom. Scrolling or
Page Up pauses follow without moving the reading position as output streams;
End returns to the live bottom. Home jumps to the oldest loaded content.
Scrolling is local to the TUI process: the full delivered timeline is held in
memory and only the units intersecting the viewport are mounted, so scroll-back
never waits on the server and never remounts the whole transcript.

Tab and Shift+Tab move through expandable tool, diff, and subagent rows. Enter
or a click toggles the selected row. Reasoning is not expandable: it renders in
full as dim italic Markdown, and both reasoning and answers format Markdown
while they stream. Each rendered update interprets the complete source so blank
lines inside fences and late reference definitions remain correct. Unchanged
parsed blocks, wrapped lines, and native row bands are reused; blank lines alone
never permanently settle Markdown. This spends more lexer work than a
paragraph-only tail, but avoids chunk-dependent output and missing final deltas.
The terminal mounts only visible units plus overscan; the scrollbar reflects the
full in-memory timeline, and dragging it re-positions the mounted window.
