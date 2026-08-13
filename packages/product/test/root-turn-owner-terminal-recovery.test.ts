import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { make } from "../src/thread/queue/root-turn-owner"

const link = { runId: "root-run", threadId: "thread", turnId: "turn" }

const turn: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("turn"),
  threadId: Thread.ThreadId.make("thread"),
  prompt: "work",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  executionLink: link,
  status: "running",
  createdAt: 0,
  updatedAt: 0,
}

it.effect("claims a terminal turn only while its recovered status still matches", () =>
  Effect.gen(function* () {
    let current: Turn.AgentExecutionTurn = { ...turn, status: "completed" }
    const owner = yield* make(
      { get: () => Effect.succeed(current) } as TurnRepository.Interface,
      {} as TranscriptRepository.Interface,
      {} as ExecutionGateway.Interface,
    )

    expect(yield* owner.claim(turn.id)).toBe(false)
    expect(yield* owner.claim(turn.id, "failed")).toBe(false)
    expect(yield* owner.claim(turn.id, "completed")).toBe(true)
    expect(yield* owner.release(turn.id)).toBe(false)

    current = { ...current, status: "failed" }
    expect(yield* owner.claim(turn.id, "completed")).toBe(false)
  }),
)

it.effect("settles a turn whose backend run is terminal when the watch stream yields no changes", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "completed" as const }),
      } as ExecutionGateway.Interface,
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("completed")
    expect(result.state.status).toBe("completed")
  }),
)

it.effect("settles from terminal inspection when the watch stream ends on a stale running projection", () =>
  Effect.gen(function* () {
    const running: ExecutionProjection.Change = {
      _tag: "ProjectionSnapshot",
      revision: 1,
      units: [],
      hasOlder: false,
      state: {
        status: "running",
        usage: ExecutionProjection.emptyUsageState(),
        steering: { steeringMessages: 0, followUpMessages: 0 },
      },
    }
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      {
        get: () => Effect.void,
        commitProjection: () => Effect.succeed("committed" as const),
      } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.succeed(running),
        inspectTurn: () => Effect.succeed({ status: "completed" as const }),
      } as ExecutionGateway.Interface,
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("completed")
    expect(result.state.status).toBe("completed")
  }),
)

it.effect("falls back to the persisted running status when the backend run is unavailable", () =>
  Effect.gen(function* () {
    const owner = yield* make(
      { get: () => Effect.succeed(turn) } as TurnRepository.Interface,
      { get: () => Effect.void } as TranscriptRepository.Interface,
      {
        watchTurn: () => Stream.empty,
        inspectTurn: () => Effect.succeed({ status: "unavailable" as const }),
      } as ExecutionGateway.Interface,
    )
    const result = yield* owner.watchTurn(turn.id)
    expect(result.status).toBe("running")
    expect(result.state.status).toBe("running")
  }),
)
