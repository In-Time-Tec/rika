import { Console, Context, Effect, FileSystem, Function, Layer, Path } from "effect"
import * as ConfigOperations from "../contract/configuration-operation"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import type { Input, OperationUnavailable } from "../contract/product-operation"
import type { ProductConfigOperations } from "./product-operation-integrations"
const runConfigurationOperationImpl = (
  factory: any,
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
    yield* ConfigOperations.run(input, config.options).pipe(
      Effect.provideService(ConfigOperations.Adapter, Context.get(context, ConfigOperations.Adapter)),
      Effect.provideService(
        ConfigurationService.ConfigurationService,
        Context.get(context, ConfigurationService.ConfigurationService),
      ),
      Effect.provideService(FileSystem.FileSystem, Context.get(context, FileSystem.FileSystem)),
      Effect.provideService(Path.Path, Context.get(context, Path.Path)),
      Effect.provideService(Console.Console, globalThis.console),
      Effect.mapError((error) => unavailable(factory, input, String(error))),
    )
  }).pipe(Effect.scoped)

export const runConfigurationOperation: {
  (
    arg1: Extract<Input, { readonly _tag: "Config" | "Doctor" | "Mcp" }>,
  ): (arg0: any) => ReturnType<typeof runConfigurationOperationImpl>
  (
    arg0: any,
    arg1: Extract<Input, { readonly _tag: "Config" | "Doctor" | "Mcp" }>,
  ): ReturnType<typeof runConfigurationOperationImpl>
} = Function.dual(2, runConfigurationOperationImpl)

const unavailable = (factory: any, input: Input, message?: string): OperationUnavailable =>
  factory.unavailable(input, message ?? "Operation unavailable")
