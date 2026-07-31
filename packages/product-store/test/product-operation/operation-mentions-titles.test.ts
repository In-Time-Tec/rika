import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation, ResolvedContext } from "@rika/product/product-operation"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

import { turnProvenance, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("resolves mentions typed in the composer while ignoring mentions inside pasted text", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const inputs = yield* Ref.make<ReadonlyArray<ResolvedContext.Input>>([])
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: (input) =>
            Ref.update(inputs, (all) => [...all, input]).pipe(Effect.as({ sources: [], diagnostics: [], digest: "" })),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("pasted-mention-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("pasted-mention-turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
        yield* session.submit("review @src/a.ts thanks @Copilot and @ipedro", undefined, [
          { type: "text", text: "review @src/a.ts " },
          { type: "text", text: "thanks @Copilot and @ipedro", pasted: true },
        ])
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect((yield* Ref.get(inputs)).map((input) => input.references)).toEqual([["src/a.ts"]])
    }),
  )

  it.effect("titles a new thread through its pinned GPT 5.6 Luna route", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const titleInvocations = yield* Ref.make<ReadonlyArray<ExecutionBackend.InvokeChildInput>>([])
      const titleRoute = {
        ...Turn.testExecutionRoute("low").main,
        role: "title" as const,
        model: "gpt-5.6-luna",
        effort: "low",
      }
      const routedBackend = ExecutionBackend.Service.of({
        ...backend,
        invokeChild: (input) =>
          Ref.update(titleInvocations, (values) => [...values, input]).pipe(
            Effect.as({ ...input, type: "accepted" as const }),
          ),
        inspect: (executionId) =>
          Ref.get(titleInvocations).pipe(
            Effect.map((invocations) =>
              invocations.length === 0
                ? undefined
                : { turnId: executionId, status: "completed" as const, waits: [], pendingTools: [], children: [] },
            ),
          ),
        replay: (executionId) =>
          Effect.succeed({
            turnId: executionId,
            status: "completed" as const,
            events: [
              executionStarted(executionId),
              {
                executionId,
                cursor: "title-output",
                sequence: 1,
                type: "model.output.completed" as const,
                createdAt: 3,
                text: "Selected Route Title",
              },
              {
                executionId,
                cursor: "title-completed",
                sequence: 2,
                type: "execution.completed" as const,
                timestampSource: "server" as const,
                createdAt: 4,
              },
            ],
          }),
        start: (input) =>
          Ref.update(starts, (values) => [...values, `${input.executionRoute.main.model}:${input.turnId}`]).pipe(
            Effect.as({
              turnId: input.turnId,
              status: "completed" as const,
              events: [
                executionStarted(String(input.turnId)),
                {
                  executionId: String(input.turnId),
                  cursor: `cursor:${input.turnId}:output`,
                  sequence: 1,
                  type: "model.output.completed" as const,
                  createdAt: 1,
                  text: "answer",
                },
                {
                  executionId: String(input.turnId),
                  cursor: `cursor:${input.turnId}:completed`,
                  sequence: 2,
                  type: "execution.completed" as const,
                  timestampSource: "server" as const,
                  createdAt: 2,
                },
              ],
            }),
          ),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, routedBackend),
        resolveExecutionRoute: (mode) => {
          const route = Turn.testExecutionRoute(mode)
          return Effect.succeed({
            ...route,
            main: { ...route.main, model: `${mode}-model` },
            title: titleRoute,
          })
        },
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-selected-title")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-selected-title")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("Build groceries", "high")
        while ((yield* Ref.get(titleInvocations)).length < 1) yield* Effect.yieldNow
        while ((yield* repository.get(Thread.ThreadId.make("thread-selected-title")))?.title !== "Selected Route Title")
          yield* Effect.yieldNow
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(starts)).toEqual(["high-model:turn-selected-title"])
      expect(yield* Ref.get(titleInvocations)).toEqual([
        { parentTurnId: "turn-selected-title", childId: "title", profile: "Title", prompt: "Build groceries" },
      ])
      expect(yield* repository.get(Thread.ThreadId.make("thread-selected-title"))).toMatchObject({
        title: "Selected Route Title",
      })
    }),
  )

  it.effect("keeps the seed title when best-effort titling fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const titleFailingBackend = ExecutionBackend.Service.of({
        ...backend,
        invokeChild: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "title unavailable" })),
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, titleFailingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-title-failure")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-title-failure")),
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
        yield* session.submit("Stable seed title")
        yield* Effect.yieldNow
      }).pipe(provideLayer(layer))

      expect(yield* turns.get(Turn.TurnId.make("turn-title-failure"))).toMatchObject({ status: "completed" })
      expect(yield* repository.get(Thread.ThreadId.make("thread-title-failure"))).toMatchObject({
        title: "Stable seed title",
      })
      expect((yield* Ref.get(events)).some((event) => event._tag === "ThreadTitled")).toBe(false)
      expect((yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("finishes a durable title from replay after restart without starting it again", () =>
    Effect.gen(function* () {
      const thread = selectionThread("title-restart-thread")
      const prompt = "Recover this title after restart"
      const repository = yield* ThreadRepository.makeMemory([{ ...thread, title: prompt }])
      const firstTurn: Turn.Turn = {
        id: Turn.TurnId.make("title-restart-turn"),
        ...turnProvenance,
        threadId: thread.id,
        prompt,
        stopIntent: "none",
        status: "completed",
        executionRoute: Turn.testExecutionRoute("medium"),
        createdAt: 1,
        updatedAt: 2,
      }
      const turns = yield* TurnRepository.makeMemory([firstTurn])
      const starts = yield* Ref.make(0)
      const replayed = yield* Ref.make<ReadonlyArray<string>>([])
      const restartedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
        inspect: (executionId) =>
          Effect.succeed(
            executionId === "child:title-restart-turn:title"
              ? {
                  turnId: executionId,
                  status: "completed" as const,
                  waits: [],
                  pendingTools: [],
                  children: [],
                }
              : undefined,
          ),
        replay: (executionId) =>
          Ref.update(replayed, (values) => [...values, executionId]).pipe(
            Effect.as({
              turnId: executionId,
              status: "completed" as const,
              events: [
                executionStarted(executionId),
                {
                  executionId,
                  cursor: "restarted-title-output",
                  sequence: 1,
                  type: "model.output.completed" as const,
                  createdAt: 3,
                  text: "Recovered Durable Title",
                },
                {
                  executionId,
                  cursor: "restarted-title-done",
                  sequence: 2,
                  type: "execution.completed" as const,
                  timestampSource: "server" as const,
                  createdAt: 4,
                },
              ],
            }),
          ),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
        yield* TestClock.adjust("2 seconds")
        while ((yield* repository.get(thread.id))?.title !== "Recovered Durable Title") yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, restartedBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: () => Effect.never,
          }),
        ),
      )

      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* Ref.get(replayed)).toContain("child:title-restart-turn:title")
    }),
  )

  it.effect("does not reclassify a completed turn when thread promotion fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const promotionFailingBackend = ExecutionBackend.Service.of({
        ...backend,
        wakeThreadHost: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "promotion failed" })),
        registerTurnPromoter: () => Effect.void,
      })
      const layer = productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, promotionFailingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-promotion-failure")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-promotion-failure")),
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
        yield* session.submit("Completed response")
        yield* Effect.yieldNow
      }).pipe(provideLayer(layer))

      expect(yield* turns.get(Turn.TurnId.make("turn-promotion-failure"))).toMatchObject({ status: "completed" })
      expect((yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )
})
