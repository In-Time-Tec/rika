import { MediaAnalysisError, analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import { FetchHttpClient } from "effect/unstable/http"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Effect, Function, Layer, Option, Redacted } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import type * as ConfigurationSettings from "@rika/configuration/configuration-settings"

const defaultWorkspaceToolRuntimeLayerImpl = (
  workspace: string,
  effectiveConfig: (
    workspace: string,
  ) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, ExecutionBackend.BackendError, never>,
) =>
  Layer.unwrap(
    effectiveConfig(workspace).pipe(
      Effect.map((config) => {
        const credentials = config.environment.webSearchCredentials
        const readPageCredential = WebSearchProvider.configuredReadPageCredential(credentials)
        return ToolRuntime.layer(workspace).pipe(
          Layer.provide(
            analyzerTestLayer(() => Effect.fail(MediaAnalysisError.make({ message: "Media analysis is unavailable" }))),
          ),
          Layer.provide(
            Layer.merge(
              WebSearch.factoryLayer(WebSearchProvider.configuredProviderFactories(credentials).factories),
              ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
            ).pipe(Layer.provide(FetchHttpClient.layer)),
          ),
          Layer.provide(BunServices.layer),
        )
      }),
    ),
  ).pipe(Layer.orDie)

export const defaultWorkspaceToolRuntimeLayer: {
  (
    effectiveConfig: (
      workspace: string,
    ) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, ExecutionBackend.BackendError, never>,
  ): (workspace: string) => ReturnType<typeof defaultWorkspaceToolRuntimeLayerImpl>
  (
    workspace: string,
    effectiveConfig: (
      workspace: string,
    ) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, ExecutionBackend.BackendError, never>,
  ): ReturnType<typeof defaultWorkspaceToolRuntimeLayerImpl>
} = Function.dual(2, defaultWorkspaceToolRuntimeLayerImpl)

export const workspaceToolRuntimeLayer = (options: {
  readonly workspace: string
  readonly effectiveConfig: (
    workspace: string,
  ) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, ExecutionBackend.BackendError, never>
  readonly testMediaAnalyzerResponse: Option.Option<string>
  readonly testMediaAnalyzerError: Option.Option<string>
  readonly validate: (
    credentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  ) => Effect.Effect<void, ConfigurationService.WebProviderConfigurationError, never>
}) =>
  Layer.unwrap(
    options.effectiveConfig(options.workspace).pipe(
      Effect.flatMap((config) => {
        const credentials = config.environment.webSearchCredentials
        const readPageCredential = WebSearchProvider.configuredReadPageCredential(credentials)
        const mediaResponse = Option.getOrUndefined(options.testMediaAnalyzerResponse)
        const mediaError = Option.getOrUndefined(options.testMediaAnalyzerError)
        return options.validate(credentials).pipe(
          Effect.as(
            ToolRuntime.layer(options.workspace).pipe(
              Layer.provide(
                mediaResponse !== undefined
                  ? analyzerTestLayer(() => Effect.succeed(mediaResponse))
                  : analyzerTestLayer(() =>
                      Effect.fail(
                        MediaAnalysisError.make({
                          message: mediaError ?? "Media analysis is unavailable",
                        }),
                      ),
                    ),
              ),
              Layer.provide(
                Layer.merge(
                  WebSearch.factoryLayer(WebSearchProvider.configuredProviderFactories(credentials).factories),
                  ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                ).pipe(Layer.provide(FetchHttpClient.layer)),
              ),
              Layer.provide(BunServices.layer),
              Layer.catchCause((cause) =>
                Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) }))),
              ),
            ),
          ),
        )
      }),
      Effect.mapError((error) => ExecutionBackend.BackendError.make({ message: String(error) })),
    ),
  )
