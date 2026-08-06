import { expect, test } from "vitest"
import { Anthropic, OpenAi } from "@batonfx/providers"
import * as Settings from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"

const decoders = { openai: OpenAi.decodeConfig, anthropic: Anthropic.decodeConfig } as const

const efforts = ["low", "medium", "high", "xhigh", "max"] as const

const settingsFor = (alias: string, effort: (typeof efforts)[number]): Settings.ConfigurationSettings => ({
  ...Settings.Defaults.settingsDefaults,
  modes: {
    ...Settings.Defaults.settingsDefaults.modes,
    medium: { main: { alias, effort }, oracle: { alias, effort } },
  },
})

const routedOptions = (alias: string, effort: (typeof efforts)[number]) =>
  ExecutionRouteResolution.resolve(settingsFor(alias, effort), "medium").main.candidates[0]!.providerOptions

const anthropicEffort = (alias: string, effort: (typeof efforts)[number]) =>
  (routedOptions(alias, effort) as { readonly output_config: { readonly effort: string } }).output_config.effort

const openAiEffort = (alias: string, effort: (typeof efforts)[number]) =>
  (routedOptions(alias, effort) as { readonly reasoning: { readonly effort: string } }).reasoning.effort

const aliasFor = (provider: string) =>
  Object.entries(Settings.Defaults.settingsDefaults.models).find(([, model]) => model.provider === provider)![0]

test("every routable effort builds provider request options the routed protocol accepts", () => {
  const aliases = Object.entries(Settings.Defaults.settingsDefaults.models)
  expect(aliases.length).toBeGreaterThan(0)
  for (const [alias, model] of aliases) {
    for (const effort of efforts) {
      if (model.variants[effort] === undefined) continue
      const route = ExecutionRouteResolution.resolve(settingsFor(alias, effort), "medium")
      for (const candidate of route.main.candidates) {
        const decode = decoders[candidate.providerConnection.protocol as keyof typeof decoders]
        if (decode === undefined) continue
        expect(() => decode(candidate.providerOptions)).not.toThrow()
      }
    }
  }
})

test("routed effort reaches the provider as the closest level that protocol supports", () => {
  const anthropic = aliasFor("anthropic")
  const openai = aliasFor("openai")
  expect(efforts.map((effort) => anthropicEffort(anthropic, effort))).toEqual(["low", "medium", "high", "max", "max"])
  expect(efforts.map((effort) => openAiEffort(openai, effort))).toEqual(["low", "medium", "high", "xhigh", "xhigh"])
})
