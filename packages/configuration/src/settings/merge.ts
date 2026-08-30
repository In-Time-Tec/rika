import { Function } from "effect"
import { presets } from "../model-routing/model-preset"
import { isStreamingOnlyBaseUrl, type ModelRoute } from "../model-routing/model-route"
import type { ConfigurationEnvironment, ConfigurationSettings } from "./model"
import { settingsDefaults } from "./defaults"
import { ConfigurationSettingsFileError } from "./decoder"
import type { ConfigurationSettingsInput, ModeInput, ModelAliasInput, RoleRouteInput } from "./input"

const own = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

const aliasFromInput = (name: string, input: ModelAliasInput): ModelRoute.ModelAlias => {
  const presetId = input.preset
  const preset = presetId === "openai" || presetId === "claude" ? presets[presetId] : undefined
  const limits = input.limits ?? preset?.limits
  if (limits === undefined)
    throw ConfigurationSettingsFileError.make({
      path: `modelAliases.${name}.limits`,
      message: "Model limits are required.",
    })
  const efforts = input.efforts ?? preset?.variants(preset.efforts)
  const variants: { -readonly [K in ModelRoute.Effort]?: ModelRoute.ModelAlias["variants"][K] } = {}
  if (efforts !== undefined)
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const variant = efforts[effort]
      if (variant !== undefined) variants[effort] = variant
    }
  return {
    displayName: input.displayName ?? name,
    supportsMedia: input.supportsMedia ?? preset !== undefined,
    provider: input.provider,
    candidates: input.candidates,
    limits,
    variants,
  }
}

const assertPainterSupportsMedia = (settings: ConfigurationSettings) => {
  for (const [mode, modeConfig] of Object.entries(settings.modes)) {
    const painter = modeConfig.agents.painter
    if (painter === undefined || !("alias" in painter)) continue
    const alias = own(settings.models, painter.alias)
    if (alias !== undefined && !alias.supportsMedia)
      throw ConfigurationSettingsFileError.make({
        path: `modes.${mode}.agents.painter`,
        message: `Model alias ${painter.alias} does not support media, which the Painter agent requires. Set supportsMedia on the alias if the model accepts images.`,
      })
  }
}

const isBedrockOverride = (
  value: ModelRoute.ProviderOverride | undefined,
): value is Omit<ModelRoute.AmazonBedrockProviderConnection, "protocol"> =>
  value !== undefined &&
  ("authMode" in value || "region" in value || "profile" in value || "endpoint" in value || "authRefresh" in value)

const isHttpOverride = (value: ModelRoute.ProviderOverride | undefined): value is ModelRoute.HttpProviderOverride =>
  value !== undefined && !isBedrockOverride(value)

interface MutableBedrockConnection {
  protocol: "amazon-bedrock"
  authMode: "default" | "bearer"
  region?: string
  profile?: string
  endpoint?: string
  authRefresh?: ModelRoute.BedrockAuthRefresh
}

interface MutableHttpConnection {
  protocol: ModelRoute.HttpProtocol
  baseUrl: string
  apiKeyEnv?: string
  credentialIdentity?: string
  streamingOnly?: boolean
  promptCaching?: boolean
}

const defaultHttpProvider = (id: Exclude<ModelRoute.ProviderId, "bedrock">): ModelRoute.HttpProviderConnection => {
  const connection = settingsDefaults.providers[id]
  if (connection.protocol === "amazon-bedrock") throw new Error(`Provider ${id} is not HTTP`)
  return connection
}

const httpProtocol = (
  id: Exclude<ModelRoute.ProviderId, "bedrock">,
  builtIn: ModelRoute.HttpProviderConnection,
  input: ModelRoute.HttpProviderOverride,
): ModelRoute.HttpProtocol => {
  if (id !== "openai" || input.api === undefined) return builtIn.protocol
  return input.api === "responses" ? "openai-responses" : "openai-chat-completions"
}

const inheritedStreamingOnly = (
  input: ModelRoute.HttpProviderOverride | undefined,
  builtIn: ModelRoute.HttpProviderConnection,
  baseUrl: string,
): boolean | undefined =>
  input?.streamingOnly ?? builtIn.streamingOnly ?? (isStreamingOnlyBaseUrl(baseUrl) || undefined)

const bedrockProvider = (
  globalOverride: ModelRoute.ProviderOverride | undefined,
  workspaceOverride: ModelRoute.ProviderOverride | undefined,
): ModelRoute.AmazonBedrockProviderConnection => {
  const global = isBedrockOverride(globalOverride) ? globalOverride : undefined
  const workspace = isBedrockOverride(workspaceOverride) ? workspaceOverride : undefined
  const override = global === undefined && workspace === undefined ? undefined : { ...global, ...workspace }
  const connection: MutableBedrockConnection = {
    protocol: "amazon-bedrock",
    authMode: override?.authMode === "bearer" ? "bearer" : "default",
  }
  if (override?.region !== undefined) connection.region = override.region
  if (override?.profile !== undefined) connection.profile = override.profile
  if (override?.endpoint !== undefined) connection.endpoint = override.endpoint
  if (override?.authRefresh !== undefined) connection.authRefresh = override.authRefresh
  return connection
}

const httpProvider = (
  id: Exclude<ModelRoute.ProviderId, "bedrock">,
  builtIn: ModelRoute.HttpProviderConnection,
  override: ModelRoute.ProviderOverride | undefined,
): ModelRoute.HttpProviderConnection => {
  const input = isHttpOverride(override) ? override : undefined
  const baseUrl = input?.baseUrl ?? builtIn.baseUrl
  const streamingOnly = inheritedStreamingOnly(input, builtIn, baseUrl)
  if (input === undefined) return streamingOnly === undefined ? builtIn : { ...builtIn, streamingOnly }
  const connection: MutableHttpConnection = {
    protocol: httpProtocol(id, builtIn, input),
    baseUrl,
  }
  const credentialIdentity = input.credentialIdentity ?? builtIn.credentialIdentity
  const promptCaching = input.promptCaching ?? builtIn.promptCaching
  if (input.apiKeyEnv !== undefined) connection.apiKeyEnv = input.apiKeyEnv
  if (credentialIdentity !== undefined) connection.credentialIdentity = credentialIdentity
  if (streamingOnly !== undefined) connection.streamingOnly = streamingOnly
  if (promptCaching !== undefined) connection.promptCaching = promptCaching
  return connection
}

const roleRoute = (
  configured: ModelRoute.RoleRoute | undefined,
  override: RoleRouteInput | undefined,
  path: string,
): ModelRoute.RoleRoute => {
  if (override === undefined) {
    if (configured !== undefined) return configured
    throw ConfigurationSettingsFileError.make({ path, message: "A route is required." })
  }
  const fast = override.fast ?? configured?.fast
  const effort = override.effort ?? configured?.effort ?? "medium"
  if ("alias" in override && override.alias !== undefined)
    return fast === undefined ? { alias: override.alias, effort } : { alias: override.alias, effort, fast }
  return fast === undefined
    ? { provider: override.provider, model: override.model, effort }
    : { provider: override.provider, model: override.model, effort, fast }
}

const agentIds: ReadonlyArray<ModelRoute.AgentId> = ["librarian", "painter", "readThread", "review", "surgeon", "task"]

const modes = (
  global: ConfigurationSettingsInput,
  workspace: ConfigurationSettingsInput,
): ConfigurationSettings["modes"] => {
  if (global.modes === undefined && workspace.modes === undefined) return settingsDefaults.modes
  const merged: Record<string, ModelRoute.ModeConfig> = {}
  const merge = (input: Readonly<Record<string, ModeInput>> | undefined) => {
    for (const [name, mode] of Object.entries(input ?? {})) {
      const current = merged[name]
      const main = roleRoute(current?.main, mode.main, `modes.${name}.main`)
      const oracle = roleRoute(current?.oracle ?? main, mode.oracle, `modes.${name}.oracle`)
      const agents = { ...current?.agents }
      for (const agent of agentIds) {
        const route = mode.agents?.[agent]
        if (route === undefined) continue
        agents[agent] = roleRoute(
          agents[agent] ?? (agent === "task" || agent === "surgeon" ? main : oracle),
          route,
          `modes.${name}.agents.${agent}`,
        )
      }
      merged[name] = {
        main,
        oracle,
        agents,
      }
    }
  }
  merge(global.modes)
  merge(workspace.modes)
  return merged
}

const assertRoutesReferenceKnownModels = (settings: ConfigurationSettings) => {
  const routes: Array<readonly [string, ModelRoute.RoleRoute]> = Object.entries(settings.modes).flatMap(
    ([mode, config]) => [
      [`modes.${mode}.main`, config.main] as const,
      [`modes.${mode}.oracle`, config.oracle] as const,
      ...Object.entries(config.agents).map(([agent, route]) => [`modes.${mode}.agents.${agent}`, route] as const),
    ],
  )
  routes.push(["modelRoutes.title", settings.threadTitle], ["modelRoutes.compaction", settings.compaction.summaryModel])
  for (const [path, route] of routes) {
    if (!("alias" in route) || own(settings.models, route.alias) !== undefined) continue
    throw ConfigurationSettingsFileError.make({ path, message: `Unknown model alias ${JSON.stringify(route.alias)}.` })
  }
}

const mergedModels = (
  global: ConfigurationSettingsInput,
  workspace: ConfigurationSettingsInput,
): ConfigurationSettings["models"] => {
  if (global.modelAliases === undefined && workspace.modelAliases === undefined) return settingsDefaults.models
  const configured = Object.fromEntries(
    Object.entries({ ...global.modelAliases, ...workspace.modelAliases }).map(([name, input]) => [
      name,
      aliasFromInput(name, input),
    ]),
  )
  return Object.fromEntries(Object.entries({ ...settingsDefaults.models, ...configured }))
}

const mergedProviders = (
  global: ConfigurationSettingsInput,
  workspace: ConfigurationSettingsInput,
): ConfigurationSettings["providers"] => ({
  openai: httpProvider(
    "openai",
    defaultHttpProvider("openai"),
    workspace.providers?.openai ?? global.providers?.openai,
  ),
  anthropic: httpProvider(
    "anthropic",
    defaultHttpProvider("anthropic"),
    workspace.providers?.anthropic ?? global.providers?.anthropic,
  ),
  bedrock: bedrockProvider(global.providers?.bedrock, workspace.providers?.bedrock),
  openrouter: httpProvider(
    "openrouter",
    defaultHttpProvider("openrouter"),
    workspace.providers?.openrouter ?? global.providers?.openrouter,
  ),
})

export const mergeConfigurationSettings = ({
  global,
  workspace,
}: {
  readonly global: ConfigurationSettingsInput
  readonly workspace: ConfigurationSettingsInput
}): ConfigurationSettings => {
  const webSearchProviders = { ...global.webSearch?.providers, ...workspace.webSearch?.providers }
  const models = mergedModels(global, workspace)
  const configuredModes = modes(global, workspace)
  const defaultMode = workspace.defaultMode ?? global.defaultMode ?? settingsDefaults.defaultMode
  const merged: ConfigurationSettings = {
    providers: mergedProviders(global, workspace),
    models,
    defaultMode,
    modes: configuredModes,
    threadTitle: roleRoute(
      settingsDefaults.threadTitle,
      workspace.modelRoutes?.title ?? global.modelRoutes?.title,
      "modelRoutes.title",
    ),
    compaction: {
      summaryModel: roleRoute(
        settingsDefaults.compaction.summaryModel,
        workspace.modelRoutes?.compaction ?? global.modelRoutes?.compaction,
        "modelRoutes.compaction",
      ),
    },
    subagents: { ...settingsDefaults.subagents, ...global.subagents, ...workspace.subagents },
    keymap: { ...settingsDefaults.keymap, ...global.keymap, ...workspace.keymap },
    extensionRoots: workspace.extensionRoots ?? global.extensionRoots ?? settingsDefaults.extensionRoots,
    mcp: { ...settingsDefaults.mcp, ...global.mcp, ...workspace.mcp },
    notifications: { ...settingsDefaults.notifications, ...global.notifications, ...workspace.notifications },
    logging: { ...settingsDefaults.logging, ...global.logging, ...workspace.logging },
    webSearch: {
      providers: Object.fromEntries(Object.keys(webSearchProviders).map((id) => [id, { configured: true as const }])),
    },
  }
  if (own(configuredModes, defaultMode) === undefined)
    throw ConfigurationSettingsFileError.make({
      path: "defaultMode",
      message: `${JSON.stringify(defaultMode)} does not name a configured mode.`,
    })
  assertRoutesReferenceKnownModels(merged)
  assertPainterSupportsMedia(merged)
  return merged
}

const withWebSearchConfigurationImpl = (
  settings: ConfigurationSettings,
  credentials: ConfigurationEnvironment["webSearchCredentials"],
): ConfigurationSettings => ({
  ...settings,
  webSearch: {
    providers: Object.fromEntries(Object.keys(credentials).map((id) => [id, { configured: true as const }])),
  },
})

export const withWebSearchConfiguration: {
  (
    settings: ConfigurationSettings,
    credentials: ConfigurationEnvironment["webSearchCredentials"],
  ): ConfigurationSettings
  (
    credentials: ConfigurationEnvironment["webSearchCredentials"],
  ): (settings: ConfigurationSettings) => ConfigurationSettings
} = Function.dual(2, withWebSearchConfigurationImpl)
