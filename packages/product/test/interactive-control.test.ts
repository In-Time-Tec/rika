import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import type * as RootTurnOwner from "@rika/product/root-turn-owner"
import { Effect } from "effect"
import { makeInteractiveControl } from "../src/operation/interactive/interactive-control"
import { operationError } from "../src/operation/operation-error"
import type * as TurnQueue from "../src/thread/repository/turn-repository-queue"

const threadId = Thread.ThreadId.make("steering-control-thread")
const route = ExecutionRouteSnapshot.testExecutionRoute()
const active: Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Turn.TurnId.make("steering-control-active"),
  threadId,
  prompt: "active",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: route,
  executionLink: { runId: "steering-control-run", turnId: "steering-control-active", threadId },
  status: "running",
  createdAt: 1,
  updatedAt: 1,
}
const queued: Turn.AgentExecutionTurn = {
  ...active,
  id: Turn.TurnId.make("steering-control-queued"),
  prompt: "queued steering",
  executionLink: undefined,
  status: "queued",
  createdAt: 2,
  updatedAt: 2,
}

it.effect("does not replay a persisted queued-steering mutation", () =>
  Effect.gen(function* () {
    for (const queue of [
      {
        threadId,
        revision: 3,
        queuedCount: 1,
        becameNonempty: true,
        change: { _tag: "Added" as const, turn: queued },
      },
      {
        threadId,
        revision: 2,
        queuedCount: 0,
        becameNonempty: false,
        change: { _tag: "Removed" as const, turnId: queued.id },
      },
    ] satisfies ReadonlyArray<TurnQueue.QueueItemChange>) {
      const mutations: Array<TurnQueue.QueueItemChange> = []
      let notified = 0
      const control = makeInteractiveControl({
        turns: {
          get: (id) => {
            if (id === queued.id) return Effect.succeed(queued)
            if (id === active.id) return Effect.succeed(active)
            return Effect.void
          },
        } as TurnRepository.Interface,
        transcripts: {} as TranscriptRepository.Interface,
        backend: {} as ExecutionGateway.Interface,
        rootTurnOwner: {
          prepareQueuedSteering: (_source, target, input) =>
            Effect.succeed({
              admission: {
                target,
                input,
                source: queued,
                preparedAt: 1,
                outcome: {
                  _tag: "Rejected",
                  failure: ExecutionGateway.SteeringFailure.make({ kind: "rejected", message: "persisted" }),
                  queue,
                },
              },
              queue,
              queueChanged: false,
            }),
        } as RootTurnOwner.Interface,
        active: Effect.succeed(active),
        dispatch: () => {},
        queueMutation: (change) => {
          mutations.push(change)
          return {
            _tag: "QueueUpdated",
            selectionEpoch: 0,
            threadId: change.threadId,
            revision: change.revision,
            queuedCount: change.queuedCount,
            change: { _tag: "Removed", turnId: queued.id },
          }
        },
        notifyTurnChanged: () => Effect.sync(() => (notified += 1)),
        fail: operationError,
      })
      yield* control.steerQueued(queued.id, queued.prompt, "persisted-request")
      expect(mutations).toEqual([])
      expect(notified).toBe(1)
    }
  }),
)
