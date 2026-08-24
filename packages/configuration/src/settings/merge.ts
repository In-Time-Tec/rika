import { Function } from "effect"
import { presets } from "../model-routing/model-preset"
import { isStreamingOnlyBaseUrl } from "../model-routing/model-route"
import type { ModelRoute } from "../model-routing/model-route"
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
  const variants: ModelRoute.ModelAlias["variants"] = Object.assign(
    {},
    efforts?.low === undefined ? undefined : { low: efforts.low },
    efforts?.medium === undefined ? undefined : { medium: efforts.medium },
    efforts?.high === undefined ? undefined : { high: efforts.high },
    efforts?.xhigh === undefined ? undefined : { xhigh: efforts.xhigh },
    efforts?.max === undefined ? undefined : { max: efforts.max },
  )
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

const roleRoute = (
  configured: ModelRoute.RoleRoute | undefined,
  override: RoleRouteInput | undefined,
  path: string,
): ModelRoute.RoleRoute => {
  if (override === undefined) {
    if (configured !== undefined) return configured
    throw ConfigurationSettingsFileError.make({ path, message: "A route is required." })
  }
  if ("alias" in override && override.alias !== undefined) {
    const fast = override.fast ?? configured?.fast
    const effort = override.effort ?? configured?.effort ?? "medium"
    return fast === undefined ? { alias: override.alias, effort } : { alias: override.alias, effort, fast }
  }
  const fast = override.fast ?? configured?.fast
  const effort = override.effort ?? configured?.effort ?? "medium"
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

export const mergeConfigurationSettings = ({
  global,
  workspace,
}: {
  readonly global: ConfigurationSettingsInput
  readonly workspace: ConfigurationSettingsInput
}): ConfigurationSettings => {
  const webSearchProviders = { ...global.webSearch?.providers, ...workspace.webSearch?.providers }
  const provider = (id: ModelRoute.ProviderId): ModelRoute.ProviderConnection => {
    const builtIn = settingsDefaults.providers[id]
    const globalOverride = global.providers?.[id]
    const workspaceOverride = workspace.providers?.[id]
    const override = workspaceOverride ?? globalOverride
    if (builtIn.protocol === "amazon-bedrock") {
      const globalBedrock = isBedrockOverride(globalOverride) ? globalOverride : undefined
      const workspaceBedrock = isBedrockOverride(workspaceOverride) ? workspaceOverride : undefined
      const bedrock =
        globalBedrock === undefined && workspaceBedrock === undefined
          ? undefined
          : { ...globalBedrock, ...workspaceBedrock }
      const base: Pick<ModelRoute.AmazonBedrockProviderConnection, "protocol" | "authMode"> = {
        protocol: "amazon-bedrock",
        authMode: bedrock?.authMode === "bearer" ? "bearer" : "default",
      }
      return Object.assign(
        base,
        bedrock?.region === undefined ? undefined : { region: bedrock.region },
        bedrock?.profile === undefined ? undefined : { profile: bedrock.profile },
        bedrock?.endpoint === undefined ? undefined : { endpoint: bedrock.endpoint },
        bedrock?.authRefresh === undefined ? undefined : { authRefresh: bedrock.authRefresh },
      )
    }
    const httpOverride: ModelRoute.HttpProviderOverride | undefined = isHttpOverride(override) ? override : undefined
    const baseUrl = httpOverride?.baseUrl ?? builtIn.baseUrl
    const streamingOnly =
      httpOverride?.streamingOnly ?? builtIn.streamingOnly ?? (isStreamingOnlyBaseUrl(baseUrl) ? true : undefined)
    const promptCaching = httpOverride?.promptCaching ?? builtIn.promptCaching
    const credentialIdentity = httpOverride?.credentialIdentity ?? builtIn.credentialIdentity
    let protocol: ModelRoute.HttpProtocol = builtIn.protocol
    if (id === "openai" && httpOverride?.api !== undefined)
      protocol = httpOverride.api === "responses" ? "openai-responses" : "openai-chat-completions"
    if (httpOverride === undefined) return streamingOnly === undefined ? builtIn : { ...builtIn, streamingOnly }
    return Object.assign(
      { protocol, baseUrl },
      httpOverride.apiKeyEnv === undefined ? undefined : { apiKeyEnv: httpOverride.apiKeyEnv },
      credentialIdentity === undefined ? undefined : { credentialIdentity },
      streamingOnly === undefined ? undefined : { streamingOnly },
      promptCaching === undefined ? undefined : { promptCaching },
    )
  }
  const models: ConfigurationSettings["models"] =
    global.modelAliases === undefined && workspace.modelAliases === undefined
      ? settingsDefaults.models
      : Object.fromEntries(
          Object.entries({
            ...settingsDefaults.models,
            ...Object.fromEntries(
              Object.entries({ ...global.modelAliases, ...workspace.modelAliases }).map(([name, input]) => [
                name,
                aliasFromInput(name, input),
              ]),
            ),
          }),
        )
  const configuredModes = modes(global, workspace)
  const defaultMode = workspace.defaultMode ?? global.defaultMode ?? settingsDefaults.defaultMode
  const merged: ConfigurationSettings = {
    providers: {
      openai: provider("openai"),
      anthropic: provider("anthropic"),
      bedrock: provider("bedrock"),
      openrouter: provider("openrouter"),
    },
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
