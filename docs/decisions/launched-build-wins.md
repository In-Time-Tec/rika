# Launched build wins

When a launching client and the running Server carry different build identities, the build the user just launched supersedes the Server after authenticated negotiation. Replacement closes mutation admission, drains already-admitted transient requests, and transfers sole ownership to the launched build. A durable running Execution does not veto this transfer; the replacement runtime recovers it from TenetKit. Existing interactive clients keep their stable interface callback, reconnect through the one current transport contract, restore their selection, and resume reads from durable state.

Supersession is a property of the launch, not of every build mismatch. Allowing reconnecting clients to replace the Server creates a kill war between sessions. Side-by-side Servers are rejected because one Server is the single execution and persistence owner for a Profile and data root; two builds cannot share `rika.db` and the current execution store.

A reattach never initiates supersession. The authenticated connection role distinguishes a launch from physical recovery beneath a stable interactive callback. Build identity chooses the Server owner for a launch; it does not prevent an authenticated existing client from reattaching to that owner.
