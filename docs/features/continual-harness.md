# Continual harness

A Thread accumulates its own capability as four kinds of harness entry: memories, skills, subagent specs, and prompt notes. Each entry carries a bounded title and content and may add a path, reference, arguments, metadata, and source. A cell reads and refines them through `rika.harness`.

Entries live in three scopes. `thread:<id>` is the ambient Thread and is stored under the Profile data root. `workspace:<digest>` is the Workspace and is stored in the Workspace configuration directory. `global` is stored in the global configuration directory. One scope is one owner-only JSON file whose name is the encoded scope string. A cell names a scope but never chooses which Thread or which Workspace: those identities are ambient.

Reads without a scope return the merged state, overlaid outer to inner as global, then workspace, then thread, so a Thread entry shadows a Workspace entry of the same identity and a Workspace entry shadows a global one. `snapshot` returns the state and `overview` returns its bounded formatted summary.

`createMemory`, `createSkill`, `createSubagent`, `createPromptNote`, and their update and delete forms each apply one edit. `recordRefinement` applies up to sixty-four edits with a rationale, and `rollback` reverses a recorded refinement by its identifier. Every mutation requires `baseSnapshot`, the snapshot id the caller read: because the store offers only load and save, a stale baseline becomes an observable `baseline-drift` rejection instead of a silently lost update. Cell input is authored through Baton's authorship check, so a caller that pins its own revision or supplies an excess property is rejected rather than forging `createdAt`, `updatedAt`, or `version`.

An Execution pins one exact harness state as a manifest capability and registration. A refinement applied during a Turn produces a new snapshot id that only the following Execution admits, so a running model's system prompt is never rewritten, and a reconstruction that decodes a different state fails with a snapshot mismatch rather than drifting.

The pinned state reaches the model as supplemental prompt sections appended after the immutable base prompt: the bounded harness overview, the skill listings, and the reachable MCP server names. Harness entries extend what the model knows; they never displace Rika's own instructions.
