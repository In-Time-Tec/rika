import * as ExecutionStatus from "@rika/product/execution-status"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Context, Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"
import { ExecutionIngest } from "@rika/product/product-operation-service"
import { executionRoute } from "../support/product-test-current-state"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { holdSession, openInteractiveSession, nonActivation } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

import { turnProvenance } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("projects interactive backend failures and terminal failure statuses", () =>
    Effect.gen(function* () {
      const runCase = (status: "backend" | "failed" | "failed-event" | "cancelled") =>
        Effect.gen(function* () {
          const repository = yield* ThreadRepository.makeMemory()
          const turns = yield* TurnRepository.makeMemory()
          const events = yield* Ref.make<ReadonlyArray<InteractiveEvent>>([])
          const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
          const runSync = Effect.runSyncWith(yield* Effect.context<never>())
          const caseBackend = ExecutionBackend.Service.of({
            ...backend,
            start: (input) => {
              if (status === "backend") {
                if (input.turnId === "turn-backend") {
                  return turns
                    .createForSubmission({
                      id: Turn.TurnId.make("successor-backend"),
                      threadId: Thread.ThreadId.make(input.threadId),
                      prompt: "queued successor",
                      ...turnProvenance,
                      executionRoute: executionRoute(),
                      queueCapacity: 128,
                      now: 1,
                    })
                    .pipe(
                      Effect.mapError((cause) => ExecutionBackend.BackendError.make({ message: cause.message })),
                      Effect.andThen(
                        Effect.fail(ExecutionBackend.BackendError.make({ message: "interactive backend failed" })),
                      ),
                    )
                }
                return backend.start(input)
              }
              return Effect.succeed({
                turnId: input.turnId,
                status: status === "failed-event" ? ("failed" as const) : status,
                events:
                  status === "failed-event"
                    ? [
                        executionStarted(String(input.turnId)),
                        {
                          executionId: String(input.turnId),
                          cursor: "failure-cursor",
                          sequence: 1,
                          type: "execution.failed",
                          timestampSource: "server",
                          createdAt: 1,
                          text: "opaque provider failure",
                        },
                      ]
                    : [],
              })
            },
          })
          yield* Effect.gen(function* () {
            const session = yield* openInteractiveSession(sessions, {
              _tag: "Interactive",
              prompt: [],
              ephemeral: false,
            })
            yield* Effect.forkChild(
              session.events((event) => runSync(Ref.update(events, (values) => [...values, event]))),
            )
            yield* Effect.yieldNow
            yield* session.submit("prompt")
            while (true) {
              const turn = yield* turns.get(Turn.TurnId.make(`turn-${status}`))
              if (turn !== undefined && ["completed", "failed", "cancelled"].includes(turn.status)) break
              yield* Effect.yieldNow
            }
            if (status === "backend")
              while (!(yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
            if (status === "failed")
              while (!(yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
            if (status === "failed-event")
              while (!(yield* Ref.get(events)).some((event) => event._tag === "TranscriptProjectionPatched"))
                yield* Effect.yieldNow
          }).pipe(
            provideLayer(
              productLayer({
                repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
                turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
                backendLayer: Layer.succeed(ExecutionBackend.Service, caseBackend),
                defaultWorkspace: "/work",
                makeThreadId: Effect.succeed(Thread.ThreadId.make(`thread-${status}`)),
                makeTurnId: Effect.succeed(Turn.TurnId.make(`turn-${status}`)),
                interactive: holdSession(sessions),
              }),
            ),
          )
          return {
            events: yield* Ref.get(events),
            turn: yield* turns.get(Turn.TurnId.make(`turn-${status}`)),
            successor: yield* turns.get(Turn.TurnId.make(`successor-${status}`)),
          }
        })
      const failedBackend = yield* runCase("backend")
      const failed = yield* runCase("failed")
      const failedEvent = yield* runCase("failed-event")
      const cancelled = yield* runCase("cancelled")
      const failedBackendEvent = nonActivation(failedBackend.events).find((event) => event._tag === "ExecutionFailed")
      expect(failedBackendEvent).toMatchObject({
        _tag: "ExecutionFailed",
        message: "Rika could not start this message. Run rika diagnostics status if it keeps happening.",
      })
      expect(failedBackendEvent?._tag === "ExecutionFailed" ? failedBackendEvent.message : undefined).not.toContain(
        "interactive backend failed",
      )
      expect(failedBackend.turn?.status).toBe("failed")
      expect(failedBackend.successor?.status).toBe("queued")
      expect(nonActivation(failed.events)).toContainEqual({
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        threadId: "thread-failed",
        turnId: "turn-failed",
        message: "Execution failed",
      })
      expect(nonActivation(failedEvent.events)).toContainEqual(
        expect.objectContaining({
          _tag: "TranscriptProjectionPatched",
          selectionEpoch: 0,
          threadId: "thread-failed-event",
          rootTurnId: "turn-failed-event",
          patchRevision: 2,
          origin: expect.objectContaining({
            _tag: "Event",
            executionId: "turn-failed-event",
            cursor: "failure-cursor",
            sequence: 1,
            type: "execution.failed",
            createdAt: 1,
            text: "opaque provider failure",
          }),
          delta: expect.objectContaining({ upsert: expect.any(Array), remove: expect.any(Array) }),
        }),
      )
      expect(nonActivation(failedEvent.events).some((event) => event._tag === "ExecutionFailed")).toBe(false)
      expect(nonActivation(cancelled.events).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("runs a new thread and persists its terminal turn", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const runningStatuses = yield* Ref.make<ReadonlyArray<ExecutionStatus.Status>>([])
      const runBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Effect.gen(function* () {
            const turn = yield* turns.get(Turn.TurnId.make(input.turnId)).pipe(Effect.orDie)
            yield* Ref.update(starts, (inputs) => [...inputs, input])
            yield* Ref.update(runningStatuses, (statuses) =>
              turn === undefined ? statuses : [...statuses, turn.status],
            )
            return {
              turnId: input.turnId,
              status: "completed",
              events: [
                executionStarted(String(input.turnId)),
                {
                  executionId: String(input.turnId),
                  cursor: "cursor-a",
                  sequence: 1,
                  type: "model.output.completed",
                  createdAt: 1,
                },
                {
                  executionId: String(input.turnId),
                  cursor: "cursor-b",
                  sequence: 2,
                  type: "model.output.completed",
                  createdAt: 2,
                  text: "answer",
                },
                {
                  executionId: String(input.turnId),
                  cursor: "cursor-c",
                  sequence: 3,
                  type: "execution.completed",
                  timestampSource: "server",
                  createdAt: 3,
                },
              ],
            }
          }),
      })
      const layer = Layer.mergeAll(
        TestConsole.layer,
        productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, runBackend),
          defaultWorkspace: "/default-workspace",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-new")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-new")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({
          _tag: "Run",
          prompt: [],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      const thread = yield* repository.get(Thread.ThreadId.make("thread-new"))
      const turn = yield* turns.get(Turn.TurnId.make("turn-new"))
      expect(thread).toMatchObject({
        id: "thread-new",
        workspace: "/default-workspace",
        title: "New thread",
      })
      expect(yield* Ref.get(starts)).toMatchObject([{ threadId: "thread-new", turnId: "turn-new", prompt: "" }])
      expect(yield* Ref.get(runningStatuses)).toEqual(["running"])
      expect(turn).toMatchObject({
        id: "turn-new",
        threadId: "thread-new",
        prompt: "",
        status: "completed",
        lastCursor: "cursor-c",
      })
      expect(output.filter((line): line is string => typeof line === "string" && line === "answer")).toEqual(["answer"])
    }),
  )

  it.effect("persists nested child units for a delegated Run turn", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const transcripts = Context.get(
        yield* Layer.build(TranscriptRepository.memoryLayer),
        TranscriptRepository.Service,
      )
      const childId = "child:execution%3Aturn-new:call_1"
      const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
        executionStarted(childId),
        {
          executionId: childId,
          cursor: "child-tool",
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "child-call", tool_name: "bash", input: { command: "bun test" } },
        },
        {
          executionId: childId,
          cursor: "child-answer",
          sequence: 2,
          type: "model.output.completed",
          createdAt: 3,
          text: "child finished the review",
        },
        {
          executionId: childId,
          cursor: "child-done",
          sequence: 3,
          type: "execution.completed",
          timestampSource: "server",
          createdAt: 4,
        },
      ]
      const runBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (executionId) =>
          Effect.succeed({
            turnId: String(executionId),
            status: "completed" as const,
            waits: [],
            pendingTools: [],
            children:
              String(executionId) === "turn-new" ? [{ executionId: childId, status: "completed" as const }] : [],
          }),
        follow: (executionId, _afterCursor, onEvent) =>
          Effect.sync(() => {
            const events = String(executionId) === childId ? childEvents : []
            for (const event of events) onEvent?.(event)
            return { turnId: String(executionId), status: "completed" as const, events }
          }),
        start: (input) =>
          Effect.succeed({
            turnId: input.turnId,
            status: "completed" as const,
            events: [
              executionStarted(String(input.turnId)),
              {
                executionId: String(input.turnId),
                cursor: "root-tool",
                sequence: 1,
                type: "tool.call.requested",
                createdAt: 1,
                data: { tool_call_id: "call_1", tool_name: "task", input: { prompt: "review" } },
              },
              {
                executionId: String(input.turnId),
                cursor: "root-spawn",
                sequence: 2,
                type: "child_run.spawned",
                createdAt: 2,
                data: { child_execution_id: childId, preset_name: "Oracle" },
              },
              {
                executionId: String(input.turnId),
                cursor: "root-answer",
                sequence: 3,
                type: "model.output.completed",
                createdAt: 4,
                text: "delegated review finished",
              },
              {
                executionId: String(input.turnId),
                cursor: "root-done",
                sequence: 4,
                type: "execution.completed",
                timestampSource: "server",
                createdAt: 5,
              },
            ],
          }),
        replay: (executionId) =>
          Effect.succeed({
            turnId: String(executionId),
            status: "completed" as const,
            events:
              String(executionId) === childId
                ? childEvents
                : [
                    executionStarted(String(executionId)),
                    {
                      executionId: String(executionId),
                      cursor: "root-tool",
                      sequence: 1,
                      type: "tool.call.requested" as const,
                      createdAt: 1,
                      data: { tool_call_id: "call_1", tool_name: "task", input: { prompt: "review" } },
                    },
                    {
                      executionId: String(executionId),
                      cursor: "root-spawn",
                      sequence: 2,
                      type: "child_run.spawned" as const,
                      createdAt: 2,
                      data: { child_execution_id: childId, preset_name: "Oracle" },
                    },
                    {
                      executionId: String(executionId),
                      cursor: "root-answer",
                      sequence: 3,
                      type: "model.output.completed" as const,
                      createdAt: 4,
                      text: "delegated review finished",
                    },
                    {
                      executionId: String(executionId),
                      cursor: "root-done",
                      sequence: 4,
                      type: "execution.completed" as const,
                      timestampSource: "server" as const,
                      createdAt: 5,
                    },
                  ],
          }),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Service
        yield* operation.run({
          _tag: "Run",
          prompt: [],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(
        provideLayer(
          Layer.mergeAll(
            TestConsole.layer,
            productLayer({
              repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
              turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
              transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
              backendLayer: Layer.succeed(ExecutionBackend.Service, runBackend),
              defaultWorkspace: "/default-workspace",
              makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-new")),
              makeTurnId: Effect.succeed(Turn.TurnId.make("turn-new")),
            }),
          ),
        ),
      )

      const stored = yield* transcripts.get(Turn.TurnId.make("turn-new"))
      const parentTool = stored?.units.find(
        (unit) =>
          unit.parentId === undefined && unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
      )
      const parentId =
        parentTool?.content._tag === "Block" && parentTool.content.block._tag === "ToolCall"
          ? parentTool.content.block.id
          : undefined
      const nested = stored?.units.filter((unit) => unit.parentId !== undefined) ?? []
      expect(parentId).toBeDefined()
      expect(nested.every((unit) => unit.parentId === parentId)).toBe(true)
      expect(
        nested.some((unit) => unit.content._tag === "Entry" && unit.content.text === "child finished the review"),
      ).toBe(true)
      expect(stored?.executionCheckpoints.find((entry) => entry.executionKey === childId)?.status).toBe("completed")
      expect(stored?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
    }),
  )
})
