# Transcript delivery

Clients read semantic transcript units, never raw Generalist pages. Opening a thread
delivers its **full timeline in one snapshot**: the newest units up to the wire
payload bound (32 MiB) and the client's in-memory cap (20,000 units), whichever
binds first. The snapshot is ancestry-closed: whenever a parented unit is kept
its SubagentCard is kept too, so the client never renders a child without its
card. The terminal displays **History truncated** when older units remain
(`hasOlder`). Group headers explicitly report member cards outside the current
rendering window rather than silently presenting authoritative counts beside
missing cards. Live delivery and reload share the same stored
projection, so a reconnect or resync can replace a missed tail without
duplicates or reordered content.

The initial read selects at most 20,000 rows and may make one additional bounded
structural read for the leading Turn's roots and member cards. These reads must
match both projection revision and generation before they are combined. Final
selection enforces the count and encoded-byte budgets **after** completion,
admitting each retained row together with its available prompt and complete
parent chain. Oversized groups may retain only some members, with the visible
membership warning described above. Sparse structural additions never replace
the contiguous history cursor; truncation advances that boundary to the retained
contiguous suffix. A single oversized newest entry is rejected explicitly.

The TUI holds the delivered timeline in memory and scrolls entirely locally:
**scrolling never performs a server round trip.** When a live session streams
past the in-memory cap, the client selects newest units with their ancestor
chains, enforcing the cap even when one subtree exceeds it. Partial groups
retain their headers and display the same membership warning and history flag.
Older content remains durable in the server store but is not reachable from the
TUI once evicted, mirroring OpenCode's fixed-window model with a much larger
window.

There is no directional page fetching (`loadOlder`/`loadNewer`) in the
interactive protocol; the durable keyset page API on the transcript repository
remains available to other consumers such as diagnostics.
