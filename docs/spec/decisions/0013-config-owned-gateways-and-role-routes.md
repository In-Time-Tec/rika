# ADR 0013: Config-owned gateways and role routes

## Status

Accepted

## Context

Provider names and endpoint presence previously selected runtime behavior, models did not own exact request variants, and `oracleModel` did not reach Oracle child execution. This made VibeProxy special, allowed old configuration to remain accidentally valid, and made mode routing incomplete.

Baton 0.4.3 registers exact model selections and measures the currently assembled prompt for proactive compaction, but exposes no candidate chain whose fallback is limited to availability failures before output. Relay 0.2.13 carries typed compaction policies on root definitions, child presets, and fan-out overrides, and assigns every direct and model-initiated child execution an isolated durable Session.

## Decision

Configuration owns named Gateways with an explicit `openai` Responses or `anthropic` Messages protocol and explicit `none` or `bearer-env` authentication. Bearer authentication names its environment variable. The application resolves distinct variables once into redacted values keyed by variable name and passes each registration only the credential named by its Gateway. VibeProxy uses both protocols at the same base URL and may name `RIKA_MODEL_API_KEY` for both. Environment values remain the only secret boundary. Runtime dispatch uses the protocol discriminant only.

Models own ordered candidate IDs, operational compaction, and explicitly configured normal and optional fast variants keyed by effort. Modes own complete main and Oracle routes. Registration keys are content-addressed over protocol, normalized endpoint, authentication mode and credential name, model, variant, and canonical options; secret values never enter identity or logs. Root execution and non-Oracle children use main; the Oracle preset and Oracle fan-out children use Oracle.

Each fan-out member uses a deterministic child-specific Relay agent definition materialized from its persisted override. This preserves the selected model, request variant, compaction policy, narrowed tools and permissions, output schema, and metadata without racing the shared root definition.

No legacy decoder, provider-name branch, endpoint inference, or old mode keys remain.

Fable declares `claude-fable-5` followed by `claude-opus-4-8`, and Opus is also a separately configured alias. Rika does not automatically fail over because the published Baton API cannot constrain candidate fallback to availability failures before output. Startup rejects unresolved routes and unavailable variants rather than silently changing models.

Root compaction follows main. Oracle child presets and fan-out overrides carry Oracle compaction, and Relay pins the resolved model and policy in each accepted child snapshot. Every root and native fan-out start uses the exact immutable revision returned by its registration call.

## Consequences

Any service implementing the configured OpenAI Responses or Anthropic Messages protocol behaves identically from configuration. Fast Claude routes are invalid. Candidate fallback remains an explicit upstream limitation rather than simulated behavior.
