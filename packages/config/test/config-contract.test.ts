import { describe, expect, it } from "@effect/vitest"
import { ConfigContract, Models } from "../src/index"

describe("ConfigContract", () => {
  it("owns the built-in model catalog, routes, limits, variants, and compaction policy", () => {
    expect(ConfigContract.defaults.modes).toEqual({
      low: { main: { alias: "luna", effort: "low" }, oracle: { alias: "sol", effort: "high" } },
      medium: { main: { alias: "terra", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
      high: { main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "sol", effort: "max" } },
      ultra: { main: { alias: "sol", effort: "max" }, oracle: { alias: "sol", effort: "max" } },
    })
    expect(ConfigContract.defaults.agents).toEqual({
      librarian: { alias: "sol", effort: "high" },
      painter: { alias: "sol", effort: "high" },
      review: { alias: "sol", effort: "high" },
      readThread: { alias: "terra", effort: "medium" },
      task: { alias: "terra", effort: "medium" },
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
      options: { reasoning: { effort: "medium" }, max_output_tokens: 128_000 },
      compaction: { contextWindow: 1_050_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
    })
    expect(ConfigContract.resolveCompactionSummaryRoute(ConfigContract.defaults)).toMatchObject({
      alias: "terra",
      model: "gpt-5.6-terra",
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

  it.each(["gateways", "models", "modes", "agents", "compaction"])(
    "rejects user-owned internal configuration key %s",
    (key) =>
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: {} })).toThrowError(/unknown key/),
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
      ...(
        Object.keys(ConfigContract.defaults.agents) as ReadonlyArray<keyof typeof ConfigContract.defaults.agents>
      ).map((agent) => ConfigContract.resolveAgentRoute(ConfigContract.defaults, agent)),
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
})
