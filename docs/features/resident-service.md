# Resident service ownership

One Resident Rika Service owns each canonical Profile and data root. It binds the Profile's authenticated loopback listener before opening `rika.db` and the current execution database, then owns product SQLite, one Relay runtime graph, model registration, admission, reconciliation, and runtime fibers.

Stateful CLI and terminal clients attach to that owner. They never open a fallback database or create a second execution graph when the resident is unavailable, incompatible, or still starting.
