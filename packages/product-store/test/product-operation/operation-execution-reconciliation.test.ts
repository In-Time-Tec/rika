import { expect, it } from "@effect/vitest"
import * as ExecutionAuthorityReconciliation from "@rika/product/execution-authority-reconciliation"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "../../src/turn/memory-turn-repository"
import { Effect, Ref, Stream } from "effect"
import { executionRoute } from "../support/product-test-current-state"
import { turnProvenance } from "../support/operation-selection-fixtures"

const staleStatuses = ["accepted", "accepted", "running", "waiting", "cancelling"] as const
const staleTurns = staleStatuses.map((status, index): Turn.AgentExecutionTurn => {
  const id = Turn.TurnId.make(`stale-${index}`)
  return {
    ...turnProvenance,
    id,
    threadId: Thread.ThreadId.make(`thread-${index}`),
    prompt: `stale prompt ${index}`,
    executionRoute: executionRoute(),
    ...(index === 0 ? {} : { executionLink: { runId: `missing-${index}`, turnId: id, threadId: `thread-${index}` } }),
    status,
    createdAt: index + 1,
    updatedAt: index + 1,
  }
})

const makeBackend = (status: { readonly _tag: "unavailable" } | { readonly _tag: "running" }) =>
  Effect.gen(function* () {
    const inspectCount = yield* Ref.make(0)
    const cancelCount = yield* Ref.make(0)
    const backend = ExecutionGateway.Service.of({
      ...ExecutionGateway.makeTest(),
      startTurn: (input) =>
        Effect.succeed({ runId: `started-${input.turnId}`, turnId: input.turnId, threadId: input.threadId }),
      cancelTurn: () => Ref.update(cancelCount, (count) => count + 1),
      steerTurn: () => Effect.succeed({ entryId: "test-steering", sequence: 0 }),
      approveTurn: () => Effect.void,
      denyTurn: () => Effect.void,
      watchTurn: () => Stream.empty,
      inspectTurn: () =>
        Ref.updateAndGet(inspectCount, (count) => count + 1).pipe(
          Effect.as(
            status._tag === "unavailable"
              ? ({ status: "unavailable" } as const)
              : ({ status: "running", cursor: "synthetic-running-cursor" } as const),
          ),
        ),
    })
    return { inspectCount, cancelCount, backend }
  })

it.effect("leaves stale Turns blocked when durable execution evidence is missing", () =>
  Effect.gen(function* () {
    const turns = yield* TurnRepository.makeMemory(staleTurns)
    const { inspectCount, backend } = yield* makeBackend({ _tag: "unavailable" })
    const reconcile = () =>
      ExecutionAuthorityReconciliation.make({
        turns,
        backend,
        setTurnStatus: (id, status, now) => turns.setStatus(id, status, now),
      })

    const first = yield* reconcile()
    expect(first.active.map((turn) => turn.id)).toEqual(staleTurns.slice(1).map((turn) => turn.id))
    expect(first.settledThreads).toEqual([])
    expect((yield* Effect.forEach(staleTurns, (turn) => turns.get(turn.id))).map((turn) => turn?.status)).toEqual([
      "accepted",
      "accepted",
      "running",
      "waiting",
      "cancelling",
    ])
    const inspected = yield* Ref.get(inspectCount)
    expect(inspected).toBe(4)

    const second = yield* reconcile()
    expect(second.active.map((turn) => turn.id)).toEqual(staleTurns.slice(1).map((turn) => turn.id))
    expect(second.settledThreads).toEqual([])
    expect(yield* Ref.get(inspectCount)).toBe(inspected + 4)
  }),
)

it.effect("leaves live durable executions active and never cancels them during reconciliation", () =>
  Effect.gen(function* () {
    const live = staleTurns[0]!
    const turns = yield* TurnRepository.makeMemory([
      { ...live, status: "running", executionLink: { runId: "live-run", turnId: live.id, threadId: live.threadId } },
    ])
    const { cancelCount, backend } = yield* makeBackend({ _tag: "running" })
    const result = yield* ExecutionAuthorityReconciliation.make({
      turns,
      backend,
      setTurnStatus: (id, status, now) => turns.setStatus(id, status, now),
    })
    expect(result.active.map((turn) => String(turn.id))).toEqual([String(live.id)])
    expect((yield* turns.get(live.id))?.status).toBe("running")
    expect(yield* Ref.get(cancelCount)).toBe(0)
  }),
)
