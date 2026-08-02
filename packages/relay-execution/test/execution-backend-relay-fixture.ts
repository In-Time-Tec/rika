import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { ModelRegistry } from "@batonfx/core"
import type { TestModel as TestModelTypes } from "@batonfx/test"
import { AiError, LanguageModel, Prompt, Response, Tool } from "effect/unstable/ai"

import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"

const executionModelRoute = (
  role: "main" | "oracle",
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
): ExecutionRouteSnapshot.ExecutionRouteModelSnapshot => ({
  role,
  alias: role,
  model: selection.model,
  providerConnection: {
    provider: selection.provider,
    protocol: "test",
    baseUrl: "test://model",
    authentication: "none",
  },
  registrationIdentity: modelRegistrationIdentity(selection.registrationKey ?? role),
  effort: "medium",
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 50 },
})

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const testModelRegistration = (registration: ModelRegistry.Registration): ModelRegistry.Registration => ({
  ...registration,
  toolJsonSchemaCompiler: (tool: Tool.Any) => Effect.succeed(Tool.getJsonSchema(tool)),
})

const rawScriptedModel = Effect.fn("RawScriptedModel.make")(function* (
  script: ReadonlyArray<TestModelTypes.Step>,
  selection: ModelRegistry.ModelSelection,
): Effect.fn.Return<TestModelTypes.Fixture> {
  const state = yield* SubscriptionRef.make({ cursor: 0, requests: [] as Array<TestModelTypes.Request> })
  function streamText(
    options: Omit<LanguageModel.GenerateTextOptions<{}>, "toolkit"> & { readonly toolkit?: undefined },
  ): Stream.Stream<Response.StreamPart<{}>, AiError.AiError>
  function streamText<Tools extends Record<string, Tool.Any>>(
    options: LanguageModel.GenerateTextOptions<Tools> & { readonly toolkit: LanguageModel.ToolkitInput<Tools> },
  ): Stream.Stream<Response.StreamPart<Tools>, AiError.AiError>
  function streamText<Tools extends Record<string, Tool.Any>>(options: LanguageModel.GenerateTextOptions<Tools>) {
    return Stream.unwrap(
      Effect.gen(function* () {
        const claimed = yield* SubscriptionRef.modify(state, (current) => {
          const step = script[current.cursor]
          const request: TestModelTypes.Request = {
            index: current.requests.length,
            operation: "streamText",
            prompt: Prompt.make(options.prompt),
            tools: [],
            toolChoice: options.toolChoice ?? "auto",
            responseFormat: { type: "text" },
            previousResponseId: undefined,
            incrementalPrompt: undefined,
          }
          return [
            { step, request },
            { cursor: Math.min(script.length, current.cursor + 1), requests: [...current.requests, request] },
          ]
        })
        if (claimed.step === undefined) return yield* Effect.die("raw scripted fixture exhausted")
        const step = claimed.step
        if (step._tag === "Turn" || step._tag === "Truncated" || step._tag === "Failure")
          if (step.delay !== undefined) yield* Effect.sleep(step.delay)
        if (step._tag === "Failure") return yield* step.error
        if (step._tag === "Object") return yield* Effect.die("raw scripted fixture does not support objects")
        const parts: Array<Response.StreamPart<Tools>> = []
        const append = (part: TestModelTypes.Part) => {
          if (part._tag === "Text") {
            const id = `raw-text-${claimed.request.index}`
            parts.push(Response.makePart("text-start", { id }))
            parts.push(Response.makePart("text-delta", { id, delta: part.text }))
            parts.push(Response.makePart("text-end", { id }))
          } else if (part._tag === "Reasoning") {
            const id = `raw-reasoning-${claimed.request.index}`
            parts.push(Response.makePart("reasoning-start", { id }))
            parts.push(Response.makePart("reasoning-delta", { id, delta: part.text }))
            parts.push(Response.makePart("reasoning-end", { id }))
          } else {
            parts.push(
              Response.makePart("tool-call", {
                id: part.id ?? `raw-tool-${claimed.request.index}`,
                name: part.name,
                params: part.params,
                providerExecuted: part.providerExecuted,
              }) as Response.StreamPart<Tools>,
            )
          }
        }
        if (step._tag === "Turn") for (const part of step.parts) append(part)
        else if (step._tag === "Truncated") for (const part of step.parts) append(part)
        else append(step)
        if (step._tag !== "Truncated")
          parts.push(
            Response.makePart("finish", {
              reason:
                step._tag === "Turn" && step.parts.some((part) => part._tag === "ToolCall") ? "tool-calls" : "stop",
              usage: Response.Usage.make({
                inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              }),
              response: undefined,
            }),
          )
        return Stream.fromIterable(parts)
      }),
    )
  }
  const service = {
    generateText: () => Effect.die("raw scripted fixture only supports streamText"),
    generateObject: () => Effect.die("raw scripted fixture only supports streamText"),
    streamText,
  } satisfies LanguageModel.Service
  const layer = Layer.succeed(LanguageModel.LanguageModel, service)
  const registration = yield* ModelRegistry.registration({
    ...selection,
    layer,
    toolJsonSchemaCompiler: (tool: Tool.Any) => Effect.succeed(Tool.getJsonSchema(tool)),
  })
  const requests = SubscriptionRef.get(state).pipe(Effect.map((current) => current.requests))
  return {
    layer,
    selection,
    registration,
    registryLayer: ModelRegistry.layerMemory([Effect.succeed(registration)]),
    requests,
    prompts: requests.pipe(Effect.map((items) => items.map((item) => item.prompt))),
    remaining: SubscriptionRef.get(state).pipe(Effect.map((current) => Math.max(0, script.length - current.cursor))),
    awaitRequests: (count) =>
      requests.pipe(
        Effect.flatMap((items) => (items.length >= count ? Effect.succeed(items) : Effect.die("request wait"))),
      ),
  }
})

const decodeToolExecution = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      tool_execution: Schema.optional(
        Schema.Struct({ concurrency: Schema.Union([Schema.Finite, Schema.Literal("unbounded")]) }),
      ),
    }),
  ),
)

export const fixture: {
  readonly executionModelRoute: typeof executionModelRoute
  readonly provide: typeof provide
  readonly runNative: typeof runNative
  readonly encodeJson: typeof encodeJson
  readonly decodeToolExecution: typeof decodeToolExecution
  readonly testModelRegistration: typeof testModelRegistration
  readonly rawScriptedModel: typeof rawScriptedModel
} = {
  executionModelRoute,
  provide,
  runNative,
  encodeJson,
  decodeToolExecution,
  testModelRegistration,
  rawScriptedModel,
}
