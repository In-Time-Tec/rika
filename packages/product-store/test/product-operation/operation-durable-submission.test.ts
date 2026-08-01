import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Deferred, Effect, Layer, Ref } from "effect"
import { ResolvedContext } from "@rika/product/product-operation-service"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

describe("Operation", () => {
  it.effect("durably submits interactive prompts and projects completion", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const transcripts = yield* TranscriptRepository.makeMemory({ turns })
      const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const startInputs = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const childInputs = yield* Ref.make<ReadonlyArray<ExecutionBackend.InvokeChildInput>>([])
      const liveBackend = ExecutionBackend.Service.of({
        ...backend,
        invokeChild: (input) =>
          Ref.update(childInputs, (all) => [...all, input]).pipe(Effect.as({ ...input, type: "accepted" as const })),
        follow: (executionId, afterCursor, onEvent, reference) => {
          if (executionId !== "child:turn-interactive:title")
            return backend.follow!(executionId, afterCursor, onEvent, reference)
          if (reference !== ExecutionBackend.executionReference)
            return Effect.die(new Error("title execution addressed without the execution reference"))
          return Effect.succeed({
            turnId: executionId,
            status: "completed" as const,
            events: [
              executionStarted(executionId),
              {
                executionId,
                cursor: "title-a",
                sequence: 1,
                type: "model.output.completed" as const,
                createdAt: 3,
                text: "answer",
              },
              {
                executionId,
                cursor: "title-b",
                sequence: 2,
                type: "execution.completed" as const,
                timestampSource: "server" as const,
                createdAt: 4,
              },
            ],
          })
        },
        start: (input) =>
          Ref.update(startInputs, (all) => [...all, input]).pipe(
            Effect.andThen(
              backend.start(input).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    for (const event of result.events) input.onEvent?.(event)
                  }),
                ),
              ),
            ),
          ),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
        backendLayer: Layer.succeed(ExecutionBackend.Service, liveBackend),
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
        while (!(yield* Ref.get(events)).some((event) => event._tag === "ThreadTitled")) yield* Effect.yieldNow
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
            stopIntent: "none",
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
        [1, "turn-interactive", "cursor-started"],
        [2, "turn-interactive", "cursor-a"],
        [3, "turn-interactive", "cursor-b"],
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
      expect(transcript).toContainEqual(
        expect.objectContaining({ _tag: "ThreadTitled", threadId: "thread-interactive", title: "answer" }),
      )
      expect(yield* Ref.get(childInputs)).toContainEqual({
        parentTurnId: "turn-interactive",
        childId: "title",
        profile: "Title",
        prompt: "exact prompt",
      })
      expect(yield* turns.get(Turn.TurnId.make("turn-interactive"))).toMatchObject({
        prompt: "exact prompt",
        status: "completed",
        stopIntent: "none",
        lastCursor: "cursor-b",
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
          ExecutionBackend.Service,
          ExecutionBackend.Service.of({
            ...backend,
            start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
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
      const cancellingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        cancel: (turnId) =>
          Ref.update(cancellations, (count) => count + 1).pipe(
            Effect.as({
              turnId,
              status: "cancelled" as const,
              events: [
                executionStarted(String(turnId)),
                {
                  executionId: String(turnId),
                  cursor: "cancelled",
                  sequence: 1,
                  type: "execution.cancelled",
                  timestampSource: "server",
                  createdAt: 1,
                },
              ],
            }),
          ),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, cancellingBackend),
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
