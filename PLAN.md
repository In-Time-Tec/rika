# PLAN: First-class OpenRouter support — provider layer + `rika auth login openrouter`

## Goal

Ship OpenRouter as a first-class model provider:

1. A real OpenRouter model layer in Baton's providers built on Effect's
   `@effect/ai-openrouter` (chat-completions wire format).
2. A `rika auth login openrouter` command that accepts a pasted API key,
   validates it, and stores it in the hardened local credential store.
3. Model aliases, modes, agents, title, and compaction routes keep working
   unchanged — only `provider: "openrouter"` changes on aliases.

## Why (evidence)

Every second message against OpenRouter fails with
`invalid_prompt` on `POST /api/v1/responses`, any model, 100% reproducible.

Root cause chain, fully verified:

1. Rika routes through Baton's OpenAI provider (`@batonfx/providers` →
   `@effect/ai-openai`), which uses the OpenAI **Responses API**.
2. On turn 2 the assistant history is rebuilt by Effect's
   `Prompt.fromResponseParts`, which drops `metadata.openai.itemId`, so the
   replayed assistant part has no item id.
3. `@effect/ai-openai` `prepareMessages` then emits the assistant message item
   with `"id": null` (`id: id!` where `getItemId` returned `null`).
4. OpenRouter's `/responses` schema requires `id` to be a string and rejects
   `null` with `invalid_prompt`.

Verified by capturing Rika's real turn-2 request body through a local proxy and
bisecting against OpenRouter: the exact captured item fails; the same item
without the `id` field passes; a string id passes. OpenAI's own API tolerates
`id: null`, which is why this only shows on OpenRouter.

Decision: do not locally patch the Responses path. Ship the OpenRouter chat-
completions layer, which structurally never emits Responses item ids, plus the
paste-and-store auth command. (Upstream follow-up, not required for this plan:
fix `@effect/ai-openai` to omit null ids and make `Prompt.fromResponseParts`
carry item ids, so every OpenAI-compatible gateway is safe.)

Verified today: `@effect/ai-openrouter@4.0.0-beta.98` exists in the tree
(chat completions + SSE streaming + reasoning metadata, default base URL
`https://openrouter.ai/api/v1`, bearer auth); chat completions with
`reasoning: { effort, summary }` works against `~deepseek/deepseek-v4-flash-latest`;
`GET /api/v1/key` validates a pasted key and returns limits.

## Design

### 1. Baton — new OpenRouter provider (`@batonfx/providers`, upstream repo)

Mirror the existing `OpenAi` provider module:

- `protocol: "openrouter"` connection type; default `baseUrl`
  `https://openrouter.ai/api/v1`, default `apiKeyEnv` `OPENROUTER_API_KEY`.
- `OpenRouter.layer` / registration built on `@effect/ai-openrouter`:
  `OpenRouterLanguageModel.layer` plus `OpenRouterClient` from the connection
  (apiUrl, apiKey, optional `HTTP-Referer` / `X-Title` connection fields),
  failure classification mapping OpenRouter codes into `AiError` categories
  (`invalid_prompt`, quota, rate-limit, auth, …), and OpenAI tool schema
  compilation.
- `decodeConfig` for provider options: reasoning effort/summary and whatever
  else the OpenRouter config schema accepts.

### 2. Rika configuration (`packages/configuration`)

- `ModelRoute.ProviderId` and `HttpProviderConnection.protocol` gain
  `"openrouter"`.
- `providerDefaults.openrouter` = `{ protocol: "openrouter", baseUrl:
"https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }`.
- Decoder: `providers` key set and per-provider fields unchanged
  (`baseUrl`, `apiKeyEnv`, `streamingOnly`, `promptCaching`) plus new optional
  `credential` (name of a stored credential; see below).
- Presets: add `"openrouter"` to the `openai` preset's `protocols` so
  `preset: "openai"` aliases are valid on the openrouter provider (reasoning
  options allowed).
- Aliases: `provider: "openrouter"`, `candidates` = OpenRouter model ids
  (`~deepseek/deepseek-v4-flash-latest`, `poolside/laguna-xs-2.1:free`, …).
  `modelRoutes` (modes/agents/title/compaction) unchanged — everything keeps
  resolving through aliases.

### 3. Credential storage

- Generalize the existing hardened OpenAI credential store
  (`apps/rika/src/provider/openai/openai-credential-store.ts`: 0600 file mode,
  owner and link checks, lock file, max size, trusted root) into a
  schema-parameterized shared store; keep `openai.json` where it is, add
  `<data>/auth/<profile>/openrouter.json`.
- Resolution precedence in `liveConfigurationLayer`: a connection's named
  stored credential → its `apiKeyEnv` env var → empty. Presence markers only in
  `rika config list` output; never print values.

### 4. `rika auth login openrouter` (CLI + product service)

- Extend `apps/rika/src/command/product/auth-command.ts` provider choice to
  `["openai", "openrouter"]`.
- New `packages/product/src/authentication/openrouter-auth-service.ts`
  mirroring `openai-auth-service` (Service + Store + Host):
  - `login`: masked stdin prompt for the key (host adapter; optional
    `--api-key` flag for scripting) → validate with
    `GET https://openrouter.ai/api/v1/key` → save to the store.
  - `status`: stored-present + optional remote validity check.
  - `logout`: remove; corrupted-store handling like the OpenAI flow.
- `authentication-operation-dispatch` gains the openrouter branch (no
  "assertOpenAiDirect" gate — OpenRouter works in any workspace).

### 5. baton-execution wiring

- `candidateRegistryLayer` gains `case "openrouter"` → the Baton
  `OpenRouter.layer` with `providerHttpClientLayer`, same registration
  identity flow. Nothing else changes.

## Tests

- configuration: decoder accepts the openrouter provider key + `credential`
  field; merge defaults/overrides; resolution proves every mode role, agent,
  title, and compaction route resolves on provider openrouter aliases.
- baton-execution: HTTP capture test (pattern of
  `baton-provider-http.test.ts`) drives a two-turn agent call and asserts the
  second request is `POST /chat/completions` with full message history and no
  item ids — the regression test for this bug; scripted-model two-turn test.
- product: openrouter auth service — store round-trip, `/key` validation
  against a mock HTTP layer, corrupted store, logout.
- apps/rika: auth command tests — login stores and reports, status, logout.
- Manual acceptance with pilotty: two-message conversation against real
  OpenRouter; `rika auth login openrouter` then `rika config list` shows only
  a presence marker.

## Docs

- `docs/features/provider-configuration.md`: openrouter connection,
  `credential` vs `apiKeyEnv`, alias example.
- `docs/features/configuration.md`: provider credentials via `rika auth` and
  env fallback.
- `CONTEXT.md` vocabulary only if a new term (credential store) needs one.

## Sequencing

1. Upstream (optional): Effect null-id fix for OpenAI-compatible gateways.
2. Baton: add `@effect/ai-openrouter` dependency (catalog), ship the
   `OpenRouter` provider, release.
3. Rika: configuration model → baton-execution wiring → credential store +
   auth service + CLI → server composition → tests → docs.

## Acceptance

- Second and later messages succeed against OpenRouter with any alias; all
  modes/agents/title/compaction routes resolve.
- `rika auth login openrouter` stores a validated key; `status` reports it;
  `logout` removes it; no key value appears in `config list` or diagnostics.
- Existing aliases/routes keep their shape; only `provider` changes.
- `bun run check` green.
