import { expect, it } from "@effect/vitest"
import { ToolContext, ToolExecutor } from "@batonfx/core"
import { ChildRuns } from "@batonfx/runtime"
import { Effect, Layer } from "effect"
import { Response, Toolkit } from "effect/unstable/ai"
import * as ChildTools from "../src/baton-child-tools"

const executorLayer = Layer.mergeAll(
  ChildTools.handlerLayer(Toolkit.empty, ChildTools.rootSelections, Layer.empty),
  ToolContext.layerTest({
    signal: new AbortController().signal,
    emit: () => Effect.void,
    sessionId: "thread",
    runId: "root-run",
    rootRunId: "root-run",
    toolCallId: "test-call",
  }),
)

it.effect("keeps every product declaration paired with its parent-relative Baton child handler", () => {
  const invoked: Array<ChildRuns.Input> = []
  const children = ChildRuns.ChildRuns.of({
    invoke: (input) => {
      invoked.push(input)
      const result = { _tag: "Succeeded" as const, childRunId: `child-${input.toolCallId}`, text: "done", turns: 1 }
      return Effect.succeed({ _tag: "Success" as const, result, encodedResult: result })
    },
  })
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(executorLayer)
      yield* Effect.gen(function* () {
        const executor = yield* ToolExecutor.ToolExecutor
        for (const [index, [name, selection]] of Object.entries(ChildTools.selections).entries()) {
          const call = Response.makePart("tool-call", {
            id: `call-${index}`,
            name,
            params: { prompt: `prompt-${index}` },
            providerExecuted: false,
          })
          const result = yield* executor.execute({
            call,
            toolCallBatch: { calls: [call] },
            turn: 0,
            toolCallIndex: 0,
            agentName: "rika-root",
            sessionId: "thread",
          })
          expect(result._tag).toBe("Success")
          expect(invoked[index]).toEqual({
            parentRunId: "root-run",
            toolCallId: "test-call",
            selection,
            prompt: `prompt-${index}`,
          })
        }
        expect(Object.keys(ChildTools.tools)).toEqual(Object.keys(ChildTools.selections))
      }).pipe(Effect.provide(context))
    }),
  ).pipe(Effect.provideService(ChildRuns.ChildRuns, children))
})

it.effect("fails the child tool call with a framework failure outside the Baton execution host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(executorLayer)
      yield* Effect.gen(function* () {
        const executor = yield* ToolExecutor.ToolExecutor
        const call = Response.makePart("tool-call", {
          id: "call-detached",
          name: "oracle",
          params: { prompt: "prompt" },
          providerExecuted: false,
        })
        const failure = yield* Effect.flip(
          executor.execute({
            call,
            toolCallBatch: { calls: [call] },
            turn: 0,
            toolCallIndex: 0,
            agentName: "rika-root",
            sessionId: "thread",
          }),
        )
        expect(failure._tag).toBe("@batonfx/core/FrameworkFailure")
        expect(failure.message).toBe("child Agent tools require the Baton execution host")
      }).pipe(Effect.provide(context))
    }),
  ),
)
