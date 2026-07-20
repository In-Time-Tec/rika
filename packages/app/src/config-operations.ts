import { ConfigContract, ConfigService } from "@rika/config"
import { Console, Context, Effect, Layer, Schema } from "effect"

export class AdapterError extends Schema.TaggedErrorClass<AdapterError>()("ConfigOperationsAdapterError", {
  message: Schema.String,
}) {}

export interface AdapterInterface {
  readonly edit: (path: string) => Effect.Effect<void, AdapterError>
  readonly exists: (path: string) => Effect.Effect<boolean, AdapterError>
}

export class Adapter extends Context.Service<Adapter, AdapterInterface>()("@rika/app/config-operations/Adapter") {}

export interface Options {
  readonly globalConfigPath: string
  readonly workspaceConfigPath: string
  readonly productDatabasePath: string
  readonly relayDatabasePath: string
  readonly upstream: ReadonlyArray<{ readonly name: string; readonly present: boolean }>
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
  const configService = yield* ConfigService.Service
  const adapter = yield* Adapter
  const config = yield* configService.effective
  const route = ConfigContract.resolveModelRoute(config.settings, "medium")
  const providers = Object.fromEntries(
    Object.entries(config.settings.providers).map(([id, provider]) => [
      id,
      { baseUrl: provider.baseUrl, ...(provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: provider.apiKeyEnv }) },
    ]),
  )
  const apiKeyStatus = (apiKeyEnv: string | undefined) =>
    apiKeyEnv === undefined
      ? "not-configured"
      : config.environment.providerCredentials[apiKeyEnv] === undefined
        ? "missing"
        : "present"
  const providerApiKeys = Object.fromEntries(
    Object.entries(config.settings.providers).map(([id, provider]) => [id, apiKeyStatus(provider.apiKeyEnv)]),
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
          keymap: config.settings.keymap,
          permissions: config.settings.permissions,
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
          route: { alias: route.alias, providerId: route.providerId, model: route.model },
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
  const [productDatabase, relayDatabase] = yield* Effect.all([
    adapter.exists(options.productDatabasePath),
    adapter.exists(options.relayDatabasePath),
  ])
  yield* json({
    databases: { product: productDatabase ? "present" : "missing", relay: relayDatabase ? "present" : "missing" },
    upstream: Object.fromEntries(options.upstream.map(({ name, present }) => [name, present ? "present" : "missing"])),
    config: {
      diagnostics: config.diagnostics,
      global: (yield* adapter.exists(options.globalConfigPath)) ? "present" : "missing",
      workspace: (yield* adapter.exists(options.workspaceConfigPath)) ? "present" : "missing",
    },
    credentials: { webSearch: webSearchCredentials },
    model: {
      route: { alias: route.alias, providerId: route.providerId, model: route.model },
      apiKey: apiKeyStatus(route.providerConnection.apiKeyEnv),
    },
  })
})

export const testLayer = (adapter: AdapterInterface) => Layer.succeed(Adapter, Adapter.of(adapter))
