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
  if (input._tag === "Mcp") {
    yield* json(
      Object.fromEntries(
        Object.entries(config.settings.mcp).map(([name, definition]) => [
          name,
          { transport: definition.transport, enabled: definition.enabled },
        ]),
      ),
    )
    return
  }
  if (input._tag === "Config") {
    if (input.action === "list") {
      yield* json({
        settings: config.settings,
        environment: { parallelApiKey: config.environment.parallelApiKey === undefined ? "missing" : "present" },
        model: {
          route,
          apiKey:
            route.gateway.auth.type === "none" ||
            config.environment.gatewayCredentials[route.gateway.auth.variable] !== undefined
              ? "present"
              : "missing",
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
    credentials: { parallel: config.environment.parallelApiKey === undefined ? "missing" : "present" },
    model: {
      route,
      apiKey:
        route.gateway.auth.type === "none" ||
        config.environment.gatewayCredentials[route.gateway.auth.variable] !== undefined
          ? "present"
          : "missing",
    },
  })
})

export const testLayer = (adapter: AdapterInterface) => Layer.succeed(Adapter, Adapter.of(adapter))
