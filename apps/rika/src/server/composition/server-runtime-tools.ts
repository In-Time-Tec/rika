import { MediaAnalysisError, analyzerTestLayer } from "@rika/tools/media-view-service"
import * as ReadWebPage from "@rika/tools/read-web-page-service"
import * as ToolRuntime from "@rika/tools/coding-tool-runtime"
import * as WebSearch from "@rika/tools/web-search-service"
import * as WebSearchProvider from "@rika/tools/web-search-provider"
import { FetchHttpClient } from "effect/unstable/http"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Effect, Function, Layer, Option, Redacted } from "effect"
import * as ConfigurationService from "@rika/config/configuration-service"
import type * as ConfigurationSettings from "@rika/config/configuration-settings"
import { OperationProductError } from "./server-auth-layer"

const defaultWorkspaceToolRuntimeLayerImpl = <E>(
  workspace: string,
  effectiveConfig: (workspace: string) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, E, never>,
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
  <E>(
    effectiveConfig: (workspace: string) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, E, never>,
  ): (workspace: string) => ReturnType<typeof defaultWorkspaceToolRuntimeLayerImpl>
  <E>(
    workspace: string,
    effectiveConfig: (workspace: string) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, E, never>,
  ): ReturnType<typeof defaultWorkspaceToolRuntimeLayerImpl>
} = Function.dual(2, defaultWorkspaceToolRuntimeLayerImpl)

export const workspaceToolRuntimeLayer = <E>(options: {
  readonly workspace: string
  readonly effectiveConfig: (workspace: string) => Effect.Effect<ConfigurationSettings.EffectiveConfiguration, E, never>
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
                Layer.effectContext(Effect.fail(OperationProductError.make({ message: Cause.pretty(cause) }))),
              ),
            ),
          ),
        )
      }),
      Effect.mapError((error) => OperationProductError.make({ message: String(error) })),
    ),
  )
