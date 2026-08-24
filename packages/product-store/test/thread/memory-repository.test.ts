import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product-store/postgres-thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product-store/postgres-turn-repository"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"

import { backend } from "../turn/postgres/repository.fixture"
import { executionSessionLifecycleLayerTest, productLayer, provideLayer } from "../turn/postgres/repository.harness"
import { holdSession, openInteractiveSession, settleEvents } from "../turn/postgres/repository-session.harness"

const currentThread: Thread.Thread = {
  id: Thread.ThreadId.make("current-thread"),
  lineage: { _tag: "Original" },
  workspace: "/work",
  title: "Current thread",
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
}

const sessionLayer = (
  sessions: Ref.Ref<ReadonlyArray<InteractiveSession>>,
  repository: ThreadRepository.Interface,
  threadSummaryRepositoryLayer?: Layer.Layer<ThreadSummaryRepository.Service>,
) => {
  const options = {
    executionSessionLifecycleLayer: executionSessionLifecycleLayerTest(),
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
    turnRepositoryLayer: TurnRepository.memoryLayer(),
    backendLayer: Layer.succeed(ExecutionGateway.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.succeed(Thread.ThreadId.make("new-thread")),
    makeTurnId: Effect.succeed(Turn.TurnId.make("unused-turn")),
    interactive: holdSession(sessions),
  }
  return productLayer(
    threadSummaryRepositoryLayer === undefined ? options : { ...options, threadSummaryRepositoryLayer },
  )
}

describe("interactive session thread archiving", () => {
  it.effect("archives the selection and activates a new thread", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory([currentThread])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events: Array<InteractiveEvent> = []

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* settleEvents
        yield* session.selectThread(currentThread.id)
        yield* session.archiveAndNewThread
        yield* settleEvents
      }).pipe(provideLayer(sessionLayer(sessions, repository)))

      expect(yield* repository.get(currentThread.id)).toMatchObject({ archived: true })
      expect(yield* repository.get(Thread.ThreadId.make("new-thread"))).toMatchObject({ archived: false })
      expect(events.filter((event) => event._tag === "ThreadActivated").at(-1)).toMatchObject({
        threadId: "new-thread",
        title: "New thread",
      })
    }),
  )

  it.effect("does not create or activate the replacement when the atomic archive fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory([currentThread])
      const failingRepository = ThreadRepository.Service.of({
        ...repository,
        archiveAndCreate: () => Effect.fail(ThreadRepository.RepositoryError.make({ message: "archive failed" })),
      })
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events: Array<InteractiveEvent> = []

      const result = yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* settleEvents
        yield* session.selectThread(currentThread.id)
        return yield* Effect.result(session.archiveAndNewThread)
      }).pipe(provideLayer(sessionLayer(sessions, failingRepository)))

      expect(result._tag).toBe("Failure")
      expect(result._tag === "Failure" ? result.failure.message : "").toContain("archive failed")
      expect(yield* repository.get(currentThread.id)).toMatchObject({ archived: false })
      expect(yield* repository.get(Thread.ThreadId.make("new-thread"))).toBeUndefined()
      expect(events.filter((event) => event._tag === "ThreadActivated")).toEqual([])
    }),
  )

  it.effect("keeps the activated replacement when the post-commit summary refresh fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory([currentThread])
      const failSummaryRefresh = yield* Ref.make(false)
      const summaries = ThreadSummaryRepository.Service.of({
        list: () =>
          Ref.get(failSummaryRefresh).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(ThreadSummaryRepository.RepositoryError.make({ message: "summary refresh failed" }))
                : Effect.succeed([]),
            ),
          ),
        ensureTurn: () => Effect.void,
        replaceTurn: () => Effect.void,
        markRead: () => Effect.void,
        listRepairCandidates: () => Effect.succeed([]),
      })
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events: Array<InteractiveEvent> = []

      const result = yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => events.push(event)))
        yield* settleEvents
        yield* session.selectThread(currentThread.id)
        yield* Ref.set(failSummaryRefresh, true)
        const archived = yield* Effect.result(session.archiveAndNewThread)
        yield* Ref.set(failSummaryRefresh, false)
        yield* session.archiveThread
        return archived
      }).pipe(
        provideLayer(sessionLayer(sessions, repository, Layer.succeed(ThreadSummaryRepository.Service, summaries))),
      )

      expect(result._tag).toBe("Success")
      expect(yield* repository.get(currentThread.id)).toMatchObject({ archived: true })
      expect(yield* repository.get(Thread.ThreadId.make("new-thread"))).toMatchObject({ archived: true })
      expect(events.filter((event) => event._tag === "ThreadActivated").at(-1)).toMatchObject({
        threadId: "new-thread",
      })
    }),
  )
})
