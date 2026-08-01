#!/usr/bin/env bun
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as WorkspaceIndex from "@rika/coding-tools/workspace-file-search"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import * as RelayExecution from "@rika/relay-execution/relay-execution-layer"
import { Cause, Context, Effect, FileSystem, Layer, PlatformError, Redacted, Schema } from "effect"

export const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

export const mkdir = (path: string, options?: { readonly recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, options)))

const workspaceGlobError = (workspace: string, method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "WorkspaceIndex",
    method,
    pathOrDescriptor: workspace,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

export const workspaceGlob = (workspace: string, pattern: string, maximumFiles: number) =>
  provideLayerScoped(BunServices.layer)(
    WorkspaceIndex.globOnce({ workspace, pattern, options: { pageSize: maximumFiles } }).pipe(
      Effect.map((result) => result.items.map((item) => item.relativePath)),
      Effect.mapError((error) => workspaceGlobError(workspace, error.operation, error)),
    ),
  )

class ModelConfigurationError extends Schema.TaggedErrorClass<ModelConfigurationError>()("ModelConfigurationError", {
  message: Schema.String,
}) {}

const webSearchProviderRegistry = WebSearchProvider.providerRegistry

export const validateWebSearchProviders = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => {
  const unsupportedIds = WebSearchProvider.configuredProviderFactories(credentials).unsupportedIds
  return unsupportedIds.length === 0
    ? Effect.void
    : ModelConfigurationError.make({
        message: `Unknown web search provider ${unsupportedIds.map((id) => `'${id}'`).join(", ")}`,
      })
}

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

export const route = {
  ...RelayExecution.route,
  configurationService: ConfigurationService,
  webSearchProviderRegistry,
  causeMessage: (cause: Cause.Cause<unknown>) => {
    const failure = Cause.squash(cause)
    return failure instanceof Error ? failure.message : String(failure)
  },
}
