import { Config, Context, Effect, Layer, Redacted } from "effect"
import {
  defaults,
  type Diagnostic,
  type EffectiveConfig,
  type Environment,
  type ModelAlias,
  type ModelAliasInput,
  type ModeId,
  type Settings,
  type SettingsInput,
} from "./config-contract"

export interface Interface {
  readonly effective: Effect.Effect<EffectiveConfig>
}

export class Service extends Context.Service<Service, Interface>()("@rika/config/config-service/Service") {}

const mergeModels = (...sources: ReadonlyArray<Readonly<Record<string, ModelAliasInput>> | undefined>) => {
  const models: Record<string, ModelAlias> = { ...defaults.models }
  for (const source of sources) {
    for (const [name, input] of Object.entries(source ?? {})) {
      const current = models[name]
      models[name] =
        current === undefined
          ? (input as ModelAlias)
          : {
              ...current,
              ...input,
              limits: { ...current.limits, ...input.limits },
              variants: { ...current.variants, ...input.variants },
            }
    }
  }
  return models
}

const mergeSettings = (global: SettingsInput, workspace: SettingsInput): Settings => {
  const mode = (id: ModeId) => ({ ...defaults.modes[id], ...global.modes?.[id], ...workspace.modes?.[id] })
  const modes = { low: mode("low"), medium: mode("medium"), high: mode("high"), ultra: mode("ultra") }
  return {
    gateways: { ...defaults.gateways, ...global.gateways, ...workspace.gateways },
    models: mergeModels(global.models, workspace.models),
    modes,
    agents: { ...defaults.agents, ...global.agents, ...workspace.agents },
    compaction: { ...defaults.compaction, ...global.compaction, ...workspace.compaction },
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
  for (const variable of Object.keys(environment.gatewayCredentials).toSorted())
    entries.push({
      path: `gatewayCredentials.${variable}`,
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
  const environment = options.environment ?? { gatewayCredentials: {} }
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
      const variables = Object.values(settings.gateways)
        .flatMap((gateway) => (gateway.auth.type === "bearer-env" ? [gateway.auth.variable] : []))
        .filter((variable, index, all) => all.indexOf(variable) === index)
      const values = yield* Config.all({
        parallelApiKey: Config.option(Config.redacted("PARALLEL_API_KEY")),
        gatewayCredentials: Config.all(
          Object.fromEntries(variables.map((variable) => [variable, Config.option(Config.redacted(variable))])),
        ),
      })
      const environment: Environment =
        values.parallelApiKey._tag === "Some"
          ? { gatewayCredentials: {}, parallelApiKey: Redacted.make(Redacted.value(values.parallelApiKey.value)) }
          : { gatewayCredentials: {} }
      const completeEnvironment: Environment = {
        ...environment,
        gatewayCredentials: Object.fromEntries(
          Object.entries(values.gatewayCredentials).flatMap(([variable, value]) =>
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
