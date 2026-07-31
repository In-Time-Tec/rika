# Usage and cost

Rika maintains a durable, revisioned usage projection for every admitted non-queued Turn. Normal startup, Thread selection, and `rika threads usage <thread-id>` read this projection without inspecting or replaying Relay execution history. Archived Threads remain part of the global total. An empty projection is unavailable rather than a complete zero.

Execution ingest owns the root source for a Turn, including the root execution and every attached child and grandchild. The title execution is separate and uses its title execution identifier as its source. Each execution-scoped Relay delivery cursor is folded once, so exact replay changes nothing. A conflicting replay or malformed projection fails the operation with its typed cause instead of preserving a successful state.

Usage is write-ahead: ingest commits source usage before it commits the corresponding transcript revision. A concurrent reader can therefore observe usage ahead of transcript content, but never transcript content whose admitted usage was rejected. After the transcript commit, one event-driven worker re-reads Turn, Thread, and global aggregates and publishes them. It has no polling window or background ticker.

Displayed cost, tokens, and time come only from committed aggregates. Every usage notification carries the Thread revision it was read at, and clients drop notifications older than the revision they already hold. Interactive sessions never total unpersisted deliveries and never own a second writer.

Each Turn row stores the compact fold needed to recompute attempts and active time. It also materializes nano-USD, tokens, active milliseconds, priced and unpriced attempts, counted and uncounted attempts, projection version, and source completeness. A Thread or global metric sums the Turns that have it and is unavailable only when no included Turn has it.

A provider-reported USD amount is the only priced cost for a model attempt. Usage reports contribute tokens only; missing provider cost, malformed provider cost, conflicting corrections, and settled attempts without provider cost remain explicitly unpriced. Incomplete pricing is unavailable in the UI rather than shown as a partial dollar total. Total tokens are input plus output; cache buckets partition input and reasoning belongs to output.

Active time is measured per execution from durable Relay lifecycle timestamps: a start or wake opens an interval and a wait or terminal event closes it. An execution whose lifecycle is incomplete or contradictory contributes nothing and is recorded as absent; the other executions still count, and time is unavailable only when no execution in scope is readable. A server stamp makes an execution's timestamps authoritative, so any regression is treated as a defect. Without one, a terminal timestamp that precedes its own segment is closed at the latest durable model attempt recorded inside that segment rather than inventing a duration from unrelated evidence. Parallel intervals are unioned within a Turn fold rather than multiplied.

Corrupt or outdated projections are recovered by versioned refold, not by repair passes. A root refold replaces only the root source. After that commit, recovery inspects the known title execution without starting it and, when present and terminal, exactly replays it into the title source. A missing title execution is valid; a nonterminal or contradictory title source fails loudly.

Thread deletion cascades through the local usage projection. It does not purge Relay execution records.
