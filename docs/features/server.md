# Rika Server

One Rika Server owns each canonical Profile and data root. The Server process binds the Profile's authenticated loopback listener before opening `rika.db` and the current execution database, then owns product SQLite, one Baton runtime graph, model registration, admission, reconciliation, and runtime fibers.

Stateful CLI and terminal clients attach to that owner. They never open a fallback database or create a second execution graph when the server is unavailable, incompatible, or still starting.
