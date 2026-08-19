import { expect, it } from "@effect/vitest"
import * as Settings from "@rika/configuration/configuration-settings"
import type * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import { Effect } from "effect"
import { workspaceExecutionRoute } from "../src/server/composition/server-execution-route"

const routeFor = (
  settings: Settings.ConfigurationSettings,
  status: Effect.Effect<OpenAiAuthContract.Status, { readonly message: string }>,
  tuning?: { readonly fastMode?: boolean },
) =>
  workspaceExecutionRoute({
    testModel: undefined,
    effectiveConfigForWorkspace: () => Effect.succeed({ settings }),
    openAiAccountStatus: status,
  })("medium", tuning, "/workspace")

it.effect("selects the stored OpenAI account for each newly admitted native route", () =>
  Effect.gen(function* () {
    const route = yield* routeFor(
      Settings.Defaults.settingsDefaults,
      Effect.succeed({ _tag: "RefreshRequired", fingerprint: "stored-account-fingerprint" }),
    )
    expect(route.main.candidates[0]?.providerConnection).toEqual({
      provider: "openai",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authentication: "account",
      credentialIdentity: "stored-account-fingerprint",
    })
  }),
)

it.effect("reads the current account binding on each admission", () =>
  Effect.gen(function* () {
    let fingerprint = "first-account"
    const resolve = workspaceExecutionRoute({
      testModel: undefined,
      effectiveConfigForWorkspace: () => Effect.succeed({ settings: Settings.Defaults.settingsDefaults }),
      openAiAccountStatus: Effect.sync(() => ({ _tag: "Present" as const, fingerprint })),
    })
    const first = yield* resolve("medium", undefined, "/workspace")
    fingerprint = "second-account"
    const second = yield* resolve("medium", undefined, "/workspace")
    expect(first.main.candidates[0]?.providerConnection.credentialIdentity).toBe("first-account")
    expect(second.main.candidates[0]?.providerConnection.credentialIdentity).toBe("second-account")
    expect(second.main.registrationIdentity).not.toBe(first.main.registrationIdentity)
  }),
)

it.effect("rejects corrupt native account credentials before admission", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      routeFor(Settings.Defaults.settingsDefaults, Effect.succeed({ _tag: "Corrupt" })),
    )
    expect(failure).toMatchObject({
      _tag: "OperationError",
      message: expect.stringContaining("corrupt"),
    })
  }),
)

it.effect("fails before admission when native account credentials cannot be read", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      routeFor(Settings.Defaults.settingsDefaults, Effect.fail({ message: "credential store unavailable" })),
    )
    expect(failure).toMatchObject({
      _tag: "OperationError",
      message: expect.stringContaining("credential store unavailable"),
    })
  }),
)

it.effect("keeps API-key fallback when no OpenAI account is stored", () =>
  Effect.gen(function* () {
    const route = yield* routeFor(Settings.Defaults.settingsDefaults, Effect.succeed({ _tag: "Unauthenticated" }))
    expect(route.main.candidates[0]?.providerConnection).toMatchObject({
      authentication: "api-key",
      apiKeyEnvironment: "OPENAI_API_KEY",
    })
  }),
)

it.effect("uses fast only for routes that provide a fast variant", () =>
  Effect.gen(function* () {
    const settings: Settings.ConfigurationSettings = {
      ...Settings.Defaults.settingsDefaults,
      modes: {
        ...Settings.Defaults.settingsDefaults.modes,
        medium: {
          ...Settings.Defaults.settingsDefaults.modes.medium!,
          oracle: { alias: "fable", effort: "medium" },
        },
      },
    }
    const route = yield* routeFor(settings, Effect.succeed({ _tag: "Unauthenticated" }), { fastMode: true })
    expect(route.main.fast).toBe(true)
    expect(route.oracle.fast).toBe(false)
    expect(route.oracle.candidates[0]?.providerOptions).toMatchObject({
      output_config: { effort: "medium" },
    })
  }),
)

it.effect("does not read account credentials for a customized OpenAI endpoint", () =>
  Effect.gen(function* () {
    let reads = 0
    const settings: Settings.ConfigurationSettings = {
      ...Settings.Defaults.settingsDefaults,
      providers: {
        ...Settings.Defaults.settingsDefaults.providers,
        openai: {
          protocol: "openai-responses",
          baseUrl: "https://openai-compatible.example/v1",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
    }
    const route = yield* routeFor(
      settings,
      Effect.sync(() => {
        reads = reads + 1
        return { _tag: "Corrupt" as const }
      }),
    )
    expect(reads).toBe(0)
    expect(route.main.candidates[0]?.providerConnection).toMatchObject({
      baseUrl: "https://openai-compatible.example/v1",
      authentication: "api-key",
    })
  }),
)

it.effect("pins a customized OpenAI Chat Completions connection and direct model", () =>
  Effect.gen(function* () {
    const settings: Settings.ConfigurationSettings = {
      ...Settings.Defaults.settingsDefaults,
      providers: {
        ...Settings.Defaults.settingsDefaults.providers,
        openai: {
          protocol: "openai-chat-completions",
          baseUrl: "https://chat-compatible.example/openai/v1",
          apiKeyEnv: "CHAT_COMPATIBLE_API_KEY",
        },
      },
      modes: {
        ...Settings.Defaults.settingsDefaults.modes,
        medium: {
          ...Settings.Defaults.settingsDefaults.modes.medium!,
          main: { provider: "openai", model: "custom-chat-model", effort: "medium" },
        },
      },
    }
    const route = yield* routeFor(settings, Effect.succeed({ _tag: "Unauthenticated" }))
    expect(route.main).toMatchObject({
      selection: "custom-chat-model",
      candidates: [
        {
          model: "custom-chat-model",
          providerConnection: {
            provider: "openai",
            protocol: "openai-chat-completions",
            baseUrl: "https://chat-compatible.example/openai/v1",
            apiKeyEnvironment: "CHAT_COMPATIBLE_API_KEY",
          },
          providerOptions: { max_tokens: 128_000 },
        },
      ],
    })
  }),
)

it.effect("uses the configured default mode unless an explicit custom mode is selected", () =>
  Effect.gen(function* () {
    const settings: Settings.ConfigurationSettings = {
      ...Settings.Defaults.settingsDefaults,
      defaultMode: "deep-review",
      modes: {
        quick: {
          main: { provider: "anthropic", model: "claude-quick", effort: "low" },
          oracle: { provider: "anthropic", model: "claude-quick", effort: "low" },
          agents: { task: { provider: "bedrock", model: "us.anthropic.claude-task-v1:0", effort: "high" } },
        },
        "deep-review": {
          main: { provider: "bedrock", model: "us.anthropic.claude-deep-v1:0", effort: "max" },
          oracle: { provider: "bedrock", model: "us.anthropic.claude-deep-v1:0", effort: "max" },
          agents: {},
        },
      },
    }
    const resolve = workspaceExecutionRoute({
      testModel: undefined,
      effectiveConfigForWorkspace: () => Effect.succeed({ settings }),
      openAiAccountStatus: Effect.succeed({ _tag: "Unauthenticated" }),
    })
    const defaulted = yield* resolve(undefined, undefined, "/workspace")
    const explicit = yield* resolve("quick", undefined, "/workspace")
    expect(defaulted.mode).toBe("deep-review")
    expect(defaulted.main.candidates[0]).toMatchObject({ model: "us.anthropic.claude-deep-v1:0" })
    expect(explicit.mode).toBe("quick")
    expect(explicit.main.candidates[0]).toMatchObject({ model: "claude-quick" })
    expect(explicit.agents.task).toMatchObject({
      selection: "us.anthropic.claude-task-v1:0",
      candidates: [
        {
          model: "us.anthropic.claude-task-v1:0",
          providerConnection: { provider: "bedrock", protocol: "amazon-bedrock" },
        },
      ],
    })
  }),
)
