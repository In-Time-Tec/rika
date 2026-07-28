# Usage and cost

Rika maintains a durable, revisioned usage projection for every admitted non-queued Turn. Normal startup, Thread selection, and `rika threads usage <thread-id>` read this projection without inspecting or replaying Relay execution history. Archived Threads remain part of the global total. An empty projection is unavailable rather than a complete zero.

The resident product operation owns one usage writer for root, followed child, grandchild, and title usage, attempt, work, wait, and execution lifecycle evidence. Raw transcript events may stream before the SQLite write because Relay already stores them durably; aggregate usage notifications are published only after the projection commit. Each execution-scoped Relay delivery cursor is folded once. Compare-and-swap retries make concurrent and duplicate delivery idempotent. Interactive sessions consume persisted results and notifications; they do not own a second writer.

Each Turn row stores the complete compact fold needed to apply later corrections and recompute attempts and active time. It also materializes nano-USD, tokens, active milliseconds, priced and unpriced attempts, counted and uncounted attempts, projection version, and source completeness. A Thread or global metric is available only when every included Turn has that metric. Source completeness is true only when every included execution source is known to have been traversed completely.

A provider-reported USD amount is authoritative for its model attempt. Otherwise Rika estimates cost from the bundled models.dev snapshot. Unknown prices, malformed usage, conflicting corrections, and settled attempts without usage remain explicitly unpriced or uncounted. Total tokens are input plus output; cache buckets partition input and reasoning belongs to output.

Active time is derived from durable lifecycle and work evidence. It is unavailable when that evidence is missing or malformed. Parallel intervals are unioned within a Turn fold rather than multiplied.

Historical reconstruction is explicit. `rika migrate usage` claims terminal non-queued Turns, walks every page of their bounded Relay execution trees, rechecks each execution before marking its source complete, and commits through compare-and-swap. Completed Turns are skipped on later runs, so repair resumes at Turn boundaries. Claims expire after interruption so an unfinished Turn can be retried safely. Any incomplete, changing, or uncertain traversal leaves the row partial and never claims source completeness.

Thread deletion cascades through the local usage projection. It does not purge Relay execution records.
