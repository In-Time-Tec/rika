# Continual harness

A Thread can carry versioned memories, skills, subagent specs, and prompt notes. Entries can be scoped to a Thread, Workspace, or global profile and are merged from global to Workspace to Thread, with the narrower scope winning an identity collision.

Rika pins one exact harness snapshot in the Generalist executable manifest. The pinned overview and skill guidance are appended after Rika's immutable base instructions, so harness content can extend what the model knows without replacing the native tool contract. A changed snapshot is admitted by a later Execution; it never rewrites the system prompt of a Run already in progress.

The four native model tools do not expose harness mutation calls. Generalist remains authoritative for its own durable Runs, harness state, and refinement behavior; Rika only supplies the pinned supplemental snapshot used by the configured Execution.
