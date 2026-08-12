# Child Runs

A Child Run is a durable child Execution with narrowed instructions and capabilities. Each child has a deterministic identity, isolated durable Session, pinned profile, route, static capabilities, and output contract; conversational children also carry a compaction policy.

A parent selects only children declared by its active manifest. Root declares Oracle, Librarian, Painter, ReadThread, Review, Surgeon, and Task. Recursively capable children may delegate again until the execution's pinned depth policy is exhausted. The ambient operation identity plus a caller key owns idempotent admission, and cancellation is durable across the exact child closure.

The settings `subagents.maxDepth` and `subagents.maxSubagents` are pinned when a root Execution is admitted. Root is depth zero: a maximum depth of zero permits no children, one permits root children, and two permits grandchildren. The subagent limit is per-parent active direct-child capacity, not a lifetime or tree-wide pool. A group is admitted once in full; members beyond the available capacity wait durably and are promoted in order as siblings settle. Each recursively capable child receives the same independent capacity. Admission and replay are atomic and durable, and an exact repeated admission returns its original group without duplicating children or queue entries.
