import { describe, expect, it } from "@effect/vitest"
import { ConfigContract } from "../src/index"

describe("ConfigContract", () => {
  it("defines the exact Amp-style main and Oracle matrix", () => {
    expect(ConfigContract.defaults.modes).toEqual({
      low: { budget: 32, main: { alias: "luna", effort: "low" }, oracle: { alias: "sol", effort: "high" } },
      medium: { budget: 64, main: { alias: "terra", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
      high: { budget: 128, main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "fable", effort: "max" } },
      ultra: { budget: 256, main: { alias: "fable", effort: "max" }, oracle: { alias: "sol", effort: "max" } },
    })
    expect(ConfigContract.defaults.models.fable?.candidates).toEqual(["claude-fable-5", "claude-opus-4-8"])
  })

  it.each(["providers", "provider", "model", "oracleModel", "reasoning", "baseUrl", "apiKey"])(
    "rejects legacy root key %s",
    (key) =>
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: {} })).toThrowError(/unknown key/),
  )

  it("accepts an arbitrary protocol-discriminated gateway with explicit auth", () => {
    const input = {
      gateways: { moon: { protocol: "openai", baseUrl: "https://moon.test/v1", auth: { type: "none" } } },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
  })

  it("requires bearer auth to name a valid environment variable", () => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        gateways: {
          moon: { protocol: "openai", baseUrl: "https://moon.test/v1", auth: { type: "bearer-env" } },
        },
      }),
    ).toThrowError(/requires an environment variable/)
    expect(ConfigContract.defaults.gateways.openai!.auth).toEqual({ type: "bearer-env", variable: "OPENAI_API_KEY" })
    expect(ConfigContract.defaults.gateways.anthropic!.auth).toEqual({
      type: "bearer-env",
      variable: "ANTHROPIC_API_KEY",
    })
  })

  it("rejects inferred protocols and persisted secrets", () => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { gateways: { moon: { baseUrl: "https://moon.test" } } }),
    ).toThrowError(/explicit supported protocol/)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        gateways: {
          moon: {
            protocol: "anthropic",
            baseUrl: "https://moon.test",
            auth: { type: "bearer-env", apiKey: "secret" },
          },
        },
      }),
    ).toThrowError(/unknown key apiKey/)
  })

  it("rejects incomplete and legacy mode shapes", () => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { modes: { low: { budget: 1, model: "luna" } } }),
    ).toThrowError(/unknown key model/)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        modes: { low: { budget: 1, main: { alias: "luna", effort: "low" } } },
      }),
    ).toThrowError(/requires budget, main, and oracle/)
  })

  it("enforces compaction cross-field limits and typed fast availability", () => {
    const bad = structuredClone(ConfigContract.defaults.models.luna!) as any
    bad.compaction.reserveTokens = 350_000
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { models: { bad } })).toThrowError(
      /valid operational compaction limits/,
    )
    const settings: ConfigContract.Settings = {
      ...ConfigContract.defaults,
      modes: {
        ...ConfigContract.defaults.modes,
        high: { ...ConfigContract.defaults.modes.high, main: { alias: "fable", effort: "max", fast: true } },
      },
    }
    expect(() => ConfigContract.resolveModelRoute(settings, "high", "main")).toThrowError(
      /unavailable fable\/max\/fast/,
    )
  })

  it("resolves exact options and operational compaction", () => {
    expect(ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")).toMatchObject({
      alias: "terra",
      model: "gpt-5.6-terra",
      effort: "medium",
      options: { reasoning: { effort: "medium" }, max_output_tokens: 128_000 },
      compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
    })
  })
})
