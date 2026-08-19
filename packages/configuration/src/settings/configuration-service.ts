import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import { configurationDiagnostics } from "./configuration-diagnostic"
import { mergeConfigurationSettings, withWebSearchConfiguration } from "./configuration-merge"
import type { ConfigurationEnvironment, EffectiveConfiguration } from "./configuration-settings"
import type { ConfigurationSettingsInput } from "./configuration-settings-input"

export interface ConfigurationServiceShape {
  readonly effective: Effect.Effect<EffectiveConfiguration>
}

export class ConfigurationService extends Context.Service<ConfigurationService, ConfigurationServiceShape>()(
  "@rika/configuration/settings/configuration-service/ConfigurationService",
) {}

export interface WebProviderDescriptor {
  readonly id: string
  readonly credentialEnvironment: string
}

export class WebProviderConfigurationError extends Schema.TaggedError<WebProviderConfigurationError>()(
  "WebProviderConfigurationError",
  { message: Schema.String },
) {}

export const memoryConfigurationLayer = (
  options: {
    readonly global?: ConfigurationSettingsInput
    readonly workspace?: ConfigurationSettingsInput
    readonly environment?: ConfigurationEnvironment
  } = {},
) => {
  const global = options.global ?? {}
  const workspace = options.workspace ?? {}
  const configuredWebSearch = { ...global.webSearch?.providers, ...workspace.webSearch?.providers }
  const suppliedEnvironment = options.environment ?? { providerCredentials: {}, webSearchCredentials: {} }
  const webSearchCredentials = {
    ...suppliedEnvironment.webSearchCredentials,
    ...Object.fromEntries(
      Object.entries(configuredWebSearch).map(([id, provider]) => [id, Redacted.make(provider.apiKey)]),
    ),
  }
  const environment: ConfigurationEnvironment = {
    ...suppliedEnvironment,
    webSearchCredentials,
  }
  return Layer.succeed(
    ConfigurationService,
    ConfigurationService.of({
      effective: Effect.succeed({
        settings: withWebSearchConfiguration(mergeConfigurationSettings({ global, workspace }), webSearchCredentials),
        environment,
        diagnostics: configurationDiagnostics({ global, workspace, environment }),
      }),
    }),
  )
}

export const testConfigurationLayer = memoryConfigurationLayer

export const liveConfigurationLayer = (options: {
  readonly webProviders: ReadonlyArray<WebProviderDescriptor>
  readonly global?: ConfigurationSettingsInput
  readonly workspace?: ConfigurationSettingsInput
}) =>
  Layer.effect(
    ConfigurationService,
    Effect.gen(function* () {
      const global = options.global ?? {}
      const workspace = options.workspace ?? {}
      const settings = mergeConfigurationSettings({ global, workspace })
      const configuredWebSearch = { ...global.webSearch?.providers, ...workspace.webSearch?.providers }
      const installedProviderIds = new Set(options.webProviders.map((provider) => provider.id))
      const unsupportedProviderIds = Object.keys(configuredWebSearch).filter((id) => !installedProviderIds.has(id))
      if (unsupportedProviderIds.length > 0)
        return yield* WebProviderConfigurationError.make({
          message: `Unknown web search provider ${unsupportedProviderIds.map((id) => `'${id}'`).join(", ")}. Installed providers: ${options.webProviders.map((provider) => provider.id).join(", ")}`,
        })
      const variables = Object.values(settings.providers)
        .flatMap((providerConnection) =>
          providerConnection.protocol === "amazon-bedrock" || providerConnection.apiKeyEnv === undefined
            ? []
            : [providerConnection.apiKeyEnv],
        )
        .filter((variable, index, all) => all.indexOf(variable) === index)
      const values = yield* Config.all({
        webSearchCredentials: Config.all(
          Object.fromEntries(
            options.webProviders.map((provider) => [
              provider.id,
              Config.option(Config.redacted(provider.credentialEnvironment)),
            ]),
          ),
        ),
        providerCredentials: Config.all(
          Object.fromEntries(variables.map((variable) => [variable, Config.option(Config.redacted(variable))])),
        ),
      })
      const webSearchCredentials = Object.fromEntries(
        new Set([...Object.keys(configuredWebSearch), ...Object.keys(values.webSearchCredentials)])
          .values()
          .flatMap((id) => {
            const configured = configuredWebSearch[id]?.apiKey
            if (configured !== undefined) return [[id, Redacted.make(configured)]]
            const fallback = values.webSearchCredentials[id]
            return fallback?._tag === "Some" ? [[id, Redacted.make(Redacted.value(fallback.value))]] : []
          }),
      )
      const environment: ConfigurationEnvironment = {
        providerCredentials: {},
        webSearchCredentials,
      }
      const completeEnvironment: ConfigurationEnvironment = {
        ...environment,
        providerCredentials: Object.fromEntries(
          Object.entries(values.providerCredentials).flatMap(([variable, value]) =>
            value._tag === "Some" ? [[variable, Redacted.make(Redacted.value(value.value))]] : [],
          ),
        ),
      }
      return ConfigurationService.of({
        effective: Effect.succeed({
          settings: withWebSearchConfiguration(settings, webSearchCredentials),
          environment: completeEnvironment,
          diagnostics: configurationDiagnostics({ global, workspace, environment: completeEnvironment }),
        }),
      })
    }),
  )

export const effectiveConfiguration = Effect.fn("ConfigurationService.effective")(function* () {
  const service = yield* ConfigurationService
  return yield* service.effective
})
