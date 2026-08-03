import { describe, expect, it } from "@effect/vitest"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import { Deferred, Effect, Layer, PubSub } from "effect"
import type { InteractiveEvent } from "../src/operation/interactive/interactive-event"
import {
  isMissingExecutionRuntimeService,
  makeInteractiveSupervision,
  missingExecutionRuntimeServiceMessage,
} from "../src/operation/interactive/interactive-session-supervision"

describe("interactive execution supervision", () => {
  it.effect("surfaces a missing runtime service as a terminal actionable failure without retrying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(
          isMissingExecutionRuntimeService({
            message: "Service not found: @rika/relay-execution/model/provider/model-provider-runtime/Service",
          }),
        ).toBe(true)
        const turn = {
          _tag: "AgentExecution",
          id: "missing-runtime-turn",
          threadId: "missing-runtime-thread",
          status: "running",
          lastCursor: undefined,
          executionRoute: {},
        } as any
        const statuses = new Array<string>()
        const events = new Array<InteractiveEvent>()
        const delivered = yield* Deferred.make<void>()
        let notifications = 0
        let observations = 0
        const backend = ExecutionBackend.Service.of({
          follow: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
        } as any)
        const turns = TurnRepository.Service.of({
          listStopRequested: Effect.succeed([]),
          listNonterminal: Effect.succeed([turn]),
          get: () => Effect.succeed(turn),
        } as any)
        const transcripts = TranscriptRepository.Service.of({
          listProjectionRecoveryCandidates: () => Effect.succeed([]),
        } as any)
        const executionDependencies = yield* Layer.build(
          Layer.mergeAll(
            Layer.succeed(ExecutionBackend.Service, backend),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(TranscriptRepository.Service, transcripts),
          ),
        )
        const turnChanges = yield* PubSub.unbounded<void>()
        const supervise = makeInteractiveSupervision({
          acquiredBackend: backend,
          executionDependencies,
          turnChanges,
          dirtyTurnObservers: new Set(),
          ensureIngest: () => Effect.void,
          setTurnStatus: (_id: string, status: string) =>
            Effect.sync(() => {
              statuses.push(status)
              return { ...turn, status }
            }),
          isTerminalStatus: (status: string) => ["completed", "failed", "cancelled"].includes(status),
          executionIngest: undefined,
          notifyTurnChanged: () =>
            Effect.sync(() => {
              notifications += 1
            }),
          claimTurnObserver: () => Effect.succeed(true),
          observeTurn: () => {
            observations += 1
            return Effect.fail(
              ExecutionBackend.BackendError.make({
                message: "Service not found: @rika/relay-execution/model/provider/model-provider-runtime/Service",
              }),
            )
          },
          registerPromoter: true,
          sessionThreadViews: new Map(),
          sessionId: 1,
          getSelectedThreadId: () => String(turn.threadId),
          interactiveSinks: new Map(),
          operationFeed: {
            emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => dispatch(event),
            sessionDispatch: (event: InteractiveEvent) => {
              events.push(event)
              Deferred.doneUnsafe(delivered, Effect.void)
            },
          },
        })

        yield* Effect.forkScoped(supervise as Effect.Effect<void>)
        yield* Deferred.await(delivered)

        expect(observations).toBe(1)
        expect(statuses).toEqual(["failed"])
        expect(notifications).toBe(0)
        expect(events).toContainEqual({
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          message: missingExecutionRuntimeServiceMessage,
        })
      }),
    ),
  )
})
