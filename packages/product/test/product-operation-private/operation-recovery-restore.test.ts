import * as ExecutionIngest from "../../src/execution/ingest/execution-ingest-service"
import { stopActiveExecutionWork } from "../../src/execution/lifecycle/product-execution-stop"
import { settleAbandonedRecoveredWork } from "../../src/execution/lifecycle/abandoned-product-work-settlement"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { Fixtures } from "./operation-recovery-restore-fixtures"

describe("Operation", () => {
  it.effect("loads a current nonterminal transcript without reading Relay", () =>
    Effect.gen(function* () {
      const thread = Fixtures.selectionThread("sql-reopen-thread")
      const turn: Fixtures.Turn.AgentExecutionTurn = {
        id: Fixtures.Turn.TurnId.make("sql-reopen-turn"),
        ...Fixtures.turnProvenance,
        threadId: thread.id,
        prompt: "already projected",
        executionRoute: Fixtures.executionRoute(),
        status: "running",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 2,
      }
      const turns = yield* Fixtures.TurnRepository.makeMemory([turn])
      const transcripts = yield* Fixtures.TranscriptRepository.makeMemory({ turns })
      const projection = Fixtures.TranscriptProjection.Projection.project(String(turn.id), turn.prompt, [
        {
          cursor: "projected-answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 2,
          text: "durable SQL answer",
        },
      ])
      yield* Fixtures.storeProjection(transcripts, turn, projection)
      const relayReads = yield* Ref.make<ReadonlyArray<string>>([])
      const residentInspected = yield* Deferred.make<void>()
      const readRecordingBackend = Fixtures.ExecutionBackend.Service.of({
        ...Fixtures.backend,
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
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
      const received: Array<InteractiveEvent> = []

      yield* Effect.gen(function* () {
        const session = yield* Fixtures.openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Fixtures.collectEvents(session, received)
        yield* Deferred.await(residentInspected)
        yield* Fixtures.settleEvents
        expect(yield* Ref.get(relayReads)).toContain(`inspect:${turn.id}`)
        yield* Ref.set(relayReads, [])
        yield* session.selectThread(thread.id, 1)
        yield* Fixtures.settleEvents
      }).pipe(
        Fixtures.provideLayer(
          Fixtures.productLayer({
            repositoryLayer: Fixtures.ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(Fixtures.TurnRepository.Service, turns),
            transcriptRepositoryLayer: Layer.succeed(Fixtures.TranscriptRepository.Service, transcripts),
            backendLayer: Layer.succeed(Fixtures.ExecutionBackend.Service, readRecordingBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: Fixtures.holdSession(sessions),
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
      const thread = Fixtures.selectionThread("terminal-child-recovery-thread")
      const turn: Fixtures.Turn.AgentExecutionTurn = {
        id: Fixtures.Turn.TurnId.make("terminal-child-recovery-turn"),
        ...Fixtures.turnProvenance,
        threadId: thread.id,
        prompt: "delegate",
        executionRoute: Fixtures.executionRoute(),
        status: "completed",
        stopIntent: "none",
        lastCursor: "root-done",
        createdAt: 1,
        updatedAt: 4,
      }
      const childId = `child:${turn.id}:call_1`
      const root = Fixtures.TranscriptProjection.Projection.project(String(turn.id), turn.prompt, [
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
      const child = Fixtures.TranscriptProjection.Projection.project(childId, "", [
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
      const stored = Fixtures.withNestedProjections(root, [{ parentId: parent.content.block.id, projection: child }])
      const turns = yield* Fixtures.TurnRepository.makeMemory([turn])
      const transcripts = yield* Fixtures.TranscriptRepository.makeMemory({ turns })
      yield* Fixtures.storeProjection(transcripts, turn, stored, {
        consumed: {
          [Fixtures.TranscriptCorrelation.executionKey(String(turn.id))]: {
            cursor: "root-done",
            sequence: 3,
            status: "completed",
          },
          [Fixtures.TranscriptCorrelation.executionKey(childId)]: { cursor: "child-answer", sequence: 1 },
        },
        executionStates: {
          [Fixtures.TranscriptCorrelation.executionKey(String(turn.id))]:
            Fixtures.TranscriptProjection.Projection.projectionState(root),
          [Fixtures.TranscriptCorrelation.executionKey(childId)]:
            Fixtures.TranscriptProjection.Projection.projectionState(child),
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
      } satisfies Fixtures.ExecutionBackend.Event
      const started = { ...Fixtures.executionStarted(childId), sequence: 2, createdAt: 4 }
      const recoveryBackend = Fixtures.ExecutionBackend.Service.of({
        ...Fixtures.backend,
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
      const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])

      yield* Effect.gen(function* () {
        const session = yield* Fixtures.openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Fixtures.settleEvents
        expect(yield* Deferred.isDone(childFollowed)).toBe(true)
        yield* Fixtures.settleEvents
        expect(
          (yield* transcripts.get(turn.id))?.executionCheckpoints.find(
            (checkpoint) => checkpoint.executionKey === Fixtures.TranscriptCorrelation.executionKey(childId),
          )?.status,
        ).toBe("completed")
        expect(yield* Ref.get(relayReads)).toEqual([`inspect:${childId}`, `follow:${childId}:child-answer`])

        yield* Ref.set(relayReads, [])
        yield* session.selectThread(thread.id, 1)
        yield* Fixtures.settleEvents
        expect(yield* Ref.get(relayReads)).toEqual([])
      }).pipe(
        Fixtures.provideLayer(
          Fixtures.productLayer({
            repositoryLayer: Fixtures.ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(Fixtures.TurnRepository.Service, turns),
            transcriptRepositoryLayer: Layer.succeed(Fixtures.TranscriptRepository.Service, transcripts),
            backendLayer: Layer.succeed(Fixtures.ExecutionBackend.Service, recoveryBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: Fixtures.holdSession(sessions),
          }),
        ),
      )
    }),
  )

  it.effect("records a stop intent for every nonterminal turn before settling it as cancelled", () =>
    Effect.gen(function* () {
      const quitTurn = (id: string, status: Fixtures.ExecutionStatus.Status): Fixtures.Turn.Turn => ({
        ...Fixtures.turnProvenance,
        id: Fixtures.Turn.TurnId.make(id),
        threadId: Fixtures.Thread.ThreadId.make("quit-thread"),
        prompt: id,
        executionRoute: Fixtures.executionRoute(),
        status,
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      })
      const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
      const turns = yield* Fixtures.TurnRepository.makeMemory([
        quitTurn("quit-running", "running"),
        quitTurn("quit-waiting", "waiting"),
        quitTurn("quit-queued", "queued"),
        quitTurn("quit-completed", "completed"),
      ])
      const recordingBackend = Fixtures.ExecutionBackend.Service.of({
        ...Fixtures.backend,
        cancel: (turnId) =>
          Ref.update(cancelled, (values) => [...values, turnId]).pipe(
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
      })
      yield* stopActiveExecutionWork().pipe(
        Fixtures.provideLayer(
          Layer.mergeAll(
            Layer.succeed(Fixtures.TurnRepository.Service, turns),
            Layer.succeed(Fixtures.ExecutionBackend.Service, recordingBackend),
          ),
        ),
      )
      for (const id of ["quit-running", "quit-waiting"]) {
        const settled = yield* turns.get(Fixtures.Turn.TurnId.make(id))
        expect(settled?.status, id).toBe("cancelled")
        expect(settled?.stopIntent, id).toBe("requested")
      }
      for (const id of ["quit-queued", "quit-completed"]) {
        const untouched = yield* turns.get(Fixtures.Turn.TurnId.make(id))
        expect(untouched?.stopIntent, id).toBe("none")
      }
      expect((yield* turns.get(Fixtures.Turn.TurnId.make("quit-queued")))?.status).toBe("queued")
      expect((yield* Ref.get(cancelled)).toSorted()).toEqual(["quit-running", "quit-waiting"])
      expect(yield* turns.listStopRequested).toEqual([])
    }),
  )

  it.effect("settles recovered work whose thread no session watches and keeps watched threads running", () =>
    Effect.gen(function* () {
      const recoveredTurn = (id: string, threadId: string): Fixtures.Turn.Turn => ({
        ...Fixtures.turnProvenance,
        id: Fixtures.Turn.TurnId.make(id),
        threadId: Fixtures.Thread.ThreadId.make(threadId),
        prompt: id,
        executionRoute: Fixtures.executionRoute(),
        status: "running",
        stopIntent: "none",
        createdAt: 1,
        updatedAt: 1,
      })
      yield* TestClock.adjust("1 minute")
      const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
      const turns = yield* Fixtures.TurnRepository.makeMemory([
        recoveredTurn("abandoned-turn", "abandoned-thread"),
        recoveredTurn("watched-turn", "watched-thread"),
      ])
      const recordingBackend = Fixtures.ExecutionBackend.Service.of({
        ...Fixtures.backend,
        cancel: (turnId) =>
          Ref.update(cancelled, (values) => [...values, turnId]).pipe(
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
      })
      yield* settleAbandonedRecoveredWork(Duration.zero, () => new Set(["watched-thread"])).pipe(
        Fixtures.provideLayer(
          Layer.mergeAll(
            Layer.succeed(Fixtures.TurnRepository.Service, turns),
            Layer.succeed(Fixtures.ExecutionBackend.Service, recordingBackend),
          ),
        ),
      )
      const abandoned = yield* turns.get(Fixtures.Turn.TurnId.make("abandoned-turn"))
      expect(abandoned?.status).toBe("cancelled")
      expect(abandoned?.stopIntent).toBe("requested")
      const watched = yield* turns.get(Fixtures.Turn.TurnId.make("watched-turn"))
      expect(watched?.status).toBe("running")
      expect(watched?.stopIntent).toBe("none")
      expect(yield* Ref.get(cancelled)).toEqual(["abandoned-turn"])
    }),
  )

  it.effect("cancels open root executions with no live turn row after the recovery window", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("1 minute")
      const cancelled = yield* Ref.make<ReadonlyArray<string>>([])
      const turns = yield* Fixtures.TurnRepository.makeMemory([])
      const listingBackend = Fixtures.ExecutionBackend.Service.of({
        ...Fixtures.backend,
        listOpenRootExecutions: Effect.succeed([
          { executionId: "execution:orphan-turn", turnId: "orphan-turn", createdAt: 0 },
          { executionId: "execution:fresh-turn", turnId: "fresh-turn", createdAt: Number.MAX_SAFE_INTEGER },
        ]),
        cancel: (turnId) =>
          Ref.update(cancelled, (values) => [...values, turnId]).pipe(
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
      })
      yield* settleAbandonedRecoveredWork(Duration.zero, () => new Set()).pipe(
        Fixtures.provideLayer(
          Layer.mergeAll(
            Layer.succeed(Fixtures.TurnRepository.Service, turns),
            Layer.succeed(Fixtures.ExecutionBackend.Service, listingBackend),
          ),
        ),
      )
      expect(yield* Ref.get(cancelled)).toEqual(["execution:orphan-turn"])
    }),
  )
})
