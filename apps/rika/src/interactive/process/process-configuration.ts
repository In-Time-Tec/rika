import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as ProductOperation from "@rika/product/product-operation"
import { Cause, Effect, FileSystem, Function, Schema } from "effect"

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
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
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
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  return typeof failure
}

const withClientWorkspaceImpl = (input: ProductOperation.Input, workspace: string): ProductOperation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Auth" ||
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
