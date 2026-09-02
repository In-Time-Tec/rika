import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as ProductOperation from "@rika/product/product-operation"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as RootTurnOwner from "../../src/thread/queue/root-owner"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect } from "effect"
import { OperationError } from "../../src/operation/error"
import { applyGeneratedTitle } from "../../src/operation/thread-title"
import { run as runNoninteractive } from "../../src/operation/dispatch/noninteractive"
import type { Dependencies as NoninteractiveDependencies } from "../../src/operation/dispatch/noninteractive-contract"
import { queuedTurnPromoteMaxAgeMs, staleQueuedTurnsError } from "../../src/thread/queue/pending-policy"
import type { InteractiveEvent } from "../../src/operation/interactive/session-event"

const threadId = Thread.ThreadId.make("titled-thread")
const makeThread = (title: string): Thread.Thread => ({
  id: threadId,
  workspace: "/workspace",
  title,
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 0,
  updatedAt: 0,
})

const route = ExecutionRouteSnapshot.testExecutionRoute()

const result = (title: string | undefined): ExecutionProjection.Result => {
  const base: ExecutionProjection.ProjectionState = {
    status: "completed",
    usage: ExecutionProjection.emptyUsageState(),
    steering: { steeringMessages: 0, followUpMessages: 0 },
  }
  return {
    turnId: "turn-1",
    status: "completed",
    state: title === undefined ? base : { ...base, title: { text: title } },
    units: [
      {
        key: "assistant:1",
        turnId: "turn-1",
        order: [{ sequence: 1, part: 0, key: "assistant:1" }],
        revision: 0,
        content: { _tag: "Entry", role: "assistant", text: "/workspace" },
      },
    ],
  }
}

const recordingThreads = (initial: Thread.Thread) => {
  let current = initial
  const renames = new Array<{ readonly expected: string; readonly title: string }>()
  const threads = ThreadRepository.Service.of({
    get: () => Effect.succeed(current),
    renameIfTitle: (_id, expected, title) =>
      Effect.sync(() => {
        renames.push({ expected, title })
        if (current.title !== expected) return undefined
        current = { ...current, title }
        return current
      }),
  })
  return { threads, renames, current: () => current }
}

describe("applyGeneratedTitle", () => {
  it.effect("renames the Thread to the clamped generated title while it still has the expected title", () =>
    Effect.gen(function* () {
      const store = recordingThreads(makeThread("Run pwd"))
      const renamed = yield* applyGeneratedTitle(threadId, "Run pwd", result(`  Print the\nworking directory  `)).pipe(
        Effect.provideService(ThreadRepository.Service, store.threads),
      )
      expect(renamed?.title).toBe("Print the working directory")
      expect(store.renames).toEqual([{ expected: "Run pwd", title: "Print the working directory" }])
    }),
  )

  it.effect("does nothing when the Run produced no title or the same title", () =>
    Effect.gen(function* () {
      const store = recordingThreads(makeThread("Run pwd"))
      const none = yield* applyGeneratedTitle(threadId, "Run pwd", result(undefined)).pipe(
        Effect.provideService(ThreadRepository.Service, store.threads),
      )
      const same = yield* applyGeneratedTitle(threadId, "Run pwd", result("Run pwd")).pipe(
        Effect.provideService(ThreadRepository.Service, store.threads),
      )
      const blank = yield* applyGeneratedTitle(threadId, "Run pwd", result("   ")).pipe(
        Effect.provideService(ThreadRepository.Service, store.threads),
      )
      expect([none, same, blank]).toEqual([undefined, undefined, undefined])
      expect(store.renames).toEqual([])
    }),
  )
})

describe("noninteractive thread titles", () => {
  it.effect("adopts the prompt as the provisional title and applies the generated title afterwards", () =>
    Effect.gen(function* () {
      const store = recordingThreads(makeThread("New thread"))
      const submitted: Turn.AgentExecutionTurn = {
        _tag: "AgentExecution",
        id: Turn.TurnId.make("turn-1"),
        threadId,
        prompt: "Run pwd",
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        executionRoute: route,
        status: "running",
        createdAt: 0,
        updatedAt: 0,
      }
      let persisted: Turn.AgentExecutionTurn | undefined
      const events = new Array<InteractiveEvent>()
      const startInputs = new Array<Parameters<RootTurnOwner.Interface["startTurn"]>[0]>()
      const turns = TurnRepository.Service.of({
        readQueue: () => Effect.succeed({ threadId, revision: 0, queuedCount: 0, turns: [] }),
        get: () => Effect.succeed(persisted),
        list: () => Effect.succeed(persisted === undefined ? [] : [persisted]),
      })
      const dependencies: NoninteractiveDependencies = {
        defaultWorkspace: "/workspace",
        pendingTurnCapacity: 2,
        makeThreadId: Effect.die("existing thread must be reused"),
        makeTurnId: Effect.succeed(submitted.id),
        resolveExecutionRoute: () => Effect.succeed(route),
        createObservedSubmission: () =>
          Effect.sync(() => {
            persisted = submitted
            return { turn: submitted, claimed: true }
          }),
        ensureTurnSummary: () => Effect.void,
        setTurnStatus: (_id, status) =>
          Effect.sync(() => {
            persisted = { ...submitted, status }
            return persisted
          }),
        publishInteractiveActivity: (_origin, event) => {
          events.push(event)
          return event
        },
        rootTurnOwner: {
          ...(yield* RootTurnOwner.make(turns, TranscriptRepository.Service.of({}), ExecutionGateway.Service.of({}))),
          startTurn: (input) =>
            Effect.sync(() => {
              startInputs.push(input)
              return { runId: "turn-1-run", threadId, turnId: submitted.id }
            }),
          watchTurn: () => Effect.succeed(result("Print the working directory")),
        },
        prepareExecution: (value) => Effect.succeed({ prompt: value.prompt, promptParts: undefined, messages: [] }),
        claimQueuedTurn: () => Effect.void,
        releaseTurnObserver: () => Effect.void,
        queueMutationEvent: () => Effect.die("queue is empty"),
        executionDependencies: Context.empty().pipe(
          Context.add(ThreadRepository.Service, store.threads),
          Context.add(TurnRepository.Service, turns),
        ),
        staleQueuedTurnsError,
        queuedTurnPromoteMaxAgeMs,
        operationError: (message) => Effect.fail(OperationError.make({ message })),
        unavailable: (input, message) => ProductOperation.OperationUnavailable.make({ operation: input._tag, message }),
      }

      yield* runNoninteractive(
        {
          _tag: "Run",
          prompt: ["Run pwd"],
          threadId: String(threadId),
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        },
        dependencies,
      )

      expect(store.renames).toEqual([
        { expected: "New thread", title: "Run pwd" },
        { expected: "Run pwd", title: "Print the working directory" },
      ])
      expect(store.current().title).toBe("Print the working directory")
      expect(startInputs.map((input) => input.titleIntent)).toEqual([
        { _tag: "GenerateThreadTitle", expectedTitle: "Run pwd" },
      ])
      expect(events.filter((event) => event._tag === "ThreadTitled")).toEqual([
        { _tag: "ThreadTitled", threadId: String(threadId), title: "Run pwd" },
        { _tag: "ThreadTitled", threadId: String(threadId), title: "Print the working directory" },
      ])
    }),
  )
})
