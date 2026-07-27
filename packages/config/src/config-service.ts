import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import { presetForBase, type PresetId, presets } from "./models"
import {
  ConfigFileError,
  defaults,
  type Diagnostic,
  type ModelAlias,
  type ModelAliasInput,
  type RoleRoute,
  type RoleRouteInput,
  type EffectiveConfig,
  type Environment,
  type HttpProviderConnection,
  type HttpProviderOverride,
  isStreamingOnlyBaseUrl,
  type ProviderId,
  type ModeId,
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

const aliasFromInput = (name: string, input: ModelAliasInput): ModelAlias => {
  const presetId = input.preset ?? (input.base === undefined ? undefined : presetForBase(input.base))
  const preset = presetId === undefined ? undefined : presets[presetId as PresetId]
  const inherited = input.base === undefined ? undefined : defaults.models[input.base]
  return {
    displayName: input.displayName ?? name,
    supportsMedia: input.supportsMedia ?? preset !== undefined,
    provider: input.provider,
    candidates: input.candidates,
    limits: input.limits ?? inherited?.limits ?? preset!.limits,
    variants:
      input.efforts === undefined
        ? (preset!.variants(preset!.efforts) as ModelAlias["variants"])
        : (input.efforts as ModelAlias["variants"]),
  }
}

const assertPainterSupportsMedia = (settings: Settings) => {
  const painter = settings.agents.painter
  if (painter === undefined) return
  const alias = settings.models[painter.alias]
  if (alias !== undefined && !alias.supportsMedia)
    throw ConfigFileError.make({
      path: "modelRoutes.agents.painter",
      message: `Model alias ${painter.alias} does not support media, which the Painter agent requires. Set supportsMedia on the alias if the model accepts images.`,
    })
}

const roleRoute = (configured: RoleRoute, override: string | RoleRouteInput | undefined): RoleRoute => {
  if (override === undefined) return configured
  if (typeof override === "string") return { ...configured, alias: override }
  return {
    ...configured,
    alias: override.alias,
    ...(override.effort === undefined ? {} : { effort: override.effort }),
    ...(override.fast === undefined ? {} : { fast: override.fast }),
  }
}

const mergeSettings = (global: SettingsInput, workspace: SettingsInput): Settings => {
  const webSearchProviders = { ...global.webSearch?.providers, ...workspace.webSearch?.providers }
  const provider = (id: ProviderId) => {
    const builtIn = defaults.providers[id]!
    const override = workspace.providers?.[id] ?? global.providers?.[id]
    if (builtIn.protocol === "amazon-bedrock") {
      const bedrock = override as (Extract<SettingsInput["providers"], unknown> & Record<string, unknown>) | undefined
      return {
        protocol: "amazon-bedrock" as const,
        authMode: bedrock?.authMode === "bearer" ? ("bearer" as const) : ("default" as const),
        ...(bedrock?.region === undefined ? {} : { region: bedrock.region as string }),
        ...(bedrock?.profile === undefined ? {} : { profile: bedrock.profile as string }),
        ...(bedrock?.endpoint === undefined ? {} : { endpoint: bedrock.endpoint as string }),
        ...(bedrock?.authRefresh === undefined
          ? {}
          : {
              authRefresh: bedrock.authRefresh as Settings["providers"]["bedrock"] extends { authRefresh?: infer A }
                ? A
                : never,
            }),
      }
    }
    const httpBuiltIn = builtIn as HttpProviderConnection
    const httpOverride = override as HttpProviderOverride | undefined
    const baseUrl = httpOverride?.baseUrl ?? httpBuiltIn.baseUrl
    const streamingOnly =
      httpOverride?.streamingOnly ?? httpBuiltIn.streamingOnly ?? (isStreamingOnlyBaseUrl(baseUrl) ? true : undefined)
    const promptCaching = httpOverride?.promptCaching ?? httpBuiltIn.promptCaching
    if (override === undefined) return streamingOnly === undefined ? httpBuiltIn : { ...httpBuiltIn, streamingOnly }
    return {
      protocol: httpBuiltIn.protocol,
      baseUrl,
      ...(httpOverride?.apiKeyEnv === undefined ? {} : { apiKeyEnv: httpOverride.apiKeyEnv }),
      ...(streamingOnly === undefined ? {} : { streamingOnly }),
      ...(promptCaching === undefined ? {} : { promptCaching }),
    }
  }
  const merged: Settings = {
    providers: Object.fromEntries(
      (Object.keys(defaults.providers) as Array<ProviderId>).map((id) => [id, provider(id)]),
    ) as Readonly<Record<ProviderId, Settings["providers"][ProviderId]>>,
    models:
      global.modelAliases === undefined && workspace.modelAliases === undefined
        ? defaults.models
        : Object.fromEntries(
            Object.entries({ ...global.modelAliases, ...workspace.modelAliases }).reduce((all, [name, input]) => {
              all.push([name, aliasFromInput(name, input)])
              return all
            }, Object.entries(defaults.models)),
          ),
    modes:
      global.modelRoutes?.modes === undefined && workspace.modelRoutes?.modes === undefined
        ? defaults.modes
        : (Object.fromEntries(
            Object.entries(defaults.modes).map(([mode, configured]) => {
              const globalMode = global.modelRoutes?.modes?.[mode as ModeId]
              const workspaceMode = workspace.modelRoutes?.modes?.[mode as ModeId]
              return [
                mode,
                {
                  main: roleRoute(configured.main, workspaceMode?.main ?? globalMode?.main),
                  oracle: roleRoute(configured.oracle, workspaceMode?.oracle ?? globalMode?.oracle),
                },
              ]
            }),
          ) as Settings["modes"]),
    threadTitle: roleRoute(defaults.threadTitle, workspace.modelRoutes?.title ?? global.modelRoutes?.title),
    agents: Object.fromEntries(
      Object.entries({ ...global.modelRoutes?.agents, ...workspace.modelRoutes?.agents }).map(([agent, override]) => [
        agent,
        typeof override === "string" ? { alias: override } : override,
      ]),
    ) as Settings["agents"],
    compaction: {
      summaryModel: roleRoute(
        defaults.compaction.summaryModel,
        workspace.modelRoutes?.compaction ?? global.modelRoutes?.compaction,
      ),
    },
    keymap: { ...defaults.keymap, ...global.keymap, ...workspace.keymap },
    permissions: {
      shell:
        workspace.permissions?.shell ?? global.permissions?.shell ?? defaults.permissions.shell ?? ("allow" as const),
    },
    extensionRoots: workspace.extensionRoots ?? global.extensionRoots ?? defaults.extensionRoots,
    mcp: { ...defaults.mcp, ...global.mcp, ...workspace.mcp },
    notifications: { ...defaults.notifications, ...global.notifications, ...workspace.notifications },
    logging: { ...defaults.logging, ...global.logging, ...workspace.logging },
    webSearch: {
      providers: Object.fromEntries(Object.keys(webSearchProviders).map((id) => [id, { configured: true as const }])),
    },
  }
  assertPainterSupportsMedia(merged)
  return merged
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
  for (const [source, input] of [
    ["global", global],
    ["workspace", workspace],
  ] as const)
    for (const [name, alias] of Object.entries(input.modelAliases ?? {}))
      if (alias.base !== undefined)
        entries.push({
          path: `modelAliases.${name}.base`,
          source,
          message: `deprecated base "${alias.base}"; replace with preset "${presetForBase(alias.base)}" and set displayName`,
        })
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
