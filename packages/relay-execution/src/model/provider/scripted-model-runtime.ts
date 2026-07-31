import { AiError, Response as AiResponse } from "@batonfx/core"
import { Layer, Effect, FileSystem, Schema } from "effect"
import type { TestModel as TestModelTypes } from "@batonfx/test"

class ExternalBoundaryError extends Schema.TaggedErrorClass<ExternalBoundaryError>()("ExternalBoundaryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const testModelPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    params: Schema.Unknown,
    id: Schema.optionalKey(Schema.String),
  }),
])

const testModelUsageSchema = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  outputTokens: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})

const testModelTurnSchema = Schema.Union([
  Schema.Struct({
    parts: Schema.NonEmptyArray(testModelPartSchema),
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
  Schema.Struct({
    object: Schema.Unknown,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
  Schema.Struct({
    failure: Schema.String,
    delayMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    usage: Schema.optionalKey(testModelUsageSchema),
  }),
])

const testModelScriptSchema = Schema.NonEmptyArray(testModelTurnSchema)

export const parseTestModelScript = (json: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(testModelScriptSchema))(json)

export const buildTestModelScript: (
  json: string,
) => Effect.Effect<ReadonlyArray<TestModelTypes.Step>, ExternalBoundaryError | Schema.SchemaError> = Effect.fn(
  "Main.buildTestModelScript",
)(function* (json: string) {
  const script = yield* parseTestModelScript(json)
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  return script.map((turn) => {
    const options = {
      ...(turn.delayMs === undefined ? {} : { delay: turn.delayMs }),
      ...(turn.usage === undefined
        ? {}
        : {
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
          }),
    }
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

export const makeReloadingTestModel: (path: string) => Effect.Effect<any, unknown, any> = Effect.fn(
  "Main.makeReloadingTestModel",
)(function* (path: string) {
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  const load = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const script = yield* fileSystem.readFileString(path)
    return yield* TestModel.make(yield* buildTestModelScript(script))
  })
  const initial = yield* load
  return {
    ...initial,
    registration: {
      ...initial.registration,
      layer: Layer.unwrap(load.pipe(Effect.map((fixture) => fixture.registration.layer))),
    },
  }
})

export const makeScriptedModel = Effect.fn("ScriptedModelRuntime.makeScriptedModel")(function* (script: string) {
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  return yield* TestModel.make(yield* buildTestModelScript(script))
})

export const makeConstantModel = Effect.fn("ScriptedModelRuntime.makeConstantModel")(function* (text: string) {
  const { TestModel } = yield* Effect.tryPromise({
    try: () => import("@batonfx/test"),
    catch: (cause) => ExternalBoundaryError.make({ operation: "load test model", message: String(cause) }),
  })
  return yield* TestModel.make(Array.from({ length: 4 }, () => TestModel.text(text)))
})
