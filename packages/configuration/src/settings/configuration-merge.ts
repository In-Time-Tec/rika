import { Function } from "effect"
import { type PresetId, presets } from "../model-routing/model-preset"
import { isStreamingOnlyBaseUrl } from "../model-routing/model-route"
import type { ModelRoute } from "../model-routing/model-route"
import type { ConfigurationSettings } from "./configuration-settings"
import { settingsDefaults } from "./configuration-defaults"
import { ConfigurationSettingsFileError } from "./configuration-settings-decoder"
import type { ConfigurationSettingsInput, ModelAliasInput, RoleRouteInput } from "./configuration-settings-input"

const aliasFromInput = (name: string, input: ModelAliasInput): ModelRoute.ModelAlias => {
  const presetId = input.preset
  const preset = presetId === undefined ? undefined : presets[presetId as PresetId]
  return {
    displayName: input.displayName ?? name,
    supportsMedia: input.supportsMedia ?? preset !== undefined,
    provider: input.provider,
    candidates: input.candidates,
    limits: input.limits ?? preset!.limits,
    variants:
      input.efforts === undefined
        ? (preset!.variants(preset!.efforts) as ModelRoute.ModelAlias["variants"])
        : (input.efforts as ModelRoute.ModelAlias["variants"]),
  }
}

const assertPainterSupportsMedia = (settings: ConfigurationSettings) => {
  const painter = settings.agents.painter
  if (painter === undefined) return
  const alias = settings.models[painter.alias]
  if (alias !== undefined && !alias.supportsMedia)
    throw ConfigurationSettingsFileError.make({
      path: "modelRoutes.agents.painter",
      message: `Model alias ${painter.alias} does not support media, which the Painter agent requires. Set supportsMedia on the alias if the model accepts images.`,
    })
}

const isBedrockOverride = (
  value: ModelRoute.ProviderOverride | undefined,
): value is Omit<ModelRoute.AmazonBedrockProviderConnection, "protocol"> =>
  value !== undefined &&
  ("authMode" in value || "region" in value || "profile" in value || "endpoint" in value || "authRefresh" in value)

const roleRoute = (configured: ModelRoute.RoleRoute, override: string | RoleRouteInput | undefined) => {
  if (override === undefined) return configured
  if (typeof override === "string") return { ...configured, alias: override }
  return {
    ...configured,
    alias: override.alias,
    ...(override.effort === undefined ? {} : { effort: override.effort }),
    ...(override.fast === undefined ? {} : { fast: override.fast }),
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
      return {
        protocol: "amazon-bedrock",
        authMode: bedrock?.authMode === "bearer" ? "bearer" : "default",
        ...(bedrock?.region === undefined ? {} : { region: bedrock.region }),
        ...(bedrock?.profile === undefined ? {} : { profile: bedrock.profile }),
        ...(bedrock?.endpoint === undefined ? {} : { endpoint: bedrock.endpoint }),
        ...(bedrock?.authRefresh === undefined ? {} : { authRefresh: bedrock.authRefresh }),
      }
    }
    const httpOverride: ModelRoute.HttpProviderOverride | undefined =
      override === undefined || isBedrockOverride(override) ? undefined : (override as ModelRoute.HttpProviderOverride)
    const baseUrl = httpOverride?.baseUrl ?? builtIn.baseUrl
    const streamingOnly =
      httpOverride?.streamingOnly ?? builtIn.streamingOnly ?? (isStreamingOnlyBaseUrl(baseUrl) ? true : undefined)
    const promptCaching = httpOverride?.promptCaching ?? builtIn.promptCaching
    const credentialIdentity = httpOverride?.credentialIdentity ?? builtIn.credentialIdentity
    if (override === undefined) return streamingOnly === undefined ? builtIn : { ...builtIn, streamingOnly }
    return {
      protocol: builtIn.protocol,
      baseUrl,
      ...(httpOverride?.apiKeyEnv === undefined ? {} : { apiKeyEnv: httpOverride.apiKeyEnv }),
      ...(credentialIdentity === undefined ? {} : { credentialIdentity }),
      ...(streamingOnly === undefined ? {} : { streamingOnly }),
      ...(promptCaching === undefined ? {} : { promptCaching }),
    }
  }
  const merged: ConfigurationSettings = {
    providers: {
      openai: provider("openai"),
      anthropic: provider("anthropic"),
      bedrock: provider("bedrock"),
      openrouter: provider("openrouter"),
    },
    models:
      global.modelAliases === undefined && workspace.modelAliases === undefined
        ? settingsDefaults.models
        : Object.fromEntries(
            Object.entries({ ...global.modelAliases, ...workspace.modelAliases }).reduce(
              (all, [name, input]) => {
                all.push([name, aliasFromInput(name, input)])
                return all
              },
              Object.entries(settingsDefaults.models) as Array<[string, ModelRoute.ModelAlias]>,
            ),
          ),
    modes:
      global.modelRoutes?.modes === undefined && workspace.modelRoutes?.modes === undefined
        ? settingsDefaults.modes
        : (Object.fromEntries(
            Object.entries(settingsDefaults.modes).map(([mode, configured]) => {
              const globalMode = global.modelRoutes?.modes?.[mode as keyof typeof settingsDefaults.modes]
              const workspaceMode = workspace.modelRoutes?.modes?.[mode as keyof typeof settingsDefaults.modes]
              return [
                mode,
                {
                  main: roleRoute(configured.main, workspaceMode?.main ?? globalMode?.main),
                  oracle: roleRoute(configured.oracle, workspaceMode?.oracle ?? globalMode?.oracle),
                },
              ]
            }),
          ) as ConfigurationSettings["modes"]),
    threadTitle: roleRoute(settingsDefaults.threadTitle, workspace.modelRoutes?.title ?? global.modelRoutes?.title),
    agents: Object.fromEntries(
      Object.entries({ ...global.modelRoutes?.agents, ...workspace.modelRoutes?.agents }).map(([agent, override]) => [
        agent,
        typeof override === "string" ? { alias: override } : override,
      ]),
    ) as ConfigurationSettings["agents"],
    compaction: {
      summaryModel: roleRoute(
        settingsDefaults.compaction.summaryModel,
        workspace.modelRoutes?.compaction ?? global.modelRoutes?.compaction,
      ),
    },
    keymap: { ...settingsDefaults.keymap, ...global.keymap, ...workspace.keymap },
    extensionRoots: workspace.extensionRoots ?? global.extensionRoots ?? settingsDefaults.extensionRoots,
    mcp: { ...settingsDefaults.mcp, ...global.mcp, ...workspace.mcp },
    notifications: { ...settingsDefaults.notifications, ...global.notifications, ...workspace.notifications },
    logging: { ...settingsDefaults.logging, ...global.logging, ...workspace.logging },
    webSearch: {
      providers: Object.fromEntries(Object.keys(webSearchProviders).map((id) => [id, { configured: true as const }])),
    },
  }
  assertPainterSupportsMedia(merged)
  return merged
}

const withWebSearchConfigurationImpl = (
  settings: ConfigurationSettings,
  credentials: Readonly<Record<string, unknown>>,
): ConfigurationSettings => ({
  ...settings,
  webSearch: {
    providers: Object.fromEntries(Object.keys(credentials).map((id) => [id, { configured: true as const }])),
  },
})

export const withWebSearchConfiguration: {
  (settings: ConfigurationSettings, credentials: Readonly<Record<string, unknown>>): ConfigurationSettings
  (credentials: Readonly<Record<string, unknown>>): (settings: ConfigurationSettings) => ConfigurationSettings
} = Function.dual(2, withWebSearchConfigurationImpl)
