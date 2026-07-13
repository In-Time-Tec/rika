# Context, skills, and compaction

## Resolved Context

Rika deterministically resolves parent and subtree guidance, global guidance, file mentions, thread references, images, skills, and memory before model execution. Untrusted content remains data rather than policy.

## Guidance

Supported files include `AGENTS.md` with `AGENT.md` and `CLAUDE.md` fallbacks. Referenced files and globs are resolved with explicit precedence, bounded depth and cardinality inside the Workspace, and recorded for diagnosis. Typed `@file:`, `@guidance:`, `@thread:`, and `@image:` mentions add files, reference globs, local thread transcripts, and image files to execution context without granting policy authority to their contents.

The TUI may materialize an untyped `@` file completion as Workspace-relative prompt text. This completion changes only composer text: submission and execution continue through the same durable prompt-parts and Resolved Context resolution boundaries.

Rika owns this resolution behavior. Baton receives already-resolved instruction and skill sources; the published Baton skills package does not define all Rika fallback, reference, and glob semantics.

## Skills

Skill listings are compact startup context. Skill bodies and resources load lazily through Baton skill activation. Skill-bundled MCP tools remain hidden until activation.

## Compaction

Every model alias owns explicit `contextWindow`, `reserveTokens`, and `keepRecentTokens` values. GPT operational limits are 372,000, 128,000, and 32,000 tokens. Claude, Fable, and Opus limits are 1,000,000, 128,000, and 64,000 tokens. Reserve plus recent tokens must remain below the context window.

Root execution compaction follows the selected main route. Oracle presets, fan-out overrides, and accepted snapshots carry the selected Oracle route policy; ordinary children carry main. Baton owns compaction decisions and summaries; Relay execution events remain the durable checkpoint authority. Prompt compaction never deletes the durable transcript or Workspace files.

Semantic thread memory may be specified separately from code search. The excluded semantic-search feature is a model-visible code-search tool and code embedding index, not an automatic ban on future thread-memory implementations.
