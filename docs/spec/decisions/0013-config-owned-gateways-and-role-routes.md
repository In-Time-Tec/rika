# ADR 0013: Config-owned gateways and role routes

## Status

Accepted

## Context

Provider names and endpoint presence previously selected runtime behavior, models did not own exact request variants, and `oracleModel` did not reach Oracle child execution. This made VibeProxy special, allowed old configuration to remain accidentally valid, and made mode routing incomplete.

Baton 0.4.2 registers exact model selections but exposes no candidate chain whose fallback is limited to availability failures before output. Relay 0.2.11 child presets can carry a model selection, but its public compaction metadata belongs to the registered root agent rather than each child preset.

## Decision

Configuration owns named Gateways with an explicit `openai` Responses or `anthropic` Messages protocol and explicit `none` or `bearer-env` authentication. Bearer authentication names its environment variable. The application resolves distinct variables once into redacted values keyed by variable name and passes each registration only the credential named by its Gateway. VibeProxy uses both protocols at the same base URL and may name `RIKA_MODEL_API_KEY` for both. Environment values remain the only secret boundary. Runtime dispatch uses the protocol discriminant only.

Models own ordered candidate IDs, operational compaction, and explicitly configured normal and optional fast variants keyed by effort. Modes own complete main and Oracle routes. Registration keys include alias and variant. Root execution and non-Oracle children use main; the Oracle preset and Oracle fan-out children use Oracle.

Each fan-out member uses a deterministic child-specific Relay agent definition materialized from its persisted override. This preserves the selected model and request variant, narrowed tools and permissions, output schema, and metadata without racing the shared root definition. Relay 0.2.11 has no child compaction override, so these definitions retain root compaction metadata.

No legacy decoder, provider-name branch, endpoint inference, or old mode keys remain.

Fable declares `claude-fable-5` followed by `claude-opus-4-8`, and Opus is also a separately configured alias. Rika does not automatically fail over because the published Baton API cannot constrain candidate fallback to availability failures before output. Startup rejects unresolved routes and unavailable variants rather than silently changing models.

Root compaction follows main. Oracle children currently inherit root compaction because Relay's public child preset contract cannot carry Baton compaction options.

## Consequences

Any service implementing the configured OpenAI Responses or Anthropic Messages protocol behaves identically from configuration. Fast Claude routes are invalid. Candidate fallback and role-specific child compaction remain explicit upstream limitations rather than simulated behavior.
