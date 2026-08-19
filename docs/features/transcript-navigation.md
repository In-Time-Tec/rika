# Transcript navigation and detail

The transcript follows new output while the user is at the bottom. Scrolling or
Page Up pauses follow without moving the reading position as output streams;
End returns to the live bottom. Home jumps to the oldest loaded content.
Scrolling is local to the TUI process: the full delivered timeline is held in
memory and only the units intersecting the viewport are mounted, so scroll-back
never waits on the server and never remounts the whole transcript.

Tab and Shift+Tab move through expandable reasoning, tool, diff, and subagent
rows. Enter or a click toggles the selected row. The terminal mounts only the
visible units plus overscan; the scrollbar reflects the full in-memory
timeline, and dragging it re-positions the mounted window.
