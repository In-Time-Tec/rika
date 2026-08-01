import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import {
  RuntimeFixtures,
  TranscriptFixtures,
  Effect,
  Ref,
  collectEvents,
  subagentToolId,
  subagentChildId,
  subagentRootEvents,
  subagentChildEvents,
  makeSubagentReloadHarness,
  selectionEntriesFor,
  nestedSubagentReady,
  nestedSubagentExpectations,
} from "./interactive-session-reload-support"

describe("InteractiveSession subagent reload", () => {
  it.effect("renders an already-completed child from persisted units after following it once", () =>
    Effect.gen(function* () {
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const rootProjection = TranscriptFixtures.TranscriptProjection.Projection.project(
        "done",
        "delegate",
        subagentRootEvents.slice(0, 3),
      )
      const storedTree = TranscriptFixtures.TranscriptNestedProjection.withNestedProjections(rootProjection, [
        {
          parentId: subagentToolId,
          projection: TranscriptFixtures.TranscriptProjection.Projection.empty(subagentChildId, ""),
        },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: subagentRootEvents[2]!.cursor,
        replayEvents: (executionId) => (executionId === "done" ? subagentRootEvents.slice(0, 3) : subagentChildEvents),
        childReplayEvents: subagentChildEvents,
        turnStatus: "running",
        followed,
      })

      const { entries } = yield* selectionEntriesFor(session, subagentThread.id, nestedSubagentReady)
      const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
      expect(nestedTool).toBe(true)
      expect(nestedAnswer).toBe(true)
      expect((yield* Ref.get(followed)).filter((executionId) => executionId === subagentChildId)).toHaveLength(1)
    }),
  )

  it.effect("rediscovers an active nested follower below a failed root during reload", () =>
    Effect.gen(function* () {
      const nestedId = `child:${encodeURIComponent(subagentChildId)}:nested`
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const childEvents: ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event> = [
        {
          executionId: subagentChildId,
          cursor: "nested-call",
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "nested" } },
        },
        {
          executionId: subagentChildId,
          cursor: "nested-spawn",
          sequence: 2,
          type: "child_run.spawned",
          createdAt: 3,
          data: { tool_call_id: "nested", child_execution_id: nestedId },
        },
        {
          executionId: subagentChildId,
          cursor: "child-complete",
          sequence: 3,
          type: "execution.completed",
          createdAt: 5,
        },
      ]
      const nestedEvents: ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event> = [
        {
          executionId: nestedId,
          cursor: "nested-started",
          sequence: 0,
          type: "execution.started",
          createdAt: 4,
          timestampSource: "server",
        },
      ]
      const failedRootEvents: ReadonlyArray<RuntimeFixtures.ExecutionBackend.Event> = [
        ...subagentRootEvents.slice(0, 3),
        {
          executionId: "execution:done",
          cursor: "root-failed",
          sequence: 3,
          type: "execution.failed",
          createdAt: 6,
          text: "root failed after its descendants finished",
        },
      ]
      const inspection = (executionId: string): RuntimeFixtures.ExecutionBackend.Inspection => {
        let children: RuntimeFixtures.ExecutionBackend.Inspection["children"] = []
        if (executionId === "done") children = [{ executionId: subagentChildId, status: "completed" }]
        else if (executionId === subagentChildId) children = [{ executionId: nestedId, status: "running" }]
        let status: RuntimeFixtures.ExecutionBackend.Status = "running"
        if (executionId === "done") status = "failed"
        else if (executionId === subagentChildId) status = "completed"
        return {
          turnId: executionId,
          status,
          waits: [],
          pendingTools: [],
          children,
        }
      }
      const rootProjection = TranscriptFixtures.TranscriptProjection.Projection.project(
        "done",
        "delegate",
        failedRootEvents,
      )
      const storedTree = TranscriptFixtures.TranscriptNestedProjection.withNestedProjections(rootProjection, [
        {
          parentId: subagentToolId,
          projection: TranscriptFixtures.TranscriptProjection.Projection.empty(subagentChildId, ""),
        },
      ])
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "root-failed",
        childReplayEvents: childEvents,
        consumed: {
          done: { cursor: "root-failed", sequence: 3, status: "failed" },
          [TranscriptFixtures.TranscriptCorrelation.executionKey(subagentChildId)]: { cursor: "", sequence: -1 },
        },
        turnStatus: "failed",
        followed,
        inspection,
        replayEvents: (executionId) => {
          if (executionId === "done") return failedRootEvents
          if (executionId === subagentChildId) return childEvents
          if (executionId === nestedId) return nestedEvents
          return []
        },
      })
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(subagentThread.id, 1)
      for (
        let attempt = 0;
        attempt < 400 &&
        !events.some(
          (event) =>
            event._tag === "TranscriptProjectionPatched" &&
            event.origin._tag === "Event" &&
            event.origin.cursor === "nested-complete",
        );
        attempt += 1
      )
        yield* Effect.yieldNow

      expect(yield* Ref.get(followed)).toContain(nestedId)
      expect(events.some((event) => event._tag === "TranscriptProjectionFailed")).toBe(false)
    }),
  )

  it.effect("resumes an exact empty child checkpoint from its durable event suffix", () =>
    Effect.gen(function* () {
      const rootProjection = TranscriptFixtures.TranscriptProjection.Projection.project(
        "done",
        "delegate",
        subagentRootEvents,
      )
      const brokenTree = TranscriptFixtures.TranscriptNestedProjection.withNestedProjections(rootProjection, [
        {
          parentId: subagentToolId,
          projection: TranscriptFixtures.TranscriptProjection.Projection.empty(subagentChildId, ""),
        },
      ])
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: { ...brokenTree, pricingVersion: TranscriptFixtures.TranscriptUsage.pricingVersion },
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        consumed: {
          done: { cursor: "done-final", sequence: 5, status: "completed" },
          [TranscriptFixtures.TranscriptCorrelation.executionKey(subagentChildId)]: { cursor: "", sequence: -1 },
        },
      })
      const { entries, events } = yield* selectionEntriesFor(session, subagentThread.id, nestedSubagentReady)
      expect(events.filter((event) => event._tag === "SelectionLoaded")).toHaveLength(1)
      expect(events.some((event) => event._tag === "TranscriptProjectionFailed")).toBe(false)
      for (
        let attempt = 0;
        attempt < 400 &&
        (yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done")))?.executionCheckpoints.find(
          (checkpoint) =>
            checkpoint.executionKey === TranscriptFixtures.TranscriptCorrelation.executionKey(subagentChildId),
        )?.cursor !== "childdone~a4";
        attempt += 1
      )
        yield* Effect.yieldNow
      expect(
        (yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done")))?.executionCheckpoints.find(
          (checkpoint) =>
            checkpoint.executionKey === TranscriptFixtures.TranscriptCorrelation.executionKey(subagentChildId),
        ),
      ).toMatchObject({ cursor: "childdone~a4", status: "completed" })
      expect(
        entries.filter(
          (entry) =>
            entry.unit.turnId === subagentChildId &&
            entry.unit.content._tag === "Block" &&
            entry.unit.content.block._tag === "ToolCall" &&
            entry.unit.content.block.name === "bash",
        ),
      ).toHaveLength(1)
      expect(
        entries.filter(
          (entry) =>
            entry.unit.turnId === subagentChildId &&
            entry.unit.content._tag === "Entry" &&
            entry.unit.content.role === "assistant" &&
            entry.unit.content.text.includes("All tests pass."),
        ),
      ).toHaveLength(1)
    }),
  )

  it.effect("does not promote a refold when a terminal child exposes no durable events", () =>
    Effect.gen(function* () {
      const followed = yield* Ref.make<ReadonlyArray<string>>([])
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: TranscriptFixtures.TranscriptProjection.Projection.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: [],
        followed,
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
        inspection: (executionId) => ({
          turnId: executionId,
          status: "completed",
          ...(executionId === "done" ? { lastCursor: "done-final" } : {}),
          waits: [],
          pendingTools: [],
          children: executionId === "done" ? [{ executionId: subagentChildId, status: "completed" }] : [],
        }),
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion)
      expect(stored?.executionCheckpoints.find((entry) => entry.executionKey === subagentChildId)).toBeUndefined()
      const failedFollows = yield* Ref.get(followed)

      yield* session.reopenThread(2)
      for (let attempt = 0; attempt < 200; attempt += 1) yield* Effect.yieldNow
      expect((yield* Ref.get(followed)).length).toBeGreaterThan(failedFollows.length)
    }),
  )

  it.effect("keeps an invalidated projection empty when Relay cannot refold its child", () =>
    Effect.gen(function* () {
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: TranscriptFixtures.TranscriptProjection.Projection.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-later",
        childReplayEvents: [],
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
      })
      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion)
      expect(stored?.units).toEqual([])
      expect(stored?.executionCheckpoints).toEqual([])
    }),
  )

  it.effect("does not replay a refolded terminal child tree when the thread reopens", () =>
    Effect.gen(function* () {
      const rootProjection = TranscriptFixtures.TranscriptProjection.Projection.project(
        "done",
        "delegate",
        subagentRootEvents,
      )
      const childProjection = TranscriptFixtures.TranscriptProjection.Projection.project(
        subagentChildId,
        "",
        subagentChildEvents,
      )
      const attributedChildEvents = subagentChildEvents.map((event) => ({
        ...event,
        childExecutionId: subagentChildId,
      }))
      const storedTree = TranscriptFixtures.TranscriptNestedProjection.withNestedProjections(rootProjection, [
        { parentId: subagentToolId, projection: childProjection },
      ])
      let inspections = 0
      let eventPages = 0
      const inspection = (executionId: string): RuntimeFixtures.ExecutionBackend.Inspection => {
        inspections += 1
        return {
          turnId: executionId,
          status: "completed",
          lastCursor: executionId === "done" ? "done-final" : "childdone~a4",
          waits: [],
          pendingTools: [],
          children: executionId === "done" ? [{ executionId: subagentChildId, status: "completed" }] : [],
        }
      }
      const { session, subagentThread } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        inspection,
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
        replayEvents: (executionId) => {
          eventPages += 1
          if (executionId === "done") return subagentRootEvents
          return executionId === subagentChildId ? attributedChildEvents : []
        },
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const repairedInspections = inspections
      const repairedPages = eventPages
      expect(repairedInspections).toBeGreaterThan(0)
      expect(repairedPages).toBeGreaterThan(0)

      yield* session.reopenThread(2)
      expect(inspections).toBe(repairedInspections)
      expect(eventPages).toBe(repairedPages)
    }),
  )
})
