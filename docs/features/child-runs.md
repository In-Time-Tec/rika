# Child Runs

A Child Run is a durable child Execution with narrowed instructions and capabilities. Each child has a deterministic identity, isolated durable Session, pinned profile, route, static capabilities, and output contract; conversational children also carry a compaction policy.

A parent selects only children declared by its active manifest. Root declares Oracle, Librarian, Painter, ReadThread, Review, Surgeon, and Task. Recursively capable children may delegate again until the execution's pinned depth policy is exhausted. The ambient operation identity plus a caller key owns idempotent admission, and cancellation is durable across the exact child closure.

The settings `subagents.maxDepth` and `subagents.maxSubagents` are pinned when a root Execution is admitted. Root is depth zero: a maximum depth of zero permits no children, one permits root children, and two permits grandchildren. The subagent limit is a lifetime branching factor, not a tree-wide pool: each parent may admit at most that many direct children, and each recursively capable child receives the same allowance. Admission and replay are atomic and durable; an exact repeated admission returns its original children without another charge, a group either admits every member or none, and terminal children do not refund slots.
