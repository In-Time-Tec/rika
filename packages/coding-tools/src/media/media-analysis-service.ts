import { Context, Effect, Layer } from "effect"
import type { AnalysisInput } from "./media-view-contract"
import { MediaAnalysisError } from "./media-view-errors"

export interface AnalyzerInterface {
  readonly analyze: (input: AnalysisInput) => Effect.Effect<string, MediaAnalysisError>
}
export class MediaAnalyzer extends Context.Service<MediaAnalyzer, AnalyzerInterface>()(
  "@rika/coding-tools/media/media-analysis-service/MediaAnalyzer",
) {}
export const analyzerTestLayer = (analyze: AnalyzerInterface["analyze"]) =>
  Layer.succeed(MediaAnalyzer, MediaAnalyzer.of({ analyze }))
export const analyzerUnavailableLayer = analyzerTestLayer(() =>
  Effect.fail(MediaAnalysisError.make({ message: "Media analysis route is not configured" })),
)
