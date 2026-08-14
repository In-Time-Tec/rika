import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Effect, Stream } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"

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

it.effect("passes one opaque execution link through all gateway operations", () =>
  Effect.gen(function* () {
    const observed = new Array<unknown>()
    const gateway = ExecutionGateway.Service.of({
      startTurn: (input) => Effect.sync(() => (observed.push(["start", input.turnId]), link)),
      watchTurn: (received, cursor) => {
        observed.push(["watch", received, cursor])
        return Stream.empty
      },
      cancelTurn: (received) => Effect.sync(() => void observed.push(["cancel", received])),
      steerTurn: (received, input) =>
        Effect.sync(() => {
          observed.push(["steer", received, input])
          return { entryId: "steering-1", sequence: 0 }
        }),
      approveTurn: (received, input) => Effect.sync(() => void observed.push(["approve", received, input])),
      denyTurn: (received, input) => Effect.sync(() => void observed.push(["deny", received, input])),
      inspectTurn: (received) =>
        Effect.sync(() => (observed.push(["inspect", received]), { status: "running", cursor: "opaque-cursor" })),
    })
    const started = yield* gateway.startTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      workspace: "/workspace",
      prompt: "work",
      executionRoute: {} as never,
    })
    yield* gateway
      .watchTurn(started, {
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "opaque-cursor", state: "{}" },
      })
      .pipe(Stream.runDrain)
    yield* gateway.steerTurn(started, { text: "adjust", idempotencyKey: "steer-1" })
    const authorization = {
      authorizationId: "authorization",
      checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "opaque-cursor", state: "{}" },
    }
    yield* gateway.approveTurn(started, authorization)
    yield* gateway.denyTurn(started, authorization)
    yield* gateway.cancelTurn(started, "Cancelled by user")
    yield* gateway.inspectTurn(started)
    expect(observed).toEqual([
      ["start", "turn-1"],
      [
        "watch",
        link,
        { checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "opaque-cursor", state: "{}" } },
      ],
      ["steer", link, { text: "adjust", idempotencyKey: "steer-1" }],
      ["approve", link, authorization],
      ["deny", link, authorization],
      ["cancel", link],
      ["inspect", link],
    ])
  }),
)
