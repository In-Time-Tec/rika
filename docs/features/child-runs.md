# Child Runs

A Child Run is a durable child Execution with narrowed instructions and capabilities. Each child has a deterministic identity, isolated durable Session, pinned profile, route, static capabilities, and output contract; conversational children also carry a compaction policy. Internal title children are fixed to Luna/low and carry no tools, delegation, or compaction.

Model-facing child tools select only children declared by the active parent manifest. Root may select Title, Oracle, Librarian, Painter, ReadThread, Surgeon, or Task. Task may select Oracle, Librarian, Painter, ReadThread, or Surgeon and cannot select Task recursively; all other children are leaves. Tool-call identity owns idempotent admission, suspension, and join, and cancellation is durable across the exact child closure.
