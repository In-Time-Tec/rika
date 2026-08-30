import { describe, expect, it } from "@effect/vitest"
import * as SettingsDefaults from "../../src/settings/defaults"
import * as SettingsDecoder from "../../src/settings/decoder"
import * as ModelResolution from "../../src/model-routing/model-route-resolution"
import * as Merge from "../../src/settings/merge"
import { isStreamingOnlyBaseUrl } from "../../src/model-routing/model-route"
import { catalog } from "../../src/model-routing/model-catalog"
import type { ConfigurationSettings } from "../../src/settings/model"

const ConfigContract = { ...SettingsDefaults, ...SettingsDecoder, ...ModelResolution, ...Merge, isStreamingOnlyBaseUrl }
const Models = { catalog }

describe("ConfigContract", () => {
  it("owns the built-in model catalog, routes, limits, variants, and compaction policy", () => {
    expect(ConfigContract.defaults.defaultMode).toBe("medium")
    expect(ConfigContract.defaults.modes.medium).toMatchObject({
      main: { alias: "terra", effort: "xhigh" },
      oracle: { alias: "sol", effort: "medium" },
      agents: {},
    })
    expect(ConfigContract.defaults.models.luna).toMatchObject({
      provider: "openai",
      candidates: ["gpt-5.6-luna"],
      limits: { contextWindow: 272_000, maxInputTokens: 258_400, maxOutputTokens: 128_000, keepRecentTokens: 32_000 },
    })
    expect(ConfigContract.defaults.subagents).toEqual({ maxDepth: 1, maxSubagents: 4 })
    expect(Models.catalog.gpt56Sol.limits.contextWindow).toBe(272_000)
    expect(ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")).toMatchObject({
      selection: "terra",
      displayName: "GPT-5.6 Terra",
      providerId: "openai",
      model: "gpt-5.6-terra",
      options: { reasoning: { effort: "xhigh", summary: "auto" } },
      compaction: { contextWindow: 272_000, reserveTokens: 13_600, keepRecentTokens: 32_000 },
    })
    expect(ConfigContract.resolveCompactionSummaryRoute(ConfigContract.defaults)).toMatchObject({
      selection: "sol",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    })
  })

  it("accepts only closed built-in provider overrides", () => {
    const input = {
      providers: {
        openai: { baseUrl: "http://127.0.0.1:8317/v1", apiKeyEnv: "RIKA_MODEL_API_KEY" },
      },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        providers: { custom: { baseUrl: "https://models.test" } },
      }),
    ).toThrow(/unknown key custom/)
  })

  it("accepts the openrouter provider override with a stored credential identity", () => {
    const input = {
      providers: {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
          credentialIdentity: "openrouter",
        },
      },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        providers: { openrouter: { credentialIdentity: "" } },
      }),
    ).toThrow(/credentialIdentity must be a non-empty string/)
  })

  it("resolves openrouter aliases through the openai preset into every route role", () => {
    const settings: ConfigurationSettings = ConfigContract.mergeConfigurationSettings({
      global: {
        providers: { openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" } },
        modelAliases: {
          "mg-flash": {
            preset: "openai",
            provider: "openrouter",
            candidates: ["~deepseek/deepseek-v4-flash-latest"],
            displayName: "DeepSeek V4 Flash",
          },
        },
        modes: {
          medium: {
            main: { alias: "mg-flash" },
            oracle: { alias: "mg-flash" },
          },
        },
        modelRoutes: {
          title: { alias: "mg-flash" },
          compaction: { alias: "mg-flash" },
        },
      },
      workspace: {},
    })
    expect(settings.providers.openrouter).toMatchObject({
      protocol: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      credentialIdentity: "openrouter",
    })
    for (const [mode, role] of [
      ["medium", "main"],
      ["medium", "oracle"],
    ] as const) {
      const resolved = ConfigContract.resolveModelRoute(settings, mode, role)
      expect(resolved).toMatchObject({
        providerId: "openrouter",
        model: "~deepseek/deepseek-v4-flash-latest",
      })
      expect(resolved.options).toHaveProperty("reasoning.effort")
    }
    expect(ConfigContract.resolveThreadTitleRoute(settings)).toMatchObject({
      providerId: "openrouter",
      model: "~deepseek/deepseek-v4-flash-latest",
    })
    expect(ConfigContract.resolveCompactionSummaryRoute(settings)).toMatchObject({
      providerId: "openrouter",
      model: "~deepseek/deepseek-v4-flash-latest",
    })
  })

  it("accepts Bedrock identity and structured SSO refresh settings", () => {
    const input = {
      providers: {
        bedrock: {
          region: "us-east-1",
          profile: "engineering",
          endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
          authMode: "default",
          authRefresh: { command: "aws", args: ["sso", "login", "--profile", "engineering"] },
        },
      },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
  })

  it.each([
    { endpoint: "http://bedrock.example.test" },
    { endpoint: "https://bedrock.example.test?token=secret" },
    { endpoint: "https://bedrock.example.test#secret" },
    { region: "" },
    { profile: "" },
    { authMode: "unknown" },
    { authMode: "bearer", authRefresh: { command: "aws", args: ["sso", "login"] } },
    { authRefresh: { command: "", args: [] } },
    { authRefresh: { command: "aws", args: "sso login" } },
  ])("rejects unsafe or malformed Bedrock settings %#", (bedrock) => {
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { providers: { bedrock } })).toThrow()
  })

  it("allows HTTP Bedrock endpoints only for explicit loopback testing", () => {
    for (const endpoint of ["http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000"])
      expect(ConfigContract.decodeSettingsInput("settings.json", { providers: { bedrock: { endpoint } } })).toEqual({
        providers: { bedrock: { endpoint } },
      })
  })

  it("accepts additive model aliases and leaf model route overrides", () => {
    const input = {
      modelAliases: {
        "bedrock-terra": {
          preset: "openai",
          displayName: "Bedrock Terra",
          provider: "bedrock",
          candidates: ["us.anthropic.claude-sonnet-4-20250514-v1:0"],
        },
      },
      modes: {
        medium: {
          main: { alias: "bedrock-terra" },
          agents: { task: { alias: "bedrock-terra" } },
        },
      },
      modelRoutes: { compaction: { alias: "bedrock-terra" } },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(
      ConfigContract.decodeSettingsInput("settings.json", {
        modelAliases: { terra: { preset: "openai", displayName: "Terra", provider: "bedrock", candidates: ["model"] } },
      }),
    ).toBeDefined()
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        modelAliases: {
          old: { base: "terra", provider: "bedrock", candidates: ["model"], displayName: "Old" },
        },
      }),
    ).toThrow(/unknown key base/)
  })

  it("accepts custom modes with direct role and agent routes and rejects the removed nested route shape", () => {
    const input = {
      defaultMode: "deep-review",
      modes: {
        "deep-review": {
          main: { provider: "anthropic", model: "claude-opus-direct", effort: "high" },
          agents: { task: { provider: "bedrock", model: "us.anthropic.claude-task-direct-v1:0" } },
        },
      },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    for (const route of [
      { model: "claude-opus-direct" },
      { provider: "anthropic", model: "claude-opus-direct", options: {} },
      { provider: "anthropic", model: "claude-opus-direct", candidates: ["fallback"] },
      {
        provider: "anthropic",
        model: "claude-opus-direct",
        limits: { maxInputTokens: 1, maxOutputTokens: 1, keepRecentTokens: 1 },
      },
    ])
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { modes: { custom: { main: route } } }),
      ).toThrow()
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        modelRoutes: { modes: { high: { main: { alias: "sol" } } } },
      }),
    ).toThrow(/unknown key modes/)
  })

  it("accepts arbitrary web search provider credentials and rejects malformed entries", () => {
    const input = { webSearch: { providers: { custom: { apiKey: "secret" } } } } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    for (const webSearch of [
      [],
      {},
      { providers: [] },
      { providers: { "": { apiKey: "secret" } } },
      { providers: { exa: {} } },
      { providers: { exa: { apiKey: "secret", extra: true } } },
    ]) {
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { webSearch })).toThrow()
    }
  })

  it.each(["gateways", "models", "agents", "compaction", "permissions"])(
    "rejects user-owned internal configuration key %s",
    (key) => expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: {} })).toThrow(/unknown key/),
  )

  it.each(["contextWindow", "maxInputTokens", "maxOutputTokens", "keepRecentTokens"])(
    "rejects user-owned model policy key %s at every provider boundary",
    (key) => {
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: 1 })).toThrow(/unknown key/)
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { [key]: 1 } } }),
      ).toThrow(/unknown key/)
    },
  )

  it.each(["protocol", "auth", "apiKey", "token", "accountCredential"])(
    "rejects incompatible or credential-bearing provider key %s",
    (key) =>
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { [key]: "secret" } } }),
      ).toThrow(/unknown key/),
  )

  it.each([
    "not a url",
    "/v1",
    "ftp://models.test/v1",
    "https:models.test/v1",
    "http:models.test/v1",
    "https://models.test\t/v1",
  ])("rejects invalid provider URL %s", (baseUrl) => {
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { baseUrl } } })).toThrow(
      /absolute HTTP or HTTPS URL/,
    )
  })

  it.each([
    "https://user@models.test/v1",
    "https://user:password@models.test/v1",
    "https://models.test/v1?api_key=secret",
    "https://models.test/v1?access-token=secret",
    "https://models.test/v1?authorization=secret",
    "https://models.test/v1?signature=secret",
    "https://models.test/v1?key=secret",
    "https://models.test/v1#secret",
  ])("rejects credentials in provider URL %s", (baseUrl) => {
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { baseUrl } } })).toThrow(
      /cannot contain credentials/,
    )
  })

  it.each(["openai_api_key", "OpenAI_API_KEY", "1OPENAI_API_KEY", "OPENAI-API-KEY", "OPENAI API KEY", ""])(
    "rejects invalid API key environment reference %s",
    (apiKeyEnv) =>
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { apiKeyEnv } } }),
      ).toThrow(/uppercase environment variable/),
  )

  it("rejects effort variants without normal options before route resolution", () => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        modelAliases: {
          custom: {
            provider: "openai",
            candidates: ["custom-model"],
            efforts: { low: { fast: { options: {} } } },
            limits: { maxInputTokens: 1, maxOutputTokens: 1, keepRecentTokens: 1 },
          },
        },
      }),
    ).toThrow(/effort low must set normal options/)
  })

  it("resolves every default route through a reusable gpt-5.6 policy bundle", () => {
    const modes = ["low", "medium", "high", "ultra"] as const
    const roles = ["main", "oracle"] as const
    const routes = [
      ...modes.flatMap((mode) =>
        roles.map((role) => ConfigContract.resolveModelRoute(ConfigContract.defaults, mode, role)),
      ),
      ConfigContract.resolveThreadTitleRoute(ConfigContract.defaults),
      ConfigContract.resolveCompactionSummaryRoute(ConfigContract.defaults),
    ]
    for (const route of routes) {
      expect(route.model).toMatch(/^gpt-5\.6-/)
      expect(route.providerId).toBe("openai")
      expect(route.options).toHaveProperty("reasoning")
    }
  })

  it("preserves candidate order and rejects incomplete aliases through the routing error contract", () => {
    const fableAlias = {
      displayName: "Fable",
      supportsMedia: true,
      provider: "anthropic" as const,
      candidates: ["claude-fable-5", "claude-opus-4-8"],
      limits: { maxInputTokens: 100, maxOutputTokens: 10, keepRecentTokens: 10 },
      variants: { low: { normal: { options: {} } } },
    }
    const fable = ConfigContract.resolveModelRoute(
      {
        ...ConfigContract.defaults,
        models: { fable: fableAlias },
        modes: {
          ...ConfigContract.defaults.modes,
          low: {
            ...ConfigContract.defaults.modes.low!,
            main: { alias: "fable", effort: "low" },
          },
        },
      },
      "low",
    )
    expect(fable.candidates).toEqual(["claude-fable-5", "claude-opus-4-8"])
    expect(fable.model).toBe(fable.candidates[0])

    const emptyAlias: ConfigurationSettings = {
      ...ConfigContract.defaults,
      models: {
        empty: { ...fableAlias, candidates: [] },
      },
      modes: {
        ...ConfigContract.defaults.modes,
        low: { ...ConfigContract.defaults.modes.low!, main: { alias: "empty", effort: "low" } },
      },
    }
    expect(() => ConfigContract.resolveModelRoute(emptyAlias, "low")).toThrow(/no provider candidates/)
  })

  it("accepts supported logging levels and rejects custom log paths", () => {
    expect(ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "debug" } })).toEqual({
      logging: { level: "debug" },
    })
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "verbose" } })).toThrow(
      /Logging level/,
    )
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "info", file: "/tmp/rika.log" } }),
    ).toThrow(/unknown key file/)
  })

  it("accepts non-negative recursive subagent limits and merges each setting by scope", () => {
    const global = ConfigContract.decodeSettingsInput("global/settings.json", {
      subagents: { maxDepth: 2, maxSubagents: 8 },
    })
    const workspace = ConfigContract.decodeSettingsInput("workspace/settings.json", {
      subagents: { maxSubagents: 3 },
    })
    expect(ConfigContract.mergeConfigurationSettings({ global, workspace }).subagents).toEqual({
      maxDepth: 2,
      maxSubagents: 3,
    })
    expect(
      ConfigContract.decodeSettingsInput("settings.json", { subagents: { maxDepth: 0, maxSubagents: 0 } }),
    ).toEqual({
      subagents: { maxDepth: 0, maxSubagents: 0 },
    })
    for (const subagents of [
      { maxDepth: -1 },
      { maxDepth: 1.5 },
      { maxDepth: 1_025 },
      { maxSubagents: 1_025 },
      { maxSubagents: "4" },
    ])
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { subagents })).toThrow(
        /integer between 0 and 1024/,
      )
    expect(
      ConfigContract.decodeSettingsInput("settings.json", { subagents: { maxDepth: 1_024, maxSubagents: 1_024 } }),
    ).toEqual({ subagents: { maxDepth: 1_024, maxSubagents: 1_024 } })
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { subagents: { maxDepth: 1, maxPerDepth: 4 } }),
    ).toThrow(/unknown key maxPerDepth/)
  })

  it.each([
    ["keymap", []],
    ["keymap", { submit: 1 }],
    ["extensionRoots", "extensions"],
    ["extensionRoots", ["valid", 1]],
    ["mcp", []],
    ["mcp", { local: { transport: "command", command: "mcp", args: "--serve", environment: {}, enabled: true } }],
    ["mcp", { remote: { transport: "remote", url: "not-a-url", headers: {}, enabled: true } }],
    ["notifications", { enabled: "yes" }],
    ["notifications", { enabled: true, unsupported: true }],
  ])("rejects malformed %s configuration", (key, value) => {
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: value })).toThrow()
  })

  it("accepts a boolean streamingOnly provider override and rejects other types", () => {
    const input = { providers: { openai: { streamingOnly: true } } } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { streamingOnly: "yes" } } }),
    ).toThrow(/streamingOnly must be a boolean/)
  })

  it("marks only chatgpt.com base URLs as streaming-only", () => {
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(true)
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://api.chatgpt.com/v1")).toBe(true)
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://api.openai.com/v1")).toBe(false)
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://evilchatgpt.com/v1")).toBe(false)
    expect(ConfigContract.isStreamingOnlyBaseUrl("not a url")).toBe(false)
  })
})
