# Modes and model routing

## Contract

Rika settings contain named `gateways`, `models`, and `modes`. A Gateway has an explicit `openai` Responses or `anthropic` Messages protocol, a `baseUrl`, and an explicit authentication mode. VibeProxy uses one Gateway of each protocol. Runtime behavior never depends on the Gateway name or endpoint. Authentication is either `none` or `bearer-env` with a required environment-variable name. The configuration boundary resolves each distinct named variable once into a redacted credential map, and each model registration receives only its Gateway's credential. Defaults name `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; both VibeProxy Gateways may name `RIKA_MODEL_API_KEY`.

Each model alias owns ordered upstream candidate IDs, exact operational compaction, and request variants keyed by effort. Every effort variant has `normal` options and may have `fast` options. GPT aliases expose normal and fast variants; fast options explicitly include `service_tier: priority`. Claude aliases expose normal variants only, so a fast Claude route is rejected. Supported efforts are `low`, `medium`, `high`, `xhigh`, and `max`.

Each mode has a budget and complete `main` and `oracle` routes. A route selects an alias, effort, and optional fast variant.

| Mode   | Main                    | Oracle                |
| ------ | ----------------------- | --------------------- |
| low    | `gpt-5.6-luna`, low     | `gpt-5.6-sol`, high   |
| medium | `gpt-5.6-terra`, medium | `gpt-5.6-sol`, high   |
| high   | `gpt-5.6-sol`, xhigh    | `claude-fable-5`, max |
| ultra  | `claude-fable-5`, max   | `gpt-5.6-sol`, max    |

Fable declares candidates `claude-fable-5` then `claude-opus-4-8`; Opus is also separately configurable. Baton 0.4.3 does not expose a candidate fallback policy constrained to availability failures before output, so Rika does not fake automatic fallback. Startup and doctor route resolution must report missing Gateways, aliases, and variants explicitly.

## Runtime invariants

- Registration keys are non-secret SHA-256 identities over protocol, normalized base URL, authentication mode and credential name, provider model ID, effort, fast selection, and canonical provider options. Registration deduplication uses Baton's exact `(Gateway name, provider model ID, registration key)` tuple.
- Every main and Oracle route is resolved and registered before execution.
- Every Relay execution start pins the exact immutable revision returned by its immediately preceding agent registration.
- Root execution uses main. Oracle presets and Oracle fan-out members use Oracle. Librarian, Painter, Review, ReadThread, and Task remain on main.
- Deterministic TestModel configuration remains a fixed selection for every role.
- Automatic titling reuses the initiating Turn route.
- Old `providers`, model `provider`/`model`, and mode `model`/`oracleModel`/`reasoning` shapes are rejected.
