# Effect SQL Product Persistence

## Scope

Rika uses Effect SQL SQLite for product-owned state such as Thread metadata, Workspace records, configuration projections, extension trust, artifacts, and TUI preferences.

Relay owns its execution persistence through its published embedded runtime contract.

Rika and Relay use separate SQLite files unless a future published Relay contract explicitly supports shared transactional composition. Relay SQLite has one live owner and one process-lifetime runtime graph over one shared SQLite client. Ownership is acquired before Relay migration or runtime acquisition and released after all runtime users and finalizers terminate. Modes and model tuning are execution data inside that runtime, never reasons to construct another database layer. A second execution-capable process fails before opening the Relay database.

Released Relay `0.2.13` does not expose one public composition that shares a SQLite client across its runner, Child Run fan-out host, and Workflow host. The required upstream package contract and Rika adoption are a release gate; Rika does not deep-import or reproduce Relay internals to bypass it. Cooperative ownership cannot fence an already-running legacy binary, so an upgrade must stop or detect legacy owners before opening existing Relay state.

The initial product schema stores canonical Workspace paths and Thread metadata. A Thread row contains its stable Relay Session identifier before any Turn begins. Thread and Session identifiers are allocated by the product service and passed into repositories so tests remain deterministic.

Thread metadata operations are create, get, list, search, rename, replace labels, pin, archive, unarchive, and delete. Listing is ordered by pinned state, most recent update, then identifier. Search matches title, workspace path, and labels. Repository list limits are clamped to one through one hundred.

## Rules

- Raw SQLite clients remain inside persistence composition.
- Repositories are Effect services with tagged errors and test layers.
- Rows are decoded to domain values through Effect Schema.
- Constraints enforce uniqueness and references.
- Migrations move forward and ship with the packaged binary.
- Transaction boundaries follow product invariants.
- Rika does not import raw Drizzle APIs.
- An ambiguous storage failure after Relay acceptance remains reconcilable and does not create a terminal Turn without canonical Relay terminal state.
- Clean startup, repeated startup, interrupted migration, and N-1 to N upgrade are tested against packaged migration assets.
- CLI help, version, completions, and parse errors do not open the product database.
