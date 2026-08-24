import { MediaAnalysisError, analyzerTestLayer } from "@rika/coding-tools/media-view-service"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as BunServices from "@effect/platform-bun/BunServices"

export const tuiToolRuntimeLayer = (directory: string) =>
  ToolRuntime.layer(directory).pipe(
    Layer.provide(
      analyzerTestLayer(() => Effect.fail(MediaAnalysisError.make({ message: "Media analysis is unavailable" }))),
    ),
    Layer.provide(
      Layer.merge(WebSearch.factoryLayer([]), ReadWebPage.layer({})).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
    Layer.provide(BunServices.layer),
    Layer.orDie,
  )
