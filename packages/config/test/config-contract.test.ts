import { describe, expect, it } from "@effect/vitest"
import { ConfigContract, Models } from "../src/index"

describe("ConfigContract", () => {
  it("owns the built-in model catalog, routes, limits, variants, and compaction policy", () => {
    expect(ConfigContract.defaults.modes).toEqual({
      low: { main: { alias: "luna", effort: "xhigh" }, oracle: { alias: "terra", effort: "xhigh" } },
      medium: { main: { alias: "terra", effort: "xhigh" }, oracle: { alias: "sol", effort: "medium" } },
      high: { main: { alias: "sol", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
      ultra: { main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "sol", effort: "max" } },
    })
    expect(ConfigContract.defaults.models.luna).toMatchObject({
      provider: "openai",
      candidates: ["gpt-5.6-luna"],
      limits: { maxInputTokens: 922_000, maxOutputTokens: 128_000, keepRecentTokens: 32_000 },
    })
    expect(Models.catalog.gpt56Sol.limits.contextWindow).toBe(1_050_000)
    expect(ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")).toMatchObject({
      alias: "terra",
      providerId: "openai",
      model: "gpt-5.6-terra",
      options: { reasoning: { effort: "xhigh" } },
      compaction: { contextWindow: 1_050_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
    })
    expect(ConfigContract.resolveCompactionSummaryRoute(ConfigContract.defaults)).toMatchObject({
      alias: "sol",
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
    ).toThrowError(/unknown key custom/)
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
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { providers: { bedrock } })).toThrowError()
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
          base: "terra",
          provider: "bedrock",
          candidates: ["us.anthropic.claude-sonnet-4-20250514-v1:0"],
        },
      },
      modelRoutes: {
        modes: { medium: { main: "bedrock-terra" } },
        agents: { task: "bedrock-terra" },
        compaction: "bedrock-terra",
      },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        modelAliases: { terra: { base: "terra", provider: "bedrock", candidates: ["model"] } },
      }),
    ).toThrowError(/cannot replace a built-in model alias/)
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
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { webSearch })).toThrowError()
    }
  })

  it.each(["gateways", "models", "modes", "agents", "compaction"])(
    "rejects user-owned internal configuration key %s",
    (key) =>
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: {} })).toThrowError(/unknown key/),
  )

  it.each(["contextWindow", "maxInputTokens", "maxOutputTokens", "keepRecentTokens"])(
    "rejects user-owned model policy key %s at every provider boundary",
    (key) => {
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: 1 })).toThrowError(/unknown key/)
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { [key]: 1 } } }),
      ).toThrowError(/unknown key/)
    },
  )

  it.each(["protocol", "auth", "apiKey", "token", "accountCredential"])(
    "rejects incompatible or credential-bearing provider key %s",
    (key) =>
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { [key]: "secret" } } }),
      ).toThrowError(/unknown key/),
  )

  it.each([
    "not a url",
    "/v1",
    "ftp://models.test/v1",
    "https:models.test/v1",
    "http:models.test/v1",
    "https://models.test\t/v1",
  ])("rejects invalid provider URL %s", (baseUrl) => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { baseUrl } } }),
    ).toThrowError(/absolute HTTP or HTTPS URL/)
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
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { baseUrl } } }),
    ).toThrowError(/cannot contain credentials/)
  })

  it.each(["openai_api_key", "OpenAI_API_KEY", "1OPENAI_API_KEY", "OPENAI-API-KEY", "OPENAI API KEY", ""])(
    "rejects invalid API key environment reference %s",
    (apiKeyEnv) =>
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { apiKeyEnv } } }),
      ).toThrowError(/uppercase environment variable/),
  )

  it("resolves every default route to a gpt-5.6 model with streaming reasoning summaries", () => {
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
      expect(route.options).toMatchObject({ reasoning: { summary: "auto" } })
    }
    for (const [alias, entry] of Object.entries(ConfigContract.defaults.models)) {
      if (entry.provider !== "openai") continue
      for (const [effort, variant] of Object.entries(entry.variants)) {
        expect(variant.normal.options, `${alias}/${effort}`).toMatchObject({
          reasoning: { effort, summary: "auto" },
        })
      }
    }
  })

  it("preserves candidate order and rejects incomplete aliases through the routing error contract", () => {
    const fable = ConfigContract.resolveModelRoute(
      {
        ...ConfigContract.defaults,
        modes: {
          ...ConfigContract.defaults.modes,
          low: {
            ...ConfigContract.defaults.modes.low,
            main: { alias: "fable", effort: "low" },
          },
        },
      },
      "low",
    )
    expect(fable.candidates).toEqual(["claude-fable-5", "claude-opus-4-8"])
    expect(fable.model).toBe(fable.candidates[0])

    const emptyAlias: ConfigContract.Settings = {
      ...ConfigContract.defaults,
      models: {
        ...ConfigContract.defaults.models,
        empty: { ...ConfigContract.defaults.models.luna!, candidates: [] },
      },
      modes: {
        ...ConfigContract.defaults.modes,
        low: { ...ConfigContract.defaults.modes.low, main: { alias: "empty", effort: "low" } },
      },
    }
    expect(() => ConfigContract.resolveModelRoute(emptyAlias, "low")).toThrowError(/empty.*no provider candidates/)

    const missingProvider = {
      ...ConfigContract.defaults,
      providers: { anthropic: ConfigContract.defaults.providers.anthropic },
    } as ConfigContract.Settings
    expect(() => ConfigContract.resolveModelRoute(missingProvider, "medium")).toThrowError(
      /terra.*missing provider openai/,
    )
  })

  it("accepts supported logging levels and rejects custom log paths", () => {
    expect(ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "debug" } })).toEqual({
      logging: { level: "debug" },
    })
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "verbose" } })).toThrowError(
      /Logging level/,
    )
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "info", file: "/tmp/rika.log" } }),
    ).toThrowError(/unknown key file/)
  })

  it.each([
    ["keymap", []],
    ["keymap", { submit: 1 }],
    ["permissions", { shell: "sometimes" }],
    ["extensionRoots", "extensions"],
    ["extensionRoots", ["valid", 1]],
    ["mcp", []],
    ["mcp", { local: { transport: "command", command: "mcp", args: "--serve", environment: {}, enabled: true } }],
    ["mcp", { remote: { transport: "remote", url: "not-a-url", headers: {}, enabled: true } }],
    ["notifications", { enabled: "yes" }],
    ["notifications", { enabled: true, unsupported: true }],
  ])("rejects malformed %s configuration", (key, value) => {
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: value })).toThrowError()
  })

  it("accepts a boolean streamingOnly provider override and rejects other types", () => {
    const input = { providers: { openai: { streamingOnly: true } } } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { providers: { openai: { streamingOnly: "yes" } } }),
    ).toThrowError(/streamingOnly must be a boolean/)
  })

  it("marks only chatgpt.com base URLs as streaming-only", () => {
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(true)
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://api.chatgpt.com/v1")).toBe(true)
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://api.openai.com/v1")).toBe(false)
    expect(ConfigContract.isStreamingOnlyBaseUrl("https://evilchatgpt.com/v1")).toBe(false)
    expect(ConfigContract.isStreamingOnlyBaseUrl("not a url")).toBe(false)
  })
})
