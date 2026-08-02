import { Service } from "@rika/product/product-operation-service"
import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadInteractionRepository from "@rika/product-store/sqlite-thread-interaction-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Context, Effect, Layer, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"

import { executionRoute } from "../support/product-test-current-state"
import {
  childDelegationLayer,
  noReportRecovery,
  runWithChildDelegationLayer,
  truncatedDelegationReport,
} from "./operation-child-delegation-support"
import { settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend, delegationEvent } from "../support/operation-execution-fixtures"
import { turnProvenance, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("delivers a durable child result only after paging to a completed root answer", () =>
    Effect.gen(function* () {
      const source = selectionThread("result-source")
      const target = selectionThread("result-target")
      const sourceTurn: Turn.Turn = {
        id: Turn.TurnId.make("result-source-turn"),
        ...turnProvenance,
        threadId: source.id,
        prompt: "create an Agent",
        executionRoute: executionRoute(),
        status: "completed",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const targetTurn: Turn.AgentExecutionTurn = {
        _tag: "AgentExecution",
        id: Turn.TurnId.make("result-target-turn"),
        threadId: target.id,
        prompt: "finish delegated work",
        executionRoute: executionRoute(),
        author: {
          _tag: "Agent",
          sourceThreadId: source.id,
          sourceRootTurnId: sourceTurn.id,
          threadCreationDepth: 1,
        },
        lineage: { _tag: "Original" },
        status: "completed",
        stopIntent: "none",
        createdAt: 2,
        updatedAt: 3,
      }
      const interactions = yield* ThreadInteractionRepository.makeMemory({ threads: [source], turns: [sourceTurn] })
      yield* interactions.createThread({
        invocationDigest: "result-create",
        schemaInputDigest: "result-create",
        sourceThreadId: source.id,
        sourceRootTurnId: sourceTurn.id,
        now: 2,
        maximumDepth: 3,
        maximumAdmissions: 8,
        maximumWorkspaceActive: 8,
        queueCapacity: 8,
        threadId: target.id,
        turnId: targetTurn.id,
        prompt: targetTurn.prompt,
        title: target.title,
        executionRoute: targetTurn.executionRoute,
        resultDelivery: "reply",
        threadCreationDepth: 1,
      })
      const finalAvailable = yield* Ref.make(false)
      const pageRequests = yield* Ref.make<ReadonlyArray<string | undefined>>([])
      const rootEvent = (cursor: string, sequence: number, type: string, text?: string): ExecutionEvent.Event => ({
        executionId: String(targetTurn.id),
        cursor: `execution:${targetTurn.id}:${cursor}`,
        sequence,
        type,
        timestampSource: "server",
        createdAt: sequence,
        ...(text === undefined ? {} : { text }),
      })
      const resultBackend = ExecutionBackend.Service.of({
        ...backend,
        replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
        pageEvents: (_turnId, _direction, cursor) =>
          Ref.update(pageRequests, (requests) => [...requests, cursor]).pipe(
            Effect.andThen(
              cursor === undefined
                ? Effect.succeed({
                    events: [
                      executionStarted(String(targetTurn.id)),
                      rootEvent("stale", 1, "model.output.completed", "stale answer"),
                      rootEvent("tool", 2, "tool.call.requested"),
                      {
                        cursor: "child:result-target-turn:agent:model:100",
                        executionId: "child-agent",
                        sequence: 100,
                        type: "model.output.completed",
                        createdAt: 2,
                        text: "child answer must not escape",
                      },
                    ],
                    hasMore: true,
                    newestCursor: "page-one",
                  })
                : Ref.get(finalAvailable).pipe(
                    Effect.map((available) => ({
                      events: [
                        ...(available
                          ? [
                              rootEvent("final", 3, "model.output.completed", "proven final answer"),
                              rootEvent("complete", 4, "execution.completed"),
                            ]
                          : []),
                        {
                          cursor: "child:result-target-turn:agent:model:200",
                          executionId: "child-agent",
                          sequence: 200,
                          type: "model.output.completed",
                          createdAt: 4,
                          text: "later child answer must not escape",
                        },
                      ],
                      hasMore: false,
                      newestCursor: "page-two",
                    })),
                  ),
            ),
          ),
      })
      const turns = yield* TurnRepository.makeMemory([sourceTurn, targetTurn])
      const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
      const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
      const layer = childDelegationLayer({
        repositoryLayer: ThreadRepository.memoryLayer([source, target]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
        threadInteractionRepositoryLayer: Layer.succeed(ThreadInteractionRepository.Service, interactions),
        backendLayer: Layer.succeed(ExecutionBackend.Service, resultBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
      })

      yield* Effect.gen(function* () {
        yield* Service
        yield* settleEvents
        expect(yield* interactions.getResultRoute(targetTurn.id)).toMatchObject({ delivery: "awaiting-result" })
        expect(yield* interactions.getRootResult(targetTurn.id)).toBeUndefined()

        yield* Ref.set(finalAvailable, true)
        yield* TestClock.adjust("1 second")
        yield* settleEvents

        expect(yield* Ref.get(pageRequests)).toEqual([undefined, "page-one", undefined, "page-one"])
        const projection = yield* transcripts.get(targetTurn.id)
        expect(
          projection === undefined
            ? undefined
            : TranscriptProjection.Projection.finalAssistantOutput(projection, String(targetTurn.id)),
        ).toBe("proven final answer")
        expect(yield* interactions.getRootResult(targetTurn.id)).toMatchObject({
          status: "completed",
          output: "proven final answer",
        })
        expect(yield* interactions.getResultRoute(targetTurn.id)).toMatchObject({ delivery: "delivered" })
        expect(
          (yield* interactions.getMessages(source.id)).filter((turn) => turn.prompt === "proven final answer"),
        ).toHaveLength(1)
        expect(yield* Ref.get(pageRequests)).toEqual([undefined, "page-one", undefined, "page-one"])
      }).pipe(runWithChildDelegationLayer(layer))
    }),
  )

  it.effect("settles failed and cancelled child routes without delivering completed result messages", () =>
    Effect.gen(function* () {
      const source = selectionThread("terminal-result-source")
      const failedThread = selectionThread("terminal-result-failed")
      const cancelledThread = selectionThread("terminal-result-cancelled")
      const sourceTurn: Turn.Turn = {
        id: Turn.TurnId.make("terminal-result-source-turn"),
        ...turnProvenance,
        threadId: source.id,
        prompt: "delegate work",
        executionRoute: executionRoute(),
        status: "completed",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      }
      const targetTurn = (
        id: string,
        thread: Thread.Thread,
        status: "failed" | "cancelled",
      ): Turn.AgentExecutionTurn => ({
        _tag: "AgentExecution",
        id: Turn.TurnId.make(id),
        threadId: thread.id,
        prompt: `${status} delegated work`,
        executionRoute: executionRoute(),
        author: {
          _tag: "Agent",
          sourceThreadId: source.id,
          sourceRootTurnId: sourceTurn.id,
          threadCreationDepth: 1,
        },
        lineage: { _tag: "Original" },
        status,
        stopIntent: "none",
        createdAt: 2,
        updatedAt: 3,
      })
      const failedTurn = targetTurn("terminal-result-failed-turn", failedThread, "failed")
      const cancelledTurn = targetTurn("terminal-result-cancelled-turn", cancelledThread, "cancelled")
      const interactions = yield* ThreadInteractionRepository.makeMemory({ threads: [source], turns: [sourceTurn] })
      for (const [index, target] of [
        [0, failedTurn],
        [1, cancelledTurn],
      ] as const)
        yield* interactions.createThread({
          invocationDigest: `terminal-result-create-${index}`,
          schemaInputDigest: `terminal-result-create-${index}`,
          sourceThreadId: source.id,
          sourceRootTurnId: sourceTurn.id,
          now: 2 + index,
          maximumDepth: 3,
          maximumAdmissions: 8,
          maximumWorkspaceActive: 8,
          queueCapacity: 8,
          threadId: target.threadId,
          turnId: target.id,
          prompt: target.prompt,
          title: target.threadId,
          executionRoute: target.executionRoute,
          resultDelivery: "reply",
          threadCreationDepth: 1,
        })
      const terminalBackend = ExecutionBackend.Service.of({
        ...backend,
        replay: (turnId) => {
          const status = turnId === failedTurn.id ? ("failed" as const) : ("cancelled" as const)
          return Effect.succeed({
            turnId,
            status,
            events: [
              executionStarted(String(turnId)),
              {
                executionId: String(turnId),
                cursor: `${turnId}:terminal`,
                sequence: 1,
                type: status === "failed" ? "execution.failed" : "execution.cancelled",
                timestampSource: "server",
                createdAt: 3,
                text: `${status} reason`,
                data: { reason: `${status} reason` },
              },
            ],
          })
        },
      })
      const turns = yield* TurnRepository.makeMemory([sourceTurn, failedTurn, cancelledTurn])
      const layer = childDelegationLayer({
        repositoryLayer: ThreadRepository.memoryLayer([source, failedThread, cancelledThread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        transcriptRepositoryLayer: TranscriptRepository.memoryLayer,
        threadInteractionRepositoryLayer: Layer.succeed(ThreadInteractionRepository.Service, interactions),
        backendLayer: Layer.succeed(ExecutionBackend.Service, terminalBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
      })

      yield* Effect.gen(function* () {
        yield* Service
        yield* settleEvents

        expect(yield* interactions.getResultRoute(failedTurn.id)).toMatchObject({ delivery: "failed" })
        expect(yield* interactions.getRootResult(failedTurn.id)).toMatchObject({
          status: "failed",
          reason: "failed reason",
        })
        expect(yield* interactions.getResultRoute(cancelledTurn.id)).toMatchObject({ delivery: "cancelled" })
        expect(yield* interactions.getRootResult(cancelledTurn.id)).toEqual({ status: "cancelled" })
        expect(yield* interactions.listUndeliveredResults()).toEqual([])
        expect(yield* interactions.getMessages(source.id)).toEqual([sourceTurn])
      }).pipe(runWithChildDelegationLayer(layer))
    }),
  )

  it.effect("projects a truncated subagent as a failed delegation instead of a silent completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const noReport = truncatedDelegationReport(
          "child:execution%3Atruncated-turn:call-1",
          "The subagent's final model turn ended before the provider reported why it stopped, so the stream was cut off and no report was produced.",
        )
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        const truncatedBackend = ExecutionBackend.Service.of({
          ...backend,
          start: (input) =>
            Effect.succeed({
              turnId: input.turnId,
              status: "completed" as const,
              events: [
                executionStarted(String(input.turnId)),
                delegationEvent(String(input.turnId), "cursor-call", 1, "tool.call.requested", {
                  tool_call_id: "call-1",
                  tool_name: "oracle",
                  input: { prompt: "review the plan" },
                }),
                delegationEvent(String(input.turnId), "cursor-result", 2, "tool.result.received", {
                  tool_call_id: "call-1",
                  tool_name: "oracle",
                  output: noReport,
                }),
                delegationEvent(String(input.turnId), "cursor-done", 3, "execution.completed", {}),
              ],
            }),
        })
        const layer = childDelegationLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
          backendLayer: Layer.succeed(ExecutionBackend.Service, truncatedBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("truncated-thread")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("truncated-turn")),
          interactive: (_, session) =>
            Effect.gen(function* () {
              yield* session.submit("delegate the review")
              const terminal = yield* Queue.unbounded<void>()
              const runSync = Effect.runSyncWith(yield* Effect.context<never>())
              yield* Effect.raceFirst(
                session.events((event) => {
                  if (event._tag === "TranscriptProjectionStopped" && event.status === "completed")
                    runSync(Queue.offer(terminal, undefined))
                }),
                Queue.take(terminal),
              )
            }),
        })
        yield* Effect.gen(function* () {
          const operation = yield* Service
          yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
        }).pipe(runWithChildDelegationLayer(layer))

        const projection = yield* transcripts.get(Turn.TurnId.make("truncated-turn"))
        const delegation = projection?.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? [unit.content.block] : [],
        )
        expect(delegation).toHaveLength(1)
        expect(delegation?.[0]?.status).toBe("failed")
        expect(delegation?.[0]?.output).toContain(noReport.reason)
        expect(delegation?.[0]?.output).toContain(noReportRecovery)
      }),
    ),
  )
})
