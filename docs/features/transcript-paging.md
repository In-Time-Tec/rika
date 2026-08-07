# Transcript delivery

Clients read semantic transcript units, never raw Baton pages. Opening a thread
delivers its **full timeline in one snapshot**: the newest units up to the wire
payload bound (32 MiB) and the client's in-memory cap (20,000 units), whichever
binds first. The snapshot is ancestry-closed: whenever a parented unit is kept
its SubagentCard is kept too, so the client never renders a child without its
card. Pages report whether older units remain (`hasOlder`) so the client can
show that history is truncated; live delivery and reload share the same stored
projection, so a reconnect or resync can replace a missed tail without
duplicates or reordered content.

The TUI holds the delivered timeline in memory and scrolls entirely locally:
**scrolling never performs a server round trip.** When a live session streams
past the in-memory cap, the client drops the oldest complete units (never
splitting a parent-child subtree) so the live tail and memory stay bounded.
Older content remains durable in the server store but is not reachable from the
TUI once evicted, mirroring OpenCode's fixed-window model with a much larger
window.

There is no directional page fetching (`loadOlder`/`loadNewer`) in the
interactive protocol; the durable keyset page API on the transcript repository
remains available to other consumers such as diagnostics.
