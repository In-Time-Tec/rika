import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"
import * as ResolvedContext from "@rika/product/context-resolution-service"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { backend } from "../support/operation-execution-fixtures"

describe("Operation", () => {
  it.effect("durably submits interactive prompts and projects completion", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const transcripts = yield* TranscriptRepository.makeMemory({ turns })
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const startInputs = yield* Ref.make<ReadonlyArray<ExecutionGateway.StartTurn>>([])
      const liveBackend = ExecutionGateway.Service.of({
        ...backend,
        startTurn: (input) =>
          Ref.update(startInputs, (all) => [...all, input]).pipe(Effect.andThen(backend.startTurn(input))),
        watchTurn: (link, cursor) =>
          Stream.make({
            executionId: "opaque-title-child",
            childExecutionId: "opaque-title-child",
            cursor: "cursor-title",
            sequence: 0,
            type: "thread.title.generated",
            createdAt: 0,
            data: { title: "\u001b Generated \n title ", invocation_id: "rika.thread-title" },
          }).pipe(Stream.concat(backend.watchTurn(link, cursor))),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
        backendLayer: Layer.succeed(ExecutionGateway.Service, liveBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-interactive")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-interactive")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (values) => [...values, event]))))
        yield* Effect.yieldNow
        yield* session.submit("exact prompt")
        while ((yield* turns.get(Turn.TurnId.make("turn-interactive")))?.status !== "completed") yield* Effect.yieldNow
        while (
          !(yield* Ref.get(events)).some(
            (event) => event._tag === "TranscriptProjectionStopped" && event.rootTurnId === "turn-interactive",
          )
        )
          yield* Effect.yieldNow
        while ((yield* repository.get(Thread.ThreadId.make("thread-interactive")))?.title !== "Generated title")
          yield* Effect.yieldNow
      }).pipe(provideLayer(layer))
      const dispatched = yield* Ref.get(events)
      const transcript = dispatched.filter(
        (event) => event._tag !== "ThreadsListed" && event._tag !== "ThreadUsageUpdated",
      )
      expect(transcript).toContainEqual({
        _tag: "ThreadActivated",
        threadId: "thread-interactive",
        title: "exact prompt",
      })
      expect(transcript).toContainEqual({
        _tag: "SubmissionAdmitted",
        selectionEpoch: 0,
        threadId: "thread-interactive",
        turnId: "turn-interactive",
        status: "active",
      })
      expect(transcript).toContainEqual(
        expect.objectContaining({
          _tag: "TurnStarted",
          selectionEpoch: 0,
          threadId: "thread-interactive",
          turn: expect.objectContaining({
            id: "turn-interactive",
            threadId: "thread-interactive",
            prompt: "exact prompt",
            status: "running",
          }),
        }),
      )
      expect(transcript).toContainEqual(
        expect.objectContaining({
          _tag: "TranscriptProjectionStarted",
          threadId: "thread-interactive",
          rootTurnId: "turn-interactive",
          patchRevision: 0,
        }),
      )
      const patches = transcript.filter(
        (event) => event._tag === "TranscriptProjectionPatched" && event.rootTurnId === "turn-interactive",
      )
      expect(
        patches.map((event) =>
          event._tag === "TranscriptProjectionPatched" && event.origin._tag === "Event"
            ? [event.patchRevision, event.origin.executionId, event.origin.cursor]
            : [],
        ),
      ).toEqual([
        [1, "turn-interactive-run", "cursor-started"],
        [2, "turn-interactive-run", "cursor-a"],
        [3, "turn-interactive-run", "cursor-b"],
      ])
      expect(transcript).toContainEqual(
        expect.objectContaining({
          _tag: "TranscriptProjectionStopped",
          threadId: "thread-interactive",
          rootTurnId: "turn-interactive",
          patchRevision: 3,
          status: "completed",
        }),
      )
      expect(yield* turns.get(Turn.TurnId.make("turn-interactive"))).toMatchObject({
        prompt: "exact prompt",
        status: "completed",
      })
      expect(yield* Ref.get(startInputs)).toEqual([
        expect.objectContaining({
          titleIntent: { _tag: "GenerateThreadTitle", expectedTitle: "exact prompt" },
        }),
      ])
      expect(dispatched).toContainEqual({
        _tag: "ThreadTitled",
        threadId: "thread-interactive",
        title: "Generated title",
      })
    }),
  )

  it.effect("fails preparation without emitting TurnStarted or calling the backend", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const starts = yield* Ref.make(0)
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(
          ExecutionGateway.Service,
          ExecutionGateway.Service.of({
            ...backend,
            startTurn: (input) =>
              Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.startTurn(input))),
          }),
        ),
        resolvedContextLayer: ResolvedContext.testLayer({ resolve: () => Effect.die("preparation failed") }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("preparation-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("preparation-turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (all) => [...all, event]))))
        yield* Effect.yieldNow
        yield* session.submit("cannot prepare")
        while ((yield* turns.get(Turn.TurnId.make("preparation-turn")))?.status !== "failed") yield* Effect.yieldNow
        while (!(yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(starts)).toBe(0)
      expect((yield* Ref.get(events)).some((event) => event._tag === "TurnStarted")).toBe(false)
    }),
  )

  it.effect("does not start the backend when cancellation wins during preparation", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const starts = yield* Ref.make(0)
      const cancellations = yield* Ref.make(0)
      const preparationEntered = yield* Deferred.make<void>()
      const releasePreparation = yield* Deferred.make<void>()
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const cancellingBackend = ExecutionGateway.Service.of({
        ...backend,
        startTurn: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.startTurn(input))),
        inspectTurn: () => Effect.succeed({ status: "running" }),
        cancelTurn: () => Ref.update(cancellations, (count) => count + 1),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionGateway.Service, cancellingBackend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: () =>
            Deferred.succeed(preparationEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releasePreparation)),
              Effect.as({ sources: [], diagnostics: [], digest: "" }),
            ),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("cancel-preparation-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("cancel-preparation-turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (all) => [...all, event]))))
        yield* Effect.yieldNow
        yield* session.submit("cancel while preparing")
        yield* Deferred.await(preparationEntered)
        yield* session.cancel
        yield* Deferred.succeed(releasePreparation, undefined)
        while ((yield* turns.get(Turn.TurnId.make("cancel-preparation-turn")))?.status !== "cancelled")
          yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* Ref.get(cancellations)).toBe(0)
      expect((yield* Ref.get(events)).some((event) => event._tag === "TurnStarted")).toBe(false)
      expect(yield* turns.get(Turn.TurnId.make("cancel-preparation-turn"))).toMatchObject({ status: "cancelled" })
    }),
  )
})
