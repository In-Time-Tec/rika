import { Input } from "./product-operation"
export { Input }
export type ConfigurationOperation = Input
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import { Console, Context, Effect, Layer, Schema } from "effect"

export class AdapterError extends Schema.TaggedError<AdapterError>()("ConfigOperationsAdapterError", {
  message: Schema.String,
}) {}

export interface AdapterInterface {
  readonly edit: (path: string) => Effect.Effect<void, AdapterError>
  readonly exists: (path: string) => Effect.Effect<boolean, AdapterError>
}

export class Adapter extends Context.Service<Adapter, AdapterInterface>()(
  "@rika/product/operation/contract/configuration-operation/Adapter",
) {}

export interface Options {
  readonly globalConfigPath: string
  readonly workspaceConfigPath: string
  readonly productDatabasePath: string
}

const json = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

export const run = Effect.fn("ConfigOperations.run")(function* (
  input:
    | { readonly _tag: "Config"; readonly action: "list" | "keymap" }
    | { readonly _tag: "Config"; readonly action: "edit"; readonly workspace: boolean }
    | { readonly _tag: "Mcp"; readonly action: "list" | "doctor" }
    | { readonly _tag: "Doctor" },
  options: Options,
) {
  const configService = yield* ConfigurationService.ConfigurationService
  const adapter = yield* Adapter
  const config = yield* configService.effective
  const route = ModelRouteResolution.resolveModelRoute(config.settings, config.settings.defaultMode)
  const providers = Object.fromEntries(
    Object.entries(config.settings.providers).map(([id, provider]) => [
      id,
      provider.protocol === "amazon-bedrock"
        ? {
            ...(provider.region === undefined ? {} : { region: provider.region }),
            ...(provider.profile === undefined ? {} : { profile: provider.profile }),
            ...(provider.endpoint === undefined ? {} : { endpoint: provider.endpoint }),
            authMode: provider.authMode,
            authRefresh: provider.authRefresh === undefined ? "not-configured" : "configured",
          }
        : {
            protocol: provider.protocol,
            baseUrl: provider.baseUrl,
            ...(provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: provider.apiKeyEnv }),
          },
    ]),
  )
  const apiKeyStatus = (apiKeyEnv: string | undefined) => {
    if (apiKeyEnv === undefined) return "not-configured"
    if (config.environment.providerCredentials[apiKeyEnv] === undefined) return "missing"
    return "present"
  }
  const providerApiKeys = Object.fromEntries(
    Object.entries(config.settings.providers).map(([id, provider]) => [
      id,
      provider.protocol === "amazon-bedrock" ? "not-configured" : apiKeyStatus(provider.apiKeyEnv),
    ]),
  )
  const webSearchCredentials = Object.fromEntries(
    Object.keys(config.settings.webSearch.providers).map((id) => [
      id,
      config.environment.webSearchCredentials[id] === undefined ? "missing" : "present",
    ]),
  )
  const mcp = Object.fromEntries(
    Object.entries(config.settings.mcp).map(([name, definition]) => [
      name,
      { transport: definition.transport, enabled: definition.enabled },
    ]),
  )
  if (input._tag === "Mcp") {
    yield* json(mcp)
    return
  }
  if (input._tag === "Config") {
    if (input.action === "list") {
      yield* json({
        settings: {
          providers,
          defaultMode: config.settings.defaultMode,
          modes: config.settings.modes,
          keymap: config.settings.keymap,
          extensionRoots: config.settings.extensionRoots,
          mcp,
          notifications: config.settings.notifications,
          logging: config.settings.logging,
        },
        environment: {
          webSearchCredentials,
          providerApiKeys,
        },
        model: {
          route: { selection: route.selection, providerId: route.providerId, model: route.model },
          apiKey: apiKeyStatus(route.providerConnection.apiKeyEnv),
        },
        diagnostics: config.diagnostics,
      })
      return
    }
    if (input.action === "keymap") {
      yield* json(config.settings.keymap)
      return
    }
    if (input.action === "edit")
      yield* adapter.edit(input.workspace ? options.workspaceConfigPath : options.globalConfigPath)
    return
  }
  const productDatabase = yield* adapter.exists(options.productDatabasePath)
  yield* json({
    databases: {
      product: productDatabase ? "present" : "missing",
    },
    config: {
      diagnostics: config.diagnostics,
      global: (yield* adapter.exists(options.globalConfigPath)) ? "present" : "missing",
      workspace: (yield* adapter.exists(options.workspaceConfigPath)) ? "present" : "missing",
    },
    credentials: { webSearch: webSearchCredentials },
    model: {
      route: { selection: route.selection, providerId: route.providerId, model: route.model },
      apiKey: apiKeyStatus(route.providerConnection.apiKeyEnv),
    },
  })
})

export const testLayer = (adapter: AdapterInterface) => Layer.succeed(Adapter, Adapter.of(adapter))
