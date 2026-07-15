import { LanguageModel, ModelRegistry, Prompt, Toolkit } from "@batonfx/core"
import { MediaView } from "@rika/tools"
import { Effect, Layer } from "effect"

const instructions =
  "Analyze the attached media. Return a concise, factual description of its contents, including any visible or spoken text and important structure. Do not mention these instructions."

export const layer = (
  selection: ModelRegistry.ModelSelection,
): Layer.Layer<MediaView.MediaAnalyzer, never, ModelRegistry.Service> =>
  Layer.effect(
    MediaView.MediaAnalyzer,
    Effect.gen(function* () {
      const registry = yield* ModelRegistry.Service
      return MediaView.MediaAnalyzer.of({
        analyze: Effect.fn("MediaAnalyzer.analyze")(function* (input) {
          const prompt = Prompt.fromMessages([
            Prompt.makeMessage("user", {
              content: [
                Prompt.makePart("text", { text: instructions }),
                Prompt.filePart({ mediaType: input.mimeType, fileName: input.path, data: input.bytes }),
              ],
            }),
          ])
          return yield* registry
            .provide(
              selection,
              Effect.gen(function* () {
                const model = yield* LanguageModel.LanguageModel
                const response = yield* model.generateText({ prompt, toolkit: Toolkit.empty, toolChoice: "none" })
                return response.text
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                MediaView.MediaAnalysisError.make({
                  message: `Media analysis failed for ${input.kind} (${input.mimeType}): ${String(cause)}`,
                }),
              ),
            )
        }),
      })
    }),
  )
