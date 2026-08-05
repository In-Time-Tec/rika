# Launched build wins

When a launching client and the running Server carry different build identities, the build the user just launched supersedes the Server after authenticated negotiation. Existing clients from another build reconnect and resync their selected Thread within the same interactive runtime when both builds share the wire compatibility epoch. An authenticated epoch mismatch exits with a restart signal so the CLI parent can respawn the runtime from the build on disk.

Supersession is a property of the launch, not of incompatibility. Before this rule, every client that saw an incompatible server tried to replace it, so an upgrade with two live sessions became a kill war that ended in failed clients. Version-namespaced side-by-side servers were rejected because one server is the single execution and persistence owner for a Profile and data root; two versions cannot share `rika.db` and the current execution store.

A reattach never initiates supersession. The authenticated connection role distinguishes a launch from physical recovery beneath a stable interactive callback.
