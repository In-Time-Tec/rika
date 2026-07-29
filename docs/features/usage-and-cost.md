# Usage and cost

Rika maintains a durable, revisioned usage projection for every admitted non-queued Turn. Normal startup, Thread selection, and `rika threads usage <thread-id>` read this projection without inspecting or replaying Relay execution history. Archived Threads remain part of the global total. An empty projection is unavailable rather than a complete zero.

The resident product operation owns one usage writer for root, followed child, grandchild, and title usage, attempt, wait, and execution lifecycle evidence. Deliveries accumulate and commit on a bounded window, so a running Turn commits repeatedly instead of once at the end. Each execution-scoped Relay delivery cursor is folded once, so re-delivered history changes nothing. Compare-and-swap retries make concurrent and duplicate delivery idempotent.

Displayed cost, tokens, and time come only from committed aggregates. Every usage notification carries the Thread revision it was read at, and clients drop notifications older than the revision they already hold. Interactive sessions never total unpersisted deliveries and never own a second writer.

Each Turn row stores the compact fold needed to recompute attempts and active time. It also materializes nano-USD, tokens, active milliseconds, priced and unpriced attempts, counted and uncounted attempts, projection version, and source completeness. A Thread or global metric sums the Turns that have it and is unavailable only when no included Turn has it.

A provider-reported USD amount is authoritative for its model attempt. Otherwise Rika estimates cost from the bundled models.dev snapshot. Unknown prices, malformed usage, conflicting corrections, and settled attempts without usage remain explicitly unpriced or uncounted. Total tokens are input plus output; cache buckets partition input and reasoning belongs to output.

Active time is measured per execution from durable Relay lifecycle timestamps: a start or wake opens an interval and a wait or terminal event closes it. An execution whose lifecycle is incomplete or contradictory contributes nothing and is recorded as absent; the other executions still count, and time is unavailable only when no execution in scope is readable. A server stamp makes an execution's timestamps authoritative, so any regression is treated as a defect. Without one, a terminal timestamp that precedes its own segment is closed at the latest durable model attempt recorded inside that segment rather than inventing a duration from unrelated evidence. Parallel intervals are unioned within a Turn fold rather than multiplied.

Corrupt or outdated projections are recovered by versioned refold, not by repair passes.

Thread deletion cascades through the local usage projection. It does not purge Relay execution records.
