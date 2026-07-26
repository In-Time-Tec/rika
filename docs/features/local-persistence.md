# Local persistence

The Profile's canonical data root contains `rika.db` for Rika product state, `relay.db` for Relay execution state, and the `relay-event-history` directory that Relay archives execution events into. The Resident Rika Service is their only runtime owner; stateful clients never open either database directly or fall back to a private copy.

Rika writes Threads, Turns, Pending Turns, projection checkpoints, semantic transcript units, summary activity, and read state through Effect SQL transactions. Relay remains authoritative for execution even when `rika.db` has stale disposable read state. Database open or migration failure prevents the resident from becoming ready rather than serving partial state.

Event history is always on and has no setting. Rika derives the history directory from the `relay.db` path it opens, so one data root always resolves to one history directory; a Profile backed by an in-memory database stays SQL-only because Relay rejects filesystem history without a persistent database file. Relay creates and binds the directory on first start.

`relay.db` and `relay-event-history` are bound to one durable store identity recorded in both. **They must be backed up, restored, and moved as a pair.** A `relay.db` opened against a different history directory fails at startup instead of rebinding, and a history directory without its database cannot be read back. Archiving does not shrink `relay.db`: the indexed event rows stay, and the compressed history blocks are written alongside them.
