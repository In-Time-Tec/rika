import { expect, it } from "@effect/vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as RootTurnOwner from "../../../../src/thread/queue/root-owner"
import { Effect } from "effect"
import type { InteractiveEvent } from "../../../../src/operation/interactive/session-event"
import { makeInteractiveControl } from "../../../../src/operation/interactive/turn/control"
import { operationError } from "../../../../src/operation/error"
import type * as TurnQueue from "../../../../src/thread/repository/turn-queue"

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
      const turns = TurnRepository.Service.of({
        get: (id) => {
          if (id === queued.id) return Effect.succeed(queued)
          if (id === active.id) return Effect.succeed(active)
          return Effect.void
        },
      })
      const transcripts = TranscriptRepository.Service.of({})
      const backend = ExecutionGateway.Service.of({})
      const rootTurnOwner = {
        ...(yield* RootTurnOwner.make(turns, transcripts, backend)),
        prepareQueuedSteering: (...args: Parameters<RootTurnOwner.Interface["prepareQueuedSteering"]>) => {
          const [, target, input] = args
          return Effect.succeed({
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
          })
        },
      }
      const control = makeInteractiveControl({
        turns,
        transcripts,
        backend,
        rootTurnOwner,
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

it.effect("rejects queued images before preparing a steering admission", () =>
  Effect.gen(function* () {
    const image = {
      ...queued,
      promptParts: [
        { type: "text" as const, text: "queued steering" },
        { type: "image" as const, mediaType: "image/png", data: "cG5n", filename: "queued.png" },
      ],
    }
    const events: Array<import("@rika/product/interactive-runtime-event").InteractiveEvent> = []
    let prepared = false
    const turns = TurnRepository.Service.of({
      get: (id) => Effect.succeed(id === image.id ? image : active),
    })
    const transcripts = TranscriptRepository.Service.of({})
    const backend = ExecutionGateway.Service.of({})
    const rootTurnOwner = {
      ...(yield* RootTurnOwner.make(turns, transcripts, backend)),
      prepareQueuedSteering: () =>
        Effect.sync(() => {
          prepared = true
          return Effect.die("unreachable")
        }).pipe(Effect.flatten),
    }
    const control = makeInteractiveControl({
      turns,
      transcripts,
      backend,
      rootTurnOwner,
      active: Effect.succeed(active),
      dispatch: (event) => events.push(event),
      queueMutation: () => {
        throw new Error("unreachable")
      },
      notifyTurnChanged: () => Effect.void,
      fail: operationError,
    })

    yield* control.steerQueued(image.id, image.prompt, "image-request")
    expect(prepared).toBe(false)
    expect(events).toMatchObject([
      {
        _tag: "ExecutionControlFailed",
        action: "steer",
        steeringRequestId: "image-request",
        failure: { message: "Queued turns with images cannot be steered" },
      },
    ])
  }),
)

/**
 * A queued turn becomes steering text when the user promotes it into a running turn, and a prompt
 * carries no size bound of its own — a pasted stack trace, a file, a diff. Refusing those on
 * delivery consumed the queued row and delivered nothing, so the steer vanished with no admission
 * and no report. Generalist bounds a steering prompt by the same message limits as any other prompt, so
 * a long one is admitted rather than dropped.
 */
it.effect("admits a queued prompt longer than the composer convenience limit", () =>
  Effect.gen(function* () {
    const oversized = "x".repeat(ExecutionGateway.SteeringTextMaxCharacters + 1)
    const bigQueued = { ...queued, prompt: oversized }
    let prepared = 0
    const failures: Array<string> = []
    const turns = TurnRepository.Service.of({
      get: (id) => {
        if (id === bigQueued.id) return Effect.succeed(bigQueued)
        if (id === active.id) return Effect.succeed(active)
        return Effect.void
      },
    })
    const transcripts = TranscriptRepository.Service.of({})
    const backend = ExecutionGateway.Service.of({})
    const rootTurnOwner = {
      ...(yield* RootTurnOwner.make(turns, transcripts, backend)),
      prepareQueuedSteering: (...args: Parameters<RootTurnOwner.Interface["prepareQueuedSteering"]>) =>
        Effect.sync(() => {
          const [, target, steering] = args
          prepared += 1
          return {
            admission: { target, input: steering, source: bigQueued, preparedAt: 1, outcome: { _tag: "Accepted" } },
            queue: { threadId, revision: 1, queuedCount: 0, becameNonempty: false },
            queueChanged: false,
          }
        }),
    }
    const control = makeInteractiveControl({
      turns,
      transcripts,
      backend,
      rootTurnOwner,
      active: Effect.succeed(active),
      dispatch: (event) => {
        if (event._tag === "ExecutionControlFailed") failures.push(event.failure.message)
      },
      queueMutation: (change) => ({
        _tag: "QueueUpdated",
        selectionEpoch: 0,
        threadId: change.threadId,
        revision: change.revision,
        queuedCount: change.queuedCount,
        change: { _tag: "Removed", turnId: bigQueued.id },
      }),
      notifyTurnChanged: () => Effect.void,
      fail: operationError,
    })

    yield* control.steerQueued(bigQueued.id, bigQueued.prompt, "oversized-request")

    expect(prepared).toBe(1)
    expect(failures).toEqual([])
  }),
)

it.effect("delivers each exact authorization checkpoint without consulting a newer projection", () =>
  Effect.gen(function* () {
    const checkpoint = {
      version: ExecutionProjection.projectionVersion,
      cursor: "authorization-cursor",
      state: "authorization-state",
    }
    const turn: Turn.AgentExecutionTurn = {
      ...active,
      id: Turn.TurnId.make("turn-1"),
      threadId: Thread.ThreadId.make("thread-1"),
      executionLink: { runId: "run-1", turnId: "turn-1", threadId: "thread-1" },
    }
    const events: Array<InteractiveEvent> = []
    const responses: Array<["approve" | "deny", ExecutionGateway.AuthorizationResponse]> = []
    const turns = TurnRepository.Service.of({ get: () => Effect.succeed(turn) })
    const transcripts = TranscriptRepository.Service.of({
      get: () =>
        Effect.succeed({
          turn,
          units: [],
          checkpointGeneration: 0,
          revision: 0,
          state: {
            status: "running",
            usage: ExecutionProjection.emptyUsageState(),
            steering: { steeringMessages: 0, followUpMessages: 0 },
          },
          projectorCheckpoint: checkpoint,
          projectionVersion: ExecutionProjection.projectionVersion,
        }),
    })
    const backend = ExecutionGateway.Service.of({
      approveTurn: (_link, input) => Effect.sync(() => responses.push(["approve", input])),
      denyTurn: (_link, input) => Effect.sync(() => responses.push(["deny", input])),
    })
    const control = makeInteractiveControl({
      turns,
      transcripts,
      backend,
      rootTurnOwner: yield* RootTurnOwner.make(turns, transcripts, backend),
      active: Effect.succeed(turn),
      dispatch: (event) => events.push(event),
      queueMutation: () => {
        throw new Error("unused")
      },
      notifyTurnChanged: () => Effect.void,
      fail: operationError,
    })

    const earlierCheckpoint = {
      ...checkpoint,
      cursor: "earlier-cursor",
    }
    yield* control.approveAuthorization("turn-1", "authorization-1", earlierCheckpoint)
    expect(responses).toEqual([["approve", { authorizationId: "authorization-1", checkpoint: earlierCheckpoint }]])
    expect(events).toEqual([])

    yield* control.denyAuthorization("turn-1", "authorization-1", checkpoint)
    expect(responses).toEqual([
      ["approve", { authorizationId: "authorization-1", checkpoint: earlierCheckpoint }],
      ["deny", { authorizationId: "authorization-1", checkpoint }],
    ])
  }),
)
