import { AiError, ModelRegistry, Response as AiResponse } from "generalist"
import { TestModel } from "generalist/test"
import { Effect, Layer, Schema } from "effect"

const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    params: Schema.Unknown,
    id: Schema.optionalKey(Schema.String),
  }),
])

const Usage = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  outputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})

const Turn = Schema.Union([
  Schema.Struct({
    parts: Schema.NonEmptyArray(Part),
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    streamPartDelayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(Usage),
  }),
  Schema.Struct({
    object: Schema.Unknown,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    streamPartDelayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(Usage),
  }),
  Schema.Struct({
    failure: Schema.String,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    streamPartDelayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(Usage),
  }),
])

const Script = Schema.NonEmptyArray(Turn)

const steps = Effect.fn("ScriptedModel.steps")(function* (json: string) {
  const script = yield* Schema.decodeEffect(Schema.fromJsonString(Script))(json)
  return script.map((turn) => {
    const options: TestModel.StepOptions = {}
    if (turn.delayMs !== undefined) Object.assign(options, { delay: turn.delayMs })
    if (turn.streamPartDelayMs !== undefined)
      Object.assign(options, { streamPartDelay: `${turn.streamPartDelayMs} millis` })
    if (turn.usage !== undefined)
      Object.assign(options, {
        usage: AiResponse.Usage.make({
          inputTokens: {
            uncached: turn.usage.inputTokens,
            total: turn.usage.inputTokens,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: turn.usage.outputTokens,
            text: turn.usage.outputTokens,
            reasoning: undefined,
          },
        }),
      })
    if ("object" in turn) return TestModel.object(turn.object, options)
    if ("failure" in turn)
      return TestModel.failure(
        AiError.make({
          module: "rika/test-model",
          method: "streamText",
          reason: AiError.UnknownError.make({ description: turn.failure }),
        }),
        options,
      )
    return TestModel.turn(
      turn.parts.map((part) => {
        if (part.type === "text") return TestModel.text(part.text)
        if (part.type === "reasoning") return TestModel.reasoning(part.text)
        return TestModel.toolCall(part.name, part.params, part.id === undefined ? {} : { id: part.id })
      }),
      options,
    )
  })
})

export const layer = (input: {
  readonly script?: string
  readonly response?: string
}): Layer.Layer<ModelRegistry.ModelRegistry> =>
  Layer.unwrap(
    (input.script === undefined
      ? TestModel.make(
          Array.from({ length: 32 }, () => TestModel.text(input.response ?? "completed")),
          { provider: "test", model: "test", registrationKey: "test" },
        )
      : steps(input.script).pipe(
          Effect.flatMap((script) =>
            TestModel.make(script, { provider: "test", model: "test", registrationKey: "test" }),
          ),
        )
    ).pipe(
      Effect.map((fixture) =>
        ModelRegistry.layer([Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })]),
      ),
    ),
  ).pipe(Layer.orDie)
