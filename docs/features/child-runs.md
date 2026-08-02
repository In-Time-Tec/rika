# Child Runs

A Child Run is a durable child Execution with narrowed instructions and capabilities. Each child has a deterministic identity, isolated durable Session, pinned profile, route, static capabilities, and output contract; conversational children also carry a compaction policy. Internal title children are fixed to Luna/low and carry no tools, delegation, or compaction.

Fan-out is bounded by an explicit concurrency limit and joins with `all`, `first-success`, `quorum`, or `best-effort`. Child failure is preserved in the join result, and cancellation is durable. Delegation is available only below depth two, so a child at the depth limit cannot create another Child Run, and the join tool is withdrawn with it. Delegated children are spawned with a parent join wait, so their terminal status wakes the parent whether or not it is already waiting.
