import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import {
  defaults,
  type Diagnostic,
  type EffectiveConfig,
  type Environment,
  isStreamingOnlyBaseUrl,
  type ProviderId,
  type Settings,
  type SettingsInput,
} from "./config-contract"

export interface Interface {
  readonly effective: Effect.Effect<EffectiveConfig>
}

export class Service extends Context.Service<Service, Interface>()("@rika/config/config-service/Service") {}

export interface WebProviderDescriptor {
  readonly id: string
  readonly credentialEnvironment: string
}

export class WebProviderConfigurationError extends Schema.TaggedErrorClass<WebProviderConfigurationError>()(
  "WebProviderConfigurationError",
  { message: Schema.String },
) {}

const mergeSettings = (global: SettingsInput, workspace: SettingsInput): Settings => {
  const webSearchProviders = { ...global.webSearch?.providers, ...workspace.webSearch?.providers }
  const provider = (id: ProviderId) => {
    const builtIn = defaults.providers[id]!
    const override = workspace.providers?.[id] ?? global.providers?.[id]
    const baseUrl = override?.baseUrl ?? builtIn.baseUrl
    const streamingOnly =
      override?.streamingOnly ?? builtIn.streamingOnly ?? (isStreamingOnlyBaseUrl(baseUrl) ? true : undefined)
    if (override === undefined) return streamingOnly === undefined ? builtIn : { ...builtIn, streamingOnly }
    return {
      protocol: builtIn.protocol,
      baseUrl,
      ...(override.apiKeyEnv === undefined ? {} : { apiKeyEnv: override.apiKeyEnv }),
      ...(streamingOnly === undefined ? {} : { streamingOnly }),
    }
  }
  return {
    providers: Object.fromEntries(
      (Object.keys(defaults.providers) as Array<ProviderId>).map((id) => [id, provider(id)]),
    ) as Readonly<Record<ProviderId, Settings["providers"][ProviderId]>>,
    models: defaults.models,
    modes: defaults.modes,
    agents: defaults.agents,
    compaction: defaults.compaction,
    keymap: { ...defaults.keymap, ...global.keymap, ...workspace.keymap },
    permissions: { ...defaults.permissions, ...global.permissions, ...workspace.permissions },
    extensionRoots: workspace.extensionRoots ?? global.extensionRoots ?? defaults.extensionRoots,
    mcp: { ...defaults.mcp, ...global.mcp, ...workspace.mcp },
    notifications: { ...defaults.notifications, ...global.notifications, ...workspace.notifications },
    logging: { ...defaults.logging, ...global.logging, ...workspace.logging },
    webSearch: {
      providers: Object.fromEntries(Object.keys(webSearchProviders).map((id) => [id, { configured: true as const }])),
    },
  }
}

const withWebSearchProviders = (settings: Settings, credentials: Environment["webSearchCredentials"]): Settings => ({
  ...settings,
  webSearch: {
    providers: Object.fromEntries(Object.keys(credentials).map((id) => [id, { configured: true as const }])),
  },
})

const diagnostics = (
  global: SettingsInput,
  workspace: SettingsInput,
  environment: Environment,
): ReadonlyArray<Diagnostic> => {
  const entries: Array<Diagnostic> = []
  const record = (input: SettingsInput, source: "global" | "workspace") => {
    for (const path of Object.keys(input).toSorted()) entries.push({ path, source, message: `${source} value applied` })
  }
  record(global, "global")
  record(workspace, "workspace")
  for (const providerId of Object.keys(environment.webSearchCredentials).toSorted())
    entries.push({
      path: `webSearchCredentials.${providerId}`,
      source: "environment",
      message: "environment value applied (redacted)",
    })
  for (const variable of Object.keys(environment.providerCredentials).toSorted())
    entries.push({
      path: `providerCredentials.${variable}`,
      source: "environment",
      message: "environment value applied (redacted)",
    })
  return entries
}

export const memoryLayer = (
  options: {
    readonly global?: SettingsInput
    readonly workspace?: SettingsInput
    readonly environment?: Environment
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
  const environment: Environment = {
    ...suppliedEnvironment,
    webSearchCredentials,
  }
  return Layer.succeed(
    Service,
    Service.of({
      effective: Effect.succeed({
        settings: withWebSearchProviders(mergeSettings(global, workspace), webSearchCredentials),
        environment,
        diagnostics: diagnostics(global, workspace, environment),
      }),
    }),
  )
}

export const testLayer = memoryLayer

export const liveEnvironmentLayer = (options: {
  readonly webProviders: ReadonlyArray<WebProviderDescriptor>
  readonly global?: SettingsInput
  readonly workspace?: SettingsInput
}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = options.global ?? {}
      const workspace = options.workspace ?? {}
      const settings = mergeSettings(global, workspace)
      const configuredWebSearch = { ...global.webSearch?.providers, ...workspace.webSearch?.providers }
      const installedProviderIds = new Set(options.webProviders.map((provider) => provider.id))
      const unsupportedProviderIds = Object.keys(configuredWebSearch).filter((id) => !installedProviderIds.has(id))
      if (unsupportedProviderIds.length > 0)
        return yield* WebProviderConfigurationError.make({
          message: `Unknown web search provider ${unsupportedProviderIds.map((id) => `'${id}'`).join(", ")}. Installed providers: ${options.webProviders.map((provider) => provider.id).join(", ")}`,
        })
      const variables = Object.values(settings.providers)
        .flatMap((providerConnection) =>
          providerConnection.apiKeyEnv === undefined ? [] : [providerConnection.apiKeyEnv],
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
      const environment: Environment = {
        providerCredentials: {},
        webSearchCredentials,
      }
      const completeEnvironment: Environment = {
        ...environment,
        providerCredentials: Object.fromEntries(
          Object.entries(values.providerCredentials).flatMap(([variable, value]) =>
            value._tag === "Some" ? [[variable, Redacted.make(Redacted.value(value.value))]] : [],
          ),
        ),
      }
      return Service.of({
        effective: Effect.succeed({
          settings: withWebSearchProviders(settings, webSearchCredentials),
          environment: completeEnvironment,
          diagnostics: diagnostics(global, workspace, completeEnvironment),
        }),
      })
    }),
  )

export const effective = Effect.fn("ConfigService.effective")(function* () {
  const service = yield* Service
  return yield* service.effective
})
