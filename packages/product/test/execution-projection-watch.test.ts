import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { watch } from "../src/execution/lifecycle/execution-projection-watch"

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("stalled"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: { runId: "run", threadId: "thread", turnId: "stalled" },
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "running",
  createdAt: 1,
  updatedAt: 2,
}

it.effect("fails a running execution after its progress watchdog expires", () =>
  Effect.gen(function* () {
    let units: ReadonlyArray<import("@rika/transcript/transcript-unit").Unit> = []
    const transcripts = {
      get: () => Effect.as(Effect.void, undefined),
      replaceUnits: (_candidate: Turn.Turn, replacement: typeof units) =>
        Effect.sync(() => {
          units = replacement
          return undefined as never
        }),
    } as unknown as TranscriptRepository.Interface
    const backend = {
      watchTurn: () => Stream.never,
      inspectTurn: () => Effect.succeed({ status: "running" as const, cursor: "running" }),
    } as unknown as ExecutionGateway.Interface
    const fiber = yield* Effect.forkChild(
      watch({
        turnId: turn.id,
        turns: { get: () => Effect.succeed(turn) } as unknown as TurnRepository.Interface,
        transcripts,
        backend,
        stallSilenceMs: 1_000,
      }),
    )
    yield* TestClock.adjust("2 seconds")
    const result = yield* Fiber.join(fiber)

    expect(result.status).toBe("failed")
    expect(result.state.status).toBe("failed")
    expect(units).toHaveLength(1)
    expect(units[0]?.executionOutcome).toMatchObject({ status: "failed" })
    expect(units[0]?.content).toMatchObject({
      _tag: "Block",
      block: { _tag: "Error", category: "execution-stalled" },
    })
    expect(result.state.usage).toEqual(ExecutionProjection.emptyUsageState())
  }),
)
