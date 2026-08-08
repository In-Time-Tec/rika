#!/usr/bin/env bun
import * as SettingsDecoder from "@rika/config/configuration-settings"
import * as ConfigurationService from "@rika/config/configuration-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as WorkspaceIndex from "@rika/tools/workspace-file-search"
import * as WebSearchProvider from "@rika/tools/web-search-provider"
import { Cause, Context, Effect, FileSystem, Function, Layer, PlatformError, Redacted, Schema } from "effect"

export { adapter as productConfigAdapter } from "./server-product-config"

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

const mkdirImpl = (path: string, options?: { readonly recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.makeDirectory(path, options)))
export const mkdir: {
  (options?: { readonly recursive?: boolean }): (path: string) => ReturnType<typeof mkdirImpl>
  (path: string, options?: { readonly recursive?: boolean }): ReturnType<typeof mkdirImpl>
} = Function.dual((args) => typeof args[0] === "string", mkdirImpl)

const workspaceGlobError = (workspace: string, method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "WorkspaceIndex",
    method,
    pathOrDescriptor: workspace,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

const workspaceGlobImpl = (workspace: string, pattern: string, maximumFiles: number) =>
  provideLayerScoped(BunServices.layer)(
    WorkspaceIndex.globOnce({ workspace, pattern, options: { pageSize: maximumFiles } }).pipe(
      Effect.map((result) => result.items.map((item) => item.relativePath)),
      Effect.mapError((error) => workspaceGlobError(workspace, error.operation, error)),
    ),
  )
export const workspaceGlob: {
  (pattern: string, maximumFiles: number): (workspace: string) => ReturnType<typeof workspaceGlobImpl>
  (workspace: string, pattern: string, maximumFiles: number): ReturnType<typeof workspaceGlobImpl>
} = Function.dual(3, workspaceGlobImpl)

const webSearchProviderRegistry = WebSearchProvider.providerRegistry

export const validateWebSearchProviders = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => {
  const unsupportedIds = WebSearchProvider.configuredProviderFactories(credentials).unsupportedIds
  return unsupportedIds.length === 0
    ? Effect.void
    : ConfigurationService.WebProviderConfigurationError.make({
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
  configurationService: ConfigurationService,
  webSearchProviderRegistry,
  causeMessage: (cause: Cause.Cause<unknown>) => {
    const failure = Cause.squash(cause)
    return failure instanceof Error ? failure.message : String(failure)
  },
}
