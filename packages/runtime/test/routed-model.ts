import { LanguageModel, ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Context, Effect, Layer, Schema, Stream } from "effect"

const encodePrompt = Schema.encodeSync(Schema.UnknownFromJsonString)

export interface Lane {
  readonly when?: (prompt: string) => boolean
  readonly steps: ReadonlyArray<TestModel.Step>
}

export interface RoutedModel {
  readonly registration: ModelRegistry.Registration
  readonly selection: ModelRegistry.ModelSelection
  readonly layer: Layer.Layer<LanguageModel.LanguageModel>
  readonly lanes: ReadonlyArray<TestModel.Fixture>
  readonly requests: Effect.Effect<ReadonlyArray<TestModel.Request>>
}

export const routedModel = (
  lanes: ReadonlyArray<Lane>,
  options?: { readonly provider?: string; readonly model?: string; readonly registrationKey?: string },
) =>
  Effect.gen(function* () {
    const fixtures = yield* Effect.forEach(lanes, (lane) => TestModel.make(lane.steps, options ?? {}))
    const services = yield* Effect.forEach(fixtures, (fixture) =>
      Layer.build(fixture.layer).pipe(Effect.map((context) => Context.get(context, LanguageModel.LanguageModel))),
    )
    const select = (prompt: unknown) => {
      const text = encodePrompt(prompt)
      const index = lanes.findIndex((lane) => lane.when !== undefined && lane.when(text))
      return services[index < 0 ? 0 : index]!
    }
    const model: LanguageModel.Service = {
      ...services[0]!,
      generateText: ((request: Parameters<LanguageModel.Service["generateText"]>[0]) =>
        select(request.prompt).generateText(request)) as LanguageModel.Service["generateText"],
      streamText: ((request: Parameters<LanguageModel.Service["streamText"]>[0]) =>
        Stream.unwrap(
          Effect.sync(() => select(request.prompt).streamText(request)),
        )) as LanguageModel.Service["streamText"],
    }
    const selection = fixtures[0]!.selection
    const layer = Layer.succeed(LanguageModel.LanguageModel, model)
    const registration = yield* ModelRegistry.registration({ ...selection, layer })
    const requests = Effect.forEach(fixtures, (fixture) => fixture.requests).pipe(
      Effect.map((collected) => collected.flat()),
    )
    return { registration, selection, layer, lanes: fixtures, requests } satisfies RoutedModel
  })
