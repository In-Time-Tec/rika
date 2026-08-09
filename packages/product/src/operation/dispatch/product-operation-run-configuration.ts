import { Context, Effect, FileSystem, Function, Layer, Option, Path } from "effect"
import * as ConfigOperations from "../contract/configuration-operation"
import * as ConfigurationService from "@rika/config/configuration-service"
import type { Input, OperationUnavailable } from "../contract/product-operation"
import type { ProductConfigOperations } from "./product-operation-integrations"
import type { ProductOperationRunFactory } from "./product-operation-run-branches"
const runConfigurationOperationImpl = (
  factory: ProductOperationRunFactory,
  input: Extract<Input, { readonly _tag: "Config" | "Doctor" | "Mcp" }>,
) =>
  Effect.gen(function* () {
    const typedConfigOperations: ProductConfigOperations | undefined = factory.options.configOperations
    if (typedConfigOperations === undefined || (input._tag === "Mcp" && input.action !== "doctor")) return
    const config =
      typedConfigOperations.forWorkspace === undefined
        ? typedConfigOperations
        : yield* typedConfigOperations
            .forWorkspace(input.clientWorkspace ?? factory.options.defaultWorkspace)
            .pipe(Effect.mapError((error) => unavailable(factory, input, String(error))))
    const context = yield* Layer.build(config.layer)
    const fileSystem = Option.getOrUndefined(Context.getOption(context, FileSystem.FileSystem)) ?? factory.fileSystem
    const path = Option.getOrUndefined(Context.getOption(context, Path.Path)) ?? factory.path
    if (fileSystem === undefined || path === undefined)
      return yield* unavailable(factory, input, "Configuration filesystem is unavailable")
    yield* ConfigOperations.run(input, config.options).pipe(
      Effect.provideService(ConfigOperations.Adapter, Context.get(context, ConfigOperations.Adapter)),
      Effect.provideService(
        ConfigurationService.ConfigurationService,
        Context.get(context, ConfigurationService.ConfigurationService),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((error) => unavailable(factory, input, String(error))),
    )
  }).pipe(Effect.scoped)

export const runConfigurationOperation: {
  (
    arg1: Extract<Input, { readonly _tag: "Config" | "Doctor" | "Mcp" }>,
  ): (arg0: ProductOperationRunFactory) => ReturnType<typeof runConfigurationOperationImpl>
  (
    arg0: ProductOperationRunFactory,
    arg1: Extract<Input, { readonly _tag: "Config" | "Doctor" | "Mcp" }>,
  ): ReturnType<typeof runConfigurationOperationImpl>
} = Function.dual(2, runConfigurationOperationImpl)

const unavailable = (factory: ProductOperationRunFactory, input: Input, message?: string): OperationUnavailable =>
  factory.unavailable(input, message ?? "Operation unavailable")
