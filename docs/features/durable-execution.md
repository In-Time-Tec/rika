# Durable Execution mapping

Every Turn maps deterministically to one top-level Baton Execution, and every Thread maps to one stable Baton Session. Baton owns execution events, waits, children, cancellation, replay, and terminal state; Rika stores the product records and disposable read projections that refer to them.

Baton `runId` and `childRunId` values are opaque execution IDs. Rika does not add namespace prefixes or recover parentage from their text. Baton persists each child invocation correlation in `ChildLinked`; projected child events carry the returned child Run ID and invocation ID, and every later inspect, replay, follow, cancel, or approval operation addresses that Run ID directly.

The Turn's resolved route and Workspace are supplied to exact root admission. Rika constructs one pinned executable and a complete immutable, secret-free registration set for that Turn, then calls Baton `Runtime.start`; duplicate admission returns the same opaque Run link, while changed admission under the same Turn fails. Baton persists the manifest and registration catalog atomically, so an admitted Execution restarts without reading Product rows, startup route maps, current configuration, the current directory, or fallback routes. Registration payloads contain provider connection and credential references, never resolved credential values; Rika's resolver dereferences those references through application credential services when reconstructing scoped execution resources.

Rika treats the Baton and Effect versions pinned in the root package catalog as one runtime compatibility unit. They are installed and upgraded together so durable values never cross between different Effect runtime identities.
