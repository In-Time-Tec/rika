# Local persistence

The Profile's canonical data root contains `rika.db` for Rika product state and `baton.db` for Baton execution state. The Rika Server is their only runtime owner; stateful clients never open either database directly or fall back to a private copy. `RIKA_DATABASE` may move the product database and determines the canonical data root, while `RIKA_BATON_DATABASE` may move the Baton database independently.

Rika writes Threads, Turns, Pending Turns, projection checkpoints, semantic transcript units, summary activity, and read state through Effect SQL transactions. Baton writes canonical execution events and state through its own SQLite Runtime. Both stores initialize one current schema into an empty database; historical database upgrades are unsupported during greenfield development, so an incompatible database must be deleted and recreated. Database open or schema initialization failure prevents the server from becoming ready rather than serving partial state.

The Baton execution database is a self-contained SQLite store containing exact executable manifests and their immutable resolver registrations. Back up, restore, or move `baton.db` as one file; Rika does not maintain a parallel event-history directory, scan Product Turns to rebuild execution routes, or read Baton's tables directly.
