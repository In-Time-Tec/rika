import { AiError, LanguageModel } from "effect/unstable/ai"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ModelRegistry, TestModel } from "@rika/relay-execution/scripted-model-runtime"

export const model = {
  text: (text: string, delayMs?: number) =>
    TestModel.turn([TestModel.text(text)], delayMs === undefined ? {} : { delay: `${delayMs} millis` }),
  turn: TestModel.turn,
  part: TestModel.text,
  reasoning: TestModel.reasoning,
  toolCall: (name: string, params: unknown, id?: string) =>
    TestModel.toolCall(name, params, id === undefined ? {} : { id }),
  failure: (description: string) =>
    TestModel.failure(
      AiError.make({
        module: "TestModel",
        method: "streamText",
        reason: AiError.UnknownError.make({ description }),
      }),
    ),
}

export type Script = ReadonlyArray<Parameters<typeof TestModel.make>[0][number]>

export interface TuiAppLane {
  readonly when?: (prompt: string) => boolean
  readonly script: Script
}

export const makeRoutedModel = Effect.fn("TuiApp.makeRoutedModel")(function* (lanes: ReadonlyArray<TuiAppLane>) {
  const encodePrompt = Schema.encodeSync(Schema.UnknownFromJsonString)
  const fixtures = yield* Effect.forEach(lanes, (lane) =>
    TestModel.make([...lane.script], {
      metadata: {
        provider: "test",
        model: "scripted",
        contextWindow: 1_000_000,
        maxOutput: 1_000_000,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    }),
  )
  const services = yield* Effect.forEach(fixtures, (built) =>
    Layer.build(built.layer).pipe(Effect.map((context) => Context.get(context, LanguageModel.LanguageModel))),
  )
  const selectLane = (prompt: unknown) => {
    const text = encodePrompt(prompt)
    const index = lanes.findIndex((lane) => lane.when !== undefined && lane.when(text))
    return services[index < 0 ? 0 : index]!
  }
  const routedModel: LanguageModel.Service = {
    ...services[0]!,
    streamText: ((request: Parameters<LanguageModel.Service["streamText"]>[0]) =>
      Stream.unwrap(
        Effect.sync(() => selectLane(request.prompt).streamText(request)),
      )) as LanguageModel.Service["streamText"],
  }
  const fixture = fixtures[0]!
  const registration = yield* ModelRegistry.registration({
    ...fixture.selection,
    layer: Layer.succeed(LanguageModel.LanguageModel, routedModel),
    ...(fixture.registration.metadata === undefined ? {} : { metadata: fixture.registration.metadata }),
  })
  return { fixture, registration }
})
