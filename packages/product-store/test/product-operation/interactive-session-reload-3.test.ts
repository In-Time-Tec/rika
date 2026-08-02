import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"
import { projectionVersion } from "./interactive-session-base-support"
import {
  subagentToolId,
  subagentChildId,
  subagentRootEvents,
  subagentChildEvents,
  makeSubagentReloadHarness,
  selectionEntriesFor,
} from "./interactive-session-reload-support"

describe("InteractiveSession subagent reload", () => {
  it.effect("does not promote an invalidated projection while Relay reports active execution", () =>
    Effect.gen(function* () {
      let inspections = 0
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: TranscriptFixtures.TranscriptProjection.Projection.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: [],
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
        inspection: (executionId) => {
          inspections += 1
          return {
            turnId: executionId,
            status: "running",
            lastCursor: "done-final",
            waits: [],
            pendingTools: [],
            children: [],
          }
        },
      })

      const { events } = yield* selectionEntriesFor(session, subagentThread.id)
      for (
        let attempt = 0;
        attempt < 400 && !events.some((event) => event._tag === "TranscriptProjectionFailed");
        attempt += 1
      )
        yield* Effect.yieldNow
      expect((yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done")))?.projectionVersion).toBe(
        RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
      )
      expect(events.some((event) => event._tag === "TranscriptProjectionFailed")).toBe(true)
      const firstInspections = inspections
      yield* session.reopenThread(2)
      expect(inspections).toBe(firstInspections)
    }),
  )

  it.effect("leaves a descendant unconsumed until Relay can read it", () =>
    Effect.gen(function* () {
      let childAvailable = false
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: TranscriptFixtures.TranscriptProjection.Projection.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
        inspection: (executionId) => {
          if (executionId !== "done")
            return childAvailable
              ? {
                  turnId: executionId,
                  status: "running",
                  waits: [],
                  pendingTools: [],
                  children: [],
                }
              : undefined
          return {
            turnId: executionId,
            status: "completed",
            lastCursor: "done-final",
            waits: [],
            pendingTools: [],
            children: [{ executionId: subagentChildId, status: "completed" }],
          }
        },
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const unreadable = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done"))
      expect(unreadable?.projectionVersion).toBe(RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion)
      expect(
        unreadable?.executionCheckpoints.find((entry) => entry.executionKey === subagentChildId)?.status,
      ).toBeUndefined()

      childAvailable = true
      yield* session.reopenThread(2)
      for (
        let attempt = 0;
        attempt < 400 &&
        (yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done")))?.projectionVersion !== projectionVersion;
        attempt += 1
      )
        yield* Effect.yieldNow
      const readable = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done"))
      expect(readable?.executionCheckpoints.find((entry) => entry.executionKey === subagentChildId)?.status).toBe(
        "completed",
      )
      expect(
        readable?.units.some(
          (unit) =>
            unit.parentId === subagentToolId &&
            unit.content._tag === "Entry" &&
            unit.content.text.includes("All tests pass."),
        ),
      ).toBe(true)
    }),
  )

  it.effect("rejects an inspection-only child that has no durable parent attachment", () =>
    Effect.gen(function* () {
      const lateChild = `${subagentChildId}:late`
      let rootInspections = 0
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: TranscriptFixtures.TranscriptProjection.Projection.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
        inspection: (executionId) => {
          if (executionId === "done") rootInspections += 1
          return {
            turnId: executionId,
            status: "completed",
            lastCursor: executionId === "done" ? "done-final" : "childdone~a4",
            waits: [],
            pendingTools: [],
            children:
              executionId !== "done"
                ? []
                : [
                    { executionId: subagentChildId, status: "completed" },
                    ...(rootInspections > 1 ? [{ executionId: lateChild, status: "completed" as const }] : []),
                  ],
          }
        },
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      for (
        let attempt = 0;
        attempt < 400 &&
        (yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done")))?.projectionVersion !== projectionVersion;
        attempt += 1
      )
        yield* Effect.yieldNow
      expect(rootInspections).toBeGreaterThan(1)
      const stored = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(projectionVersion)
      expect(stored?.executionCheckpoints.find((entry) => entry.executionKey === lateChild)).toBeUndefined()
    }),
  )

  it.effect("refolds only durable root and child events and excludes stale stored children", () =>
    Effect.gen(function* () {
      const staleChild = TranscriptFixtures.TranscriptProjection.Projection.project(subagentChildId, "", [
        ...subagentChildEvents,
        {
          cursor: "stale-child",
          sequence: 100,
          type: "model.output.completed",
          createdAt: 100,
          text: "stale stored child",
        },
      ])
      const orphan = TranscriptFixtures.TranscriptProjection.Projection.project("orphan-child", "", [
        {
          cursor: "orphan-answer",
          sequence: 200,
          type: "model.output.completed",
          createdAt: 200,
          text: "orphan stored child",
        },
      ])
      const staleTree = TranscriptFixtures.TranscriptNestedProjection.withNestedProjections(
        TranscriptFixtures.TranscriptProjection.Projection.project("done", "wrong stored prompt", subagentRootEvents),
        [{ parentId: subagentToolId, projection: staleChild }],
      )
      const staleParent = staleTree.units.find(
        (unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
      )!
      const storedTree = {
        ...staleTree,
        units: staleTree.units.concat(
          orphan.units.map((unit) =>
            TranscriptFixtures.TranscriptNestedProjection.attachUnit(
              unit,
              staleParent,
              "orphan-parent",
              "orphan-child",
            ),
          ),
        ),
      }
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree,
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
        replayEvents: (executionId) => (executionId === "done" ? subagentRootEvents : subagentChildEvents),
        inspection: (executionId) => ({
          turnId: executionId,
          status: "completed",
          lastCursor: executionId === "done" ? "done-final" : "childdone~a4",
          waits: [],
          pendingTools: [],
          children: executionId === "done" ? [{ executionId: subagentChildId, status: "completed" }] : [],
        }),
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(projectionVersion)
      expect(stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "delegate")).toBe(true)
      expect(
        stored?.units.some(
          (unit) =>
            unit.content._tag === "Entry" && ["stale stored child", "orphan stored child"].includes(unit.content.text),
        ),
      ).toBe(false)
    }),
  )

  it.effect("does not promote a refold when Relay cannot replay the root", () =>
    Effect.gen(function* () {
      const { session, subagentThread, transcripts } = yield* makeSubagentReloadHarness({
        storedTree: TranscriptFixtures.TranscriptProjection.Projection.project("done", "delegate", subagentRootEvents),
        turnLastCursor: "done-final",
        childReplayEvents: subagentChildEvents,
        projectionVersion: RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion,
        replayEvents: (executionId) => (executionId === subagentChildId ? subagentChildEvents : []),
      })

      yield* selectionEntriesFor(session, subagentThread.id)
      const stored = yield* transcripts.get(RuntimeFixtures.Turn.TurnId.make("done"))
      expect(stored?.projectionVersion).toBe(RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion)
      expect(stored?.executionCheckpoints.find((entry) => entry.executionKey === "done")).toBeUndefined()
    }),
  )
})
