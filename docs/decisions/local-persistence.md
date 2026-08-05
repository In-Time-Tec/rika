# Local persistence

Rika-owned state uses Effect SQL with Bun SQLite. One Rika Server owns the product and Baton databases for a Profile because independent clients and runtime graphs against the same files do not share serialization or notifications.
