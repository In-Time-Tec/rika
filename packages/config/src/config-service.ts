import { Config, Context, Effect, Layer, Redacted } from "effect"
import {
  defaults,
  type Diagnostic,
  type EffectiveConfig,
  type Environment,
  type ProviderId,
  type Settings,
  type SettingsInput,
} from "./config-contract"

export interface Interface {
  readonly effective: Effect.Effect<EffectiveConfig>
}

export class Service extends Context.Service<Service, Interface>()("@rika/config/config-service/Service") {}

const mergeSettings = (global: SettingsInput, workspace: SettingsInput): Settings => {
  const provider = (id: ProviderId) => {
    const builtIn = defaults.providers[id]!
    const override = workspace.providers?.[id] ?? global.providers?.[id]
    if (override === undefined) return builtIn
    return {
      protocol: builtIn.protocol,
      baseUrl: override.baseUrl ?? builtIn.baseUrl,
      ...(override.apiKeyEnv === undefined ? {} : { apiKeyEnv: override.apiKeyEnv }),
    }
  }
  return {
    providers: { openai: provider("openai"), anthropic: provider("anthropic") },
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
  }
}

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
  if (environment.parallelApiKey !== undefined)
    entries.push({ path: "parallelApiKey", source: "environment", message: "environment value applied (redacted)" })
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
  const environment = options.environment ?? { providerCredentials: {} }
  return Layer.succeed(
    Service,
    Service.of({
      effective: Effect.succeed({
        settings: mergeSettings(global, workspace),
        environment,
        diagnostics: diagnostics(global, workspace, environment),
      }),
    }),
  )
}

export const testLayer = memoryLayer

export const liveEnvironmentLayer = (
  options: { readonly global?: SettingsInput; readonly workspace?: SettingsInput } = {},
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = options.global ?? {}
      const workspace = options.workspace ?? {}
      const settings = mergeSettings(global, workspace)
      const variables = Object.values(settings.providers)
        .flatMap((providerConnection) =>
          providerConnection.apiKeyEnv === undefined ? [] : [providerConnection.apiKeyEnv],
        )
        .filter((variable, index, all) => all.indexOf(variable) === index)
      const values = yield* Config.all({
        parallelApiKey: Config.option(Config.redacted("PARALLEL_API_KEY")),
        providerCredentials: Config.all(
          Object.fromEntries(variables.map((variable) => [variable, Config.option(Config.redacted(variable))])),
        ),
      })
      const environment: Environment =
        values.parallelApiKey._tag === "Some"
          ? { providerCredentials: {}, parallelApiKey: Redacted.make(Redacted.value(values.parallelApiKey.value)) }
          : { providerCredentials: {} }
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
          settings,
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
