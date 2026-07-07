import { Config, Diagnostics } from "@rika/core"
import { Effect, Layer } from "effect"
import * as Anthropic from "./anthropic"
import * as OpenAi from "./openai"
import * as Provider from "./provider"
import * as Router from "./router"

export interface Options {
  readonly openai?: OpenAi.Options
  readonly anthropic?: Anthropic.Options
}

export const optionsFromEnv = (env: Record<string, string | undefined>): Options => {
  const apiUrl = env.RIKA_BASE_URL === undefined || env.RIKA_BASE_URL.length === 0 ? undefined : env.RIKA_BASE_URL
  const anthropicApiUrl = apiUrl === undefined ? undefined : stripTrailingV1(apiUrl)

  return {
    openai: {
      apiKeyEnv: "RIKA_API_KEY",
      ...(apiUrl === undefined ? {} : { apiUrl }),
    },
    anthropic: {
      apiKeyEnv: "RIKA_API_KEY",
      ...(anthropicApiUrl === undefined ? {} : { apiUrl: anthropicApiUrl }),
    },
  }
}

export const stripTrailingV1 = (apiUrl: string): string => {
  const normalized = apiUrl.replace(/\/+$/, "")
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized
}

export const providerRegistryLayer = (
  options: Options = {},
): Layer.Layer<Provider.Registry, Config.ConfigError, Config.Service> =>
  Layer.effect(
    Provider.Registry,
    Effect.gen(function* () {
      const providers = yield* Effect.all([OpenAi.provider(options.openai), Anthropic.provider(options.anthropic)])
      return Provider.registryFromProviders(providers)
    }),
  )

export const layer = (
  options: Options = {},
): Layer.Layer<Router.Service, Config.ConfigError, Config.Service | Diagnostics.Service> =>
  Router.layer.pipe(Layer.provideMerge(providerRegistryLayer(options)))
