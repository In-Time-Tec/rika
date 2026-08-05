import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Effect, Stream } from "effect"

const link = { runId: "opaque", turnId: "turn-1", threadId: "thread-1" }

it.layer(
  ExecutionGateway.layerTest({
    inspectTurn: () => Effect.succeed({ status: "running", cursor: "opaque-cursor" }),
  }),
)("ExecutionGateway test layer", (test) => {
  test.effect("provides deterministic test overrides", () =>
    Effect.gen(function* () {
      const execution = yield* ExecutionGateway.Service
      const inspection = yield* execution.inspectTurn(link)
      expect(inspection.status).toBe("running")
      expect(inspection.cursor).toBe("opaque-cursor")
    }),
  )
})

it.effect("passes one opaque execution link through the five gateway operations", () =>
  Effect.gen(function* () {
    const observed = new Array<unknown>()
    const gateway = ExecutionGateway.Service.of({
      startTurn: (input) => Effect.sync(() => (observed.push(["start", input.turnId]), link)),
      watchTurn: (received, cursor) => {
        observed.push(["watch", received, cursor])
        return Stream.empty
      },
      cancelTurn: (received) => Effect.sync(() => void observed.push(["cancel", received])),
      steerTurn: (received, input) => Effect.sync(() => void observed.push(["steer", received, input])),
      inspectTurn: (received) => Effect.sync(() => (observed.push(["inspect", received]), { status: "running" })),
    })
    const started = yield* gateway.startTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      workspace: "/workspace",
      prompt: "work",
      executionRoute: {} as never,
    })
    yield* gateway.watchTurn(started, "opaque-cursor").pipe(Stream.runDrain)
    yield* gateway.steerTurn(started, { text: "adjust", idempotencyKey: "steer-1" })
    yield* gateway.cancelTurn(started)
    yield* gateway.inspectTurn(started)
    expect(observed).toEqual([
      ["start", "turn-1"],
      ["watch", link, "opaque-cursor"],
      ["steer", link, { text: "adjust", idempotencyKey: "steer-1" }],
      ["cancel", link],
      ["inspect", link],
    ])
  }),
)
