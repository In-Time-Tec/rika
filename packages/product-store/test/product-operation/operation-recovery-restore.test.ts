import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Deferred, Duration, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { ExecutionIngest, Operation } from "@rika/product/product-operation-service"
import { executionRoute } from "../support/product-test-current-state"
import { storeProjection, withNestedProjections } from "../support/product-test-transcript-fixture"
import { productLayer, provideLayer } from "../support/operation-layer-harness"
import { collectEvents, holdSession, openInteractiveSession, settleEvents } from "../support/operation-session-harness"
import { executionStarted, backend } from "../support/operation-execution-fixtures"

import { turnProvenance, selectionThread } from "../support/operation-selection-fixtures"

describe("Operation", () => {
  it.effect("loads a current nonterminal transcript without reading Relay", () =>
    Effect.gen(function* () {
      const thread = selectionThread("sql-reopen-thread")
      const turn: Turn.AgentExecutionTurn = {
        id: Turn.TurnId.make("sql-reopen-turn"),
        ...turnProvenance,
        threadId: thread.id,
        prompt: "already projected",
        executionRoute: executionRoute(),
        status: "running",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 2,
      }
      const turns = yield* TurnRepository.makeMemory([turn])
      const transcripts = yield* TranscriptRepository.makeMemory({ turns })
      const projection = TranscriptProjection.Projection.project(String(turn.id), turn.prompt, [
        {
          cursor: "projected-answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 2,
          text: "durable SQL answer",
        },
      ])
      yield* storeProjection(transcripts, turn, projection)
      const relayReads = yield* Ref.make<ReadonlyArray<string>>([])
      const residentInspected = yield* Deferred.make<void>()
      const readRecordingBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Deferred.succeed(residentInspected, undefined).pipe(
            Effect.andThen(Ref.update(relayReads, (reads) => [...reads, `inspect:${turnId}`])),
            Effect.as({ turnId, status: "running" as const, waits: [], pendingTools: [], children: [] }),
          ),
        replay: (turnId) =>
          Ref.update(relayReads, (reads) => [...reads, `replay:${turnId}`]).pipe(
            Effect.as({ turnId, status: "running" as const, events: [] }),
          ),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const received: Array<Operation.InteractiveEvent> = []

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* collectEvents(session, received)
        yield* Deferred.await(residentInspected)
        yield* settleEvents
        expect(yield* Ref.get(relayReads)).toContain(`inspect:${turn.id}`)
        yield* Ref.set(relayReads, [])
        yield* session.selectThread(thread.id, 1)
        yield* settleEvents
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
            backendLayer: Layer.succeed(ExecutionBackend.Service, readRecordingBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )

      const loaded = received.find((event) => event._tag === "SelectionLoaded")
      expect(loaded?._tag === "SelectionLoaded" ? loaded.activeTurn?.id : undefined).toBe(turn.id)
      expect(
        loaded?._tag === "SelectionLoaded"
          ? loaded.entries.some(
              (entry) =>
                entry.unit.content._tag === "Entry" &&
                entry.unit.content.role === "assistant" &&
                entry.unit.content.text === "durable SQL answer",
            )
          : false,
      ).toBe(true)
      expect(yield* Ref.get(relayReads)).toEqual([])
    }),
  )

  it.effect("recovers an unfinished child under a terminal root before any thread is selected", () =>
    Effect.gen(function* () {
      const thread = selectionThread("terminal-child-recovery-thread")
      const turn: Turn.AgentExecutionTurn = {
        id: Turn.TurnId.make("terminal-child-recovery-turn"),
        ...turnProvenance,
        threadId: thread.id,
        prompt: "delegate",
        executionRoute: executionRoute(),
        status: "completed",
        stopIntent: "none",
        lastCursor: "root-done",
        createdAt: 1,
        updatedAt: 4,
      }
      const childId = `child:${turn.id}:call_1`
      const root = TranscriptProjection.Projection.project(String(turn.id), turn.prompt, [
        {
          cursor: "root-tool",
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "call_1", tool_name: "task", input: { prompt: "review" } },
        },
        {
          cursor: "root-child",
          sequence: 2,
          type: "child_run.spawned",
          createdAt: 2,
          data: { child_execution_id: childId, preset_name: "Oracle" },
        },
        {
          cursor: "root-done",
          sequence: 3,
          type: "execution.completed",
          createdAt: 3,
        },
      ])
      const child = TranscriptProjection.Projection.project(childId, "", [
        {
          cursor: "child-answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 3,
          text: "child answer",
        },
      ])
      const parent = root.units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall")
      if (parent?.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
        return yield* Effect.die("root projection has no delegation tool")
      const stored = withNestedProjections(root, [{ parentId: parent.content.block.id, projection: child }])
      const turns = yield* TurnRepository.makeMemory([turn])
      const transcripts = yield* TranscriptRepository.makeMemory({ turns })
      yield* storeProjection(transcripts, turn, stored, {
        consumed: {
          [TranscriptCorrelation.executionKey(String(turn.id))]: {
            cursor: "root-done",
            sequence: 3,
            status: "completed",
          },
          [TranscriptCorrelation.executionKey(childId)]: { cursor: "child-answer", sequence: 1 },
        },
        executionStates: {
          [TranscriptCorrelation.executionKey(String(turn.id))]: TranscriptProjection.Projection.projectionState(root),
          [TranscriptCorrelation.executionKey(childId)]: TranscriptProjection.Projection.projectionState(child),
        },
        projectionVersion: ExecutionIngest.projectionVersion,
      })
      const relayReads = yield* Ref.make<ReadonlyArray<string>>([])
      const childFollowed = yield* Deferred.make<void>()
      const terminal = {
        executionId: childId,
        cursor: "child-done",
        sequence: 3,
        type: "execution.completed",
        timestampSource: "server",
        createdAt: 5,
      } satisfies ExecutionBackend.Event
      const started = { ...executionStarted(childId), sequence: 2, createdAt: 4 }
      const recoveryBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (executionId) =>
          Ref.update(relayReads, (reads) => [...reads, `inspect:${executionId}`]).pipe(
            Effect.andThen(
              executionId === String(turn.id)
                ? Effect.die("terminal root must not be inspected")
                : Effect.succeed({
                    turnId: executionId,
                    status: "completed" as const,
                    lastCursor: terminal.cursor,
                    waits: [],
                    pendingTools: [],
                    children: [],
                  }),
            ),
          ),
        replay: (executionId) =>
          Ref.update(relayReads, (reads) => [...reads, `replay:${executionId}`]).pipe(
            Effect.andThen(Effect.die("current projection must not replay")),
          ),
        follow: (executionId, afterCursor, onEvent) =>
          Ref.update(relayReads, (reads) => [
            ...reads,
            `follow:${executionId}:${typeof afterCursor === "string" ? afterCursor : afterCursor?.cursor}`,
          ]).pipe(
            Effect.andThen(Effect.sync(() => onEvent?.(started))),
            Effect.andThen(Effect.sync(() => onEvent?.(terminal))),
            Effect.andThen(Deferred.succeed(childFollowed, undefined)),
            Effect.as({
              turnId: executionId,
              status: "completed" as const,
              events: [started, terminal],
            }),
          ),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* settleEvents
        expect(yield* Deferred.isDone(childFollowed)).toBe(true)
        yield* settleEvents
        expect(
          (yield* transcripts.get(turn.id))?.executionCheckpoints.find(
            (checkpoint) => checkpoint.executionKey === TranscriptCorrelation.executionKey(childId),
          )?.status,
        ).toBe("completed")
        expect(yield* Ref.get(relayReads)).toEqual([`inspect:${childId}`, `follow:${childId}:child-answer`])

        yield* Ref.set(relayReads, [])
        yield* session.selectThread(thread.id, 1)
        yield* settleEvents
        expect(yield* Ref.get(relayReads)).toEqual([])
      }).pipe(
        provideLayer(
          productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
            backendLayer: Layer.succeed(ExecutionBackend.Service, recoveryBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
    }),
  )

  it.effect("records a stop intent for every nonterminal turn before settling it as cancelled", () =>
    Effect.gen(function* () {
      const quitTurn = (id: string, status: Turn.Status): Turn.Turn => ({
        ...turnProvenance,
        id: Turn.TurnId.make(id),
        threadId: Thread.ThreadId.make("quit-thread"),
        prompt: id,
        executionRoute: executionRoute(),
        status,
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      })
      const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
      const turns = yield* TurnRepository.makeMemory([
        quitTurn("quit-running", "running"),
        quitTurn("quit-waiting", "waiting"),
        quitTurn("quit-queued", "queued"),
        quitTurn("quit-completed", "completed"),
      ])
      const recordingBackend = ExecutionBackend.Service.of({
        ...backend,
        cancel: (turnId) =>
          Ref.update(cancelled, (values) => [...values, turnId]).pipe(
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
      })
      yield* Operation.stopActiveExecutionWork().pipe(
        provideLayer(
          Layer.mergeAll(
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, recordingBackend),
          ),
        ),
      )
      for (const id of ["quit-running", "quit-waiting"]) {
        const settled = yield* turns.get(Turn.TurnId.make(id))
        expect(settled?.status, id).toBe("cancelled")
        expect(settled?.stopIntent, id).toBe("requested")
      }
      for (const id of ["quit-queued", "quit-completed"]) {
        const untouched = yield* turns.get(Turn.TurnId.make(id))
        expect(untouched?.stopIntent, id).toBe("none")
      }
      expect((yield* turns.get(Turn.TurnId.make("quit-queued")))?.status).toBe("queued")
      expect((yield* Ref.get(cancelled)).toSorted()).toEqual(["quit-running", "quit-waiting"])
      expect(yield* turns.listStopRequested).toEqual([])
    }),
  )

  it.effect("settles recovered work whose thread no session watches and keeps watched threads running", () =>
    Effect.gen(function* () {
      const recoveredTurn = (id: string, threadId: string): Turn.Turn => ({
        ...turnProvenance,
        id: Turn.TurnId.make(id),
        threadId: Thread.ThreadId.make(threadId),
        prompt: id,
        executionRoute: executionRoute(),
        status: "running",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      })
      yield* TestClock.adjust("1 minute")
      const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
      const turns = yield* TurnRepository.makeMemory([
        recoveredTurn("abandoned-turn", "abandoned-thread"),
        recoveredTurn("watched-turn", "watched-thread"),
      ])
      const recordingBackend = ExecutionBackend.Service.of({
        ...backend,
        cancel: (turnId) =>
          Ref.update(cancelled, (values) => [...values, turnId]).pipe(
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
      })
      yield* Operation.settleAbandonedRecoveredWork(Duration.zero, () => new Set(["watched-thread"])).pipe(
        provideLayer(
          Layer.mergeAll(
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, recordingBackend),
          ),
        ),
      )
      const abandoned = yield* turns.get(Turn.TurnId.make("abandoned-turn"))
      expect(abandoned?.status).toBe("cancelled")
      expect(abandoned?.stopIntent).toBe("requested")
      const watched = yield* turns.get(Turn.TurnId.make("watched-turn"))
      expect(watched?.status).toBe("running")
      expect(watched?.stopIntent).toBe("none")
      expect(yield* Ref.get(cancelled)).toEqual(["abandoned-turn"])
    }),
  )

  it.effect("cancels open root executions with no live turn row after the recovery window", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute")
      const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
      const turns = yield* TurnRepository.makeMemory([])
      const listingBackend = ExecutionBackend.Service.of({
        ...backend,
        listOpenRootExecutions: Effect.succeed([
          { executionId: "execution:orphan-turn", turnId: "orphan-turn", createdAt: 0 },
          { executionId: "execution:fresh-turn", turnId: "fresh-turn", createdAt: Number.MAX_SAFE_INTEGER },
        ]),
        cancel: (turnId) =>
          Ref.update(cancelled, (values) => [...values, turnId]).pipe(
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
      })
      yield* Operation.settleAbandonedRecoveredWork(Duration.zero, () => new Set()).pipe(
        provideLayer(
          Layer.mergeAll(
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, listingBackend),
          ),
        ),
      )
      expect(yield* Ref.get(cancelled)).toEqual(["execution:orphan-turn"])
    }),
  )
})
