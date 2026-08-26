import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as ProductOperation from "@rika/product/product-operation"
import { Cause, Effect, FileSystem, Function, Option, Schema } from "effect"

export const loadSettingsFile = Effect.fn("Main.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(
      Effect.mapError((error) =>
        SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({ path: filename, message: String(error) }),
      ),
    )
  const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError((error) =>
      SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
        path: filename,
        message: `Invalid JSON: ${String(error)}`,
      }),
    ),
  )
  return SettingsDecoder.Decoder.decodeSettingsInput(filename, value)
})

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) return failure.name
  const tagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))(failure)
  return Option.isSome(tagged) ? tagged.value._tag : "Unknown"
}

const withClientWorkspaceImpl = (input: ProductOperation.Input, workspace: string): ProductOperation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Doctor" ||
    input._tag === "Thread"
  )
    return { ...input, clientWorkspace: workspace }
  return input
}

export const withClientWorkspace: {
  (workspace: string): (input: ProductOperation.Input) => ProductOperation.Input
  (input: ProductOperation.Input, workspace: string): ProductOperation.Input
} = Function.dual(2, withClientWorkspaceImpl)
