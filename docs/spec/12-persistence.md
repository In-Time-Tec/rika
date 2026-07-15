# Effect SQL Product Persistence

## Scope

Rika uses Effect SQL SQLite for product-owned state such as Thread metadata, Workspace records, configuration projections, extension trust, artifacts, and TUI preferences.

Relay owns its execution persistence through its published embedded runtime contract.

Rika and Relay use fixed `rika.db` and `relay.db` files in one canonical Profile data root. Independent database paths are rejected before listener probing or database open because one shared file across two roots cannot be safely fenced by one listener. One Resident Rika Service owns both files and constructs one process-lifetime Relay runtime graph over one shared Relay SQLite client. The service binds its loopback listener before opening or migrating either database and holds that listener until runtime fibers have terminated and Relay and product SQLite have closed. Modes and model tuning are execution data inside that runtime, never reasons to construct another database layer. Concurrent stateful starters attach to the winner and never open either database.

Released Relay `0.3.1` exposes the execution paging used by transcript projection. Rika consumes it only through the public SDK and does not deep-import or reproduce Relay internals. Legacy PID-directory and database-lock records are not ownership. During upgrade they may produce diagnostics, but only an authenticated compatible service on the derived listener may be attached to; an incompatible listener fails closed without opening state.

Profile identity is the normalized configured profile name plus the canonical data-root path after platform path normalization and symlink resolution. Workspace paths do not select a service: many Workspaces may share one Profile service. The endpoint name and handshake identity are a collision-resistant digest of the profile identity, never raw path text. The service returns the same identity in its authenticated handshake, and a mismatch is a hard failure. Distinct canonical data roots have distinct listeners, tokens, product databases, Relay databases, and runtime graphs.

The service authentication token is generated with OS cryptographic randomness, stored in a service-owned credential file readable and writable only by the owner account, and never accepted from CLI flags, logs, process listings, protocol errors, or product SQLite. Clients read it only after command parsing identifies a stateful path. Token creation uses atomic owner-only file creation; unsafe permissions, wrong ownership, symlinks, malformed content, or replacement during startup fail closed. Authentication compares the complete token before any request, subscription, identity detail, or state is exposed. Local loopback location is not authentication.

The initial product schema stores canonical Workspace paths and Thread metadata. A Thread row contains its stable Relay Session identifier before any Turn begins. Thread and Session identifiers are allocated by the product service and passed into repositories so tests remain deterministic.

Thread metadata operations are create, get, list, search, rename, replace labels, pin, archive, unarchive, and delete. Metadata listing is ordered by pinned state, most recent metadata update, then identifier. Search matches title, workspace path, and labels. Repository list limits are clamped to one through one hundred.

The product schema also stores one replaceable activity aggregate per Turn and one read timestamp per Thread. The activity row records its projected Relay cursor, whether terminal replay is complete, edit totals, and last event time. Counts are nonnegative and both rows cascade with their owning product record. Thread Summary queries combine these rows with Turn status without copying execution truth into Thread metadata. New Turns receive an incomplete zero aggregate. Relay results replace the aggregate rather than incrementing it, so repeated replay is idempotent.

Resident startup repairs missing, incomplete, and cursor-stale aggregates from Relay in batches of 25 with concurrency four. Repair does not delay the initial Thread list. A summary omits unknown edit totals until repair succeeds, publishes a replacement after each committed batch, and retries typed failures on the next startup. The migration is additive and does not mutate Relay state or Thread identifiers.

The product schema also stores a derived transcript read model. Transcript units belong to a Thread and Turn and have a stable semantic key, revision, chronological ordering key, and Schema-encoded content. A per-Turn checkpoint stores the projection version, drafts, cost, optional oldest Relay source cursor, and newest checkpoint cursor. Forward source pages are capped at two hundred events; each page upserts only units changed by that page and advances the checkpoint in the same transaction. The read model is disposable and rebuildable from Relay; it is not a second execution authority.

Transcript repositories expose only keyset pages. A backward page returns chronological entries, `hasOlder`, and its oldest and newest keys. Its full ordering tuple is one indexed SQLite row-value range, so later pages seek from their cursor instead of rescanning the Thread prefix. Limits default to fifty and clamp to two hundred. Turn listing used for transcript construction follows the same bounded keyset rule. No normal TUI path reads every Turn or every projected entry into memory.

## Rules

- Raw SQLite clients remain inside persistence composition.
- Repositories are Effect services with tagged errors and test layers.
- Rows are decoded to domain values through Effect Schema.
- Constraints enforce uniqueness and references.
- Migrations move forward and ship with the packaged binary.
- Transcript entry upsert and checkpoint advance share one transaction.
- Transcript rebuild removes units from an outdated projection before its first bounded append, writes the new projection version before making it visible, and can resume after interruption.
- Transaction boundaries follow product invariants.
- Rika does not import raw Drizzle APIs.
- An ambiguous storage failure after Relay acceptance remains reconcilable and does not create a terminal Turn without canonical Relay terminal state.
- Existing Turns migrated without an execution route pin remain readable, but a nonterminal unpinned Turn fails reconciliation before Relay start instead of inheriting current settings.
- A Review fan-out parent stores its deterministic fan-out identity and remains nonterminal as the durable owner of the workspace and route needed by resumed children. Reconciliation never treats that owner as an executable Turn; a missing fan-out is a terminal failed owner.
- Clean startup, repeated startup, interrupted migration, and N-1 to N upgrade are tested against packaged migration assets.
- CLI help, version, completions, and parse errors do not open the product database.
- Every command that reads or writes product SQLite runs through the Resident Rika Service. There is no local product-database fallback.
