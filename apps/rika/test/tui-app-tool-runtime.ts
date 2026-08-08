import { MediaAnalysisError, analyzerTestLayer } from "@rika/tools/media-view-service"
import * as ReadWebPage from "@rika/tools/read-web-page-service"
import * as ToolRuntime from "@rika/tools/coding-tool-runtime"
import * as WebSearch from "@rika/tools/web-search-service"
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
