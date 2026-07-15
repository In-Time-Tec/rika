# Context, skills, and compaction

## Resolved Context

Rika deterministically resolves parent and subtree guidance, global guidance, file mentions, thread references, images, skills, and memory before model execution. Untrusted content remains data rather than policy.

## Guidance

Supported files include `AGENTS.md` with `AGENT.md` and `CLAUDE.md` fallbacks. Referenced files and globs are resolved with explicit precedence, bounded depth and cardinality inside the Workspace, and recorded for diagnosis. Typed `@file:`, `@guidance:`, and `@image:` mentions add files, reference globs, and image files to execution context without granting policy authority to their contents. A Thread reference is `@<thread-id>`. An untyped mention is a Thread reference only when it resolves to an existing product Thread; otherwise it follows file mention handling. The superseded `@thread:<thread-id>` form is not supported.

The TUI may materialize an untyped `@` file completion as Workspace-relative prompt text. This completion changes only composer text: submission and execution continue through the same durable prompt-parts and Resolved Context resolution boundaries.

Rika owns this resolution behavior. Baton receives already-resolved instruction and skill sources; the published Baton skills package does not define all Rika fallback, reference, and glob semantics.

## Skills

Skill listings are compact startup context. Skill bodies and resources load lazily through Baton skill activation. Skill-bundled MCP tools remain hidden until activation.

## Compaction

Every model alias owns explicit `maxInputTokens`, `maxOutputTokens`, and `keepRecentTokens` values. Rika derives Baton's context window as maximum input plus maximum output and reserves the maximum output. Recent tokens must remain below maximum input. Built-in GPT aliases use 922,000, 128,000, and 32,000 tokens. Claude, Fable, and Opus aliases use 872,000, 128,000, and 64,000 tokens.

Root execution compaction follows the selected main route. Oracle presets, fan-out overrides, and accepted snapshots carry the selected Oracle route policy; ordinary children carry main. Every policy names the immutable `compaction.summaryModel` selection from the Turn route pin. Baton keeps the recent tail verbatim and uses that no-tools language-model call to summarize the older prefix into a conversation checkpoint. Relay resolves the summary model only when it needs a new summary, persists the checkpoint and retained boundary, reuses it after restart without another model call, and remains the durable checkpoint authority. Legacy route pins without a summary selection use the active execution model. Prompt compaction never deletes the durable transcript or Workspace files.

Semantic thread memory may be specified separately from code search. The excluded semantic-search feature is a model-visible code-search tool and code embedding index, not an automatic ban on future thread-memory implementations.
