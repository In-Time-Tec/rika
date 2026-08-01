import { describe, expect, it } from "@effect/vitest"
import { makeHarness, settle } from "./execution-ingest-behavior-support"

import { ExecutionFixtures } from "./execution-ingest-fixtures"

import { Fixtures } from "./execution-ingest-support"
import * as ExecutionIngest from "../../src/execution/ingest/execution-ingest-service"
import { Context, Deferred, Effect, Exit, Layer, Ref, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"

describe("ExecutionIngest", () => {
  it.effect("rejects one durable cursor reused at a different sequence", () =>
    Effect.gen(function* () {
      const duplicateCursorEvents: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        ExecutionFixtures.started("root"),
        ExecutionFixtures.event("root", "duplicate", 1, "model.output.completed", { text: "first" }),
        ExecutionFixtures.event("root", "duplicate", 2, "model.output.completed", { text: "second" }),
        ExecutionFixtures.event("root", "terminal", 3, "execution.completed"),
      ]
      const { ingest, writes } = yield* makeHarness({
        script: { root: { events: duplicateCursorEvents, status: "completed" } },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      const result = yield* Effect.result(ingest.settled(ExecutionFixtures.rootId))

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("cursor-rejected")
        expect(result.failure.message).toContain("duplicate")
        expect(result.failure.message).toContain("sequence 1")
        expect(result.failure.message).toContain("sequence 2")
      }
      expect(writes).toEqual([])
    }),
  )

  it.effect("anchors a late watcher before delivering its first live patch", () =>
    Effect.gen(function* () {
      const { ingest, turns } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* ingest.consumed(ExecutionFixtures.rootId)
      ingest.deliver(ExecutionFixtures.rootId, ExecutionFixtures.started("root"))
      yield* ingest.flush(ExecutionFixtures.rootId)
      const watch = yield* ingest.watchThread(ExecutionFixtures.threadId)
      const anchor = watch.snapshots[0]
      if (anchor === undefined) return yield* Effect.die("active projection snapshot was not anchored")

      ingest.deliver(
        ExecutionFixtures.rootId,
        ExecutionFixtures.event("root", "answer", 1, "model.output.completed", { text: "answer" }),
      )
      const changes = yield* watch.changes.pipe(Stream.take(1), Stream.runCollect)
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({
        _tag: "ProjectionPatched",
        patch: {
          streamId: anchor.streamId,
          baseRevision: anchor.patchRevision,
          patchRevision: anchor.patchRevision + 1,
        },
      })

      yield* turns.setStatus(ExecutionFixtures.rootId, "completed", "done", 2)
      ingest.deliver(ExecutionFixtures.rootId, ExecutionFixtures.event("root", "done", 2, "execution.completed"))
      yield* settle(ingest)
    }),
  )

  it.effect("streams transient units without advancing the durable ExecutionFixtures.checkpoint", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, turns, writes } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* ingest.consumed(ExecutionFixtures.rootId)
      ingest.deliver(ExecutionFixtures.rootId, ExecutionFixtures.started("root"))
      yield* ingest.flush(ExecutionFixtures.rootId)
      const watch = yield* ingest.watchThread(ExecutionFixtures.threadId)
      const anchor = watch.snapshots[0]
      if (anchor === undefined) return yield* Effect.die("active projection snapshot was not anchored")
      const storedBefore = yield* transcripts.get(ExecutionFixtures.rootId)
      const writesBefore = writes.length

      ingest.deliver(
        ExecutionFixtures.rootId,
        ExecutionFixtures.event("root", "transient", 1, "model.output.delta", {
          text: "streamed",
          data: {
            delta: "streamed",
            transient_index: 1,
            model_call_id: "call",
            model_attempt_id: "attempt",
          },
        }),
      )
      const changes = yield* watch.changes.pipe(Stream.take(1), Stream.runCollect)
      const streamed = changes[0]
      expect(streamed?._tag).toBe("ProjectionPatched")
      if (streamed?._tag !== "ProjectionPatched") return
      expect(streamed.patch.state.revision).toBe(anchor.state.revision)
      expect(
        streamed.patch.delta.upsert.some((unit) => unit.content._tag === "Entry" && unit.content.text === "streamed"),
      ).toBe(true)

      yield* ingest.flush(ExecutionFixtures.rootId)
      expect(writes).toHaveLength(writesBefore)
      expect(yield* transcripts.get(ExecutionFixtures.rootId)).toEqual(storedBefore)

      ingest.deliver(
        ExecutionFixtures.rootId,
        ExecutionFixtures.event("root", "answer", 1, "model.output.completed", { text: "streamed" }),
      )
      yield* turns.setStatus(ExecutionFixtures.rootId, "completed", "done", 2)
      ingest.deliver(ExecutionFixtures.rootId, ExecutionFixtures.event("root", "done", 2, "execution.completed"))
      yield* settle(ingest)
    }),
  )

  it.effect("keeps ingest live while streamed parallel tool calls resolve one at a time", () =>
    Effect.gen(function* () {
      const toolIds = ["call-a", "call-b", "call-c", "call-d", "call-e"] as const
      const events: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        ExecutionFixtures.started("root"),
        ...toolIds.map((toolId, index) =>
          ExecutionFixtures.event("root", `transient-${toolId}`, 0, "model.toolcall.delta", {
            data: {
              delta: "{}",
              tool_call_id: toolId,
              tool_name: "read",
              transient_index: index + 1,
              model_call_id: "model-call",
              model_attempt_id: "model-attempt",
            },
          }),
        ),
        ...toolIds.map((toolId, index) =>
          ExecutionFixtures.event("root", `requested-${toolId}`, index + 1, "tool.call.requested", {
            data: { tool_call_id: toolId, tool_name: "read", input: { path: `${toolId}.txt` } },
          }),
        ),
        ...toolIds.map((toolId, index) =>
          ExecutionFixtures.event("root", `result-${toolId}`, index + 6, "tool.result.received", {
            data: { tool_call_id: toolId, tool_name: "read", output: toolId },
          }),
        ),
        ExecutionFixtures.event("root", "completed", 11, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events, status: "completed" } },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      const stored = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(
        stored?.units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"),
      ).toHaveLength(toolIds.length)
      expect(ExecutionFixtures.checkpoint(stored, "root")?.status).toBe("completed")
    }),
  )

  it.effect("removes a projection watcher when its scope closes", () =>
    Effect.gen(function* () {
      const { ingest } = yield* makeHarness({
        script: {
          root: {
            events: [
              ExecutionFixtures.started("root"),
              ExecutionFixtures.event("root", "done", 1, "execution.completed"),
            ],
            status: "completed",
          },
        },
      })
      const scope = yield* Scope.make()
      const watch = yield* ingest
        .watchThread(ExecutionFixtures.threadId)
        .pipe(Effect.provideService(Scope.Scope, scope))
      yield* Scope.close(scope, Exit.void)

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      expect(yield* Stream.runCollect(watch.changes)).toEqual([])
    }),
  )

  it.effect("fails a slow projection watcher explicitly when its bounded feed overflows", () =>
    Effect.gen(function* () {
      const { ingest } = yield* makeHarness({
        script: {
          root: {
            events: [
              ExecutionFixtures.started("root"),
              ExecutionFixtures.event("root", "done", 1, "execution.completed"),
            ],
            status: "completed",
          },
        },
        watchCapacity: 2,
      })
      const watch = yield* ingest.watchThread(ExecutionFixtures.threadId)

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)
      const result = yield* Effect.result(Stream.runCollect(watch.changes))

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ExecutionIngestProjectionWatchOverflow")
        expect(result.failure.threadId).toBe(String(ExecutionFixtures.threadId))
        expect(result.failure.capacity).toBe(2)
      }
    }),
  )

  it.effect("refolds a legacy projection once and reads nothing from the backend when it reopens", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, follows, inspections } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
        stored: {
          units: Fixtures.TranscriptProjection.Projection.empty(String(ExecutionFixtures.rootId), "go").units,
          revision: 4,
          modelPhase: 0,
        },
      })
      expect((yield* transcripts.get(ExecutionFixtures.rootId))?.projectionVersion).toBe(
        Fixtures.TranscriptRepository.invalidatedProjectionVersion,
      )

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      const refolded = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(refolded?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect(refolded?.units.some((unit) => unit.parentId !== undefined)).toBe(true)
      expect(ExecutionFixtures.checkpoint(refolded, String(ExecutionFixtures.rootId))?.status).toBe("completed")
      expect(ExecutionFixtures.checkpoint(refolded, ExecutionFixtures.childId)?.status).toBe("completed")
      const reads = follows.length + inspections.length
      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)
      expect(follows.length + inspections.length).toBe(reads)
    }),
  )

  it.effect("authoritatively corrects a completed turn from a versioned Relay refold", () =>
    Effect.gen(function* () {
      const failedEvents: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        ExecutionFixtures.started("root"),
        ExecutionFixtures.event("root", "failed", 1, "execution.failed", { text: "backend failed" }),
      ]
      const { ingest, transcripts, turns } = yield* makeHarness({
        script: { root: { events: failedEvents, status: "failed" } },
        turnStatus: "completed",
        stored: Fixtures.TranscriptProjection.Projection.empty(String(ExecutionFixtures.rootId), "delegate"),
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* ingest.settled(ExecutionFixtures.rootId)

      expect(yield* turns.get(ExecutionFixtures.rootId)).toMatchObject({ status: "failed", lastCursor: "failed" })
      const refolded = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(refolded).toMatchObject({
        turn: { status: "failed", lastCursor: "failed" },
        projectionVersion: ExecutionIngest.projectionVersion,
        checkpointGeneration: 1,
      })
      expect(ExecutionFixtures.checkpoint(refolded, String(ExecutionFixtures.rootId))).toMatchObject({
        cursor: "failed",
        sequence: 1,
        status: "failed",
      })
      expect(
        refolded?.units.find(
          (unit) =>
            unit.turnId === ExecutionFixtures.rootId &&
            unit.parentId === undefined &&
            unit.executionOutcome !== undefined,
        )?.executionOutcome,
      ).toMatchObject({ status: "failed" })
    }),
  )

  it.effect("reports the refold of a legacy projection and reports nothing when the consumed thread reopens", () =>
    Effect.gen(function* () {
      const { ingest, refolds } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
        stored: {
          units: Fixtures.TranscriptProjection.Projection.empty(String(ExecutionFixtures.rootId), "go").units,
          revision: 4,
          modelPhase: 0,
        },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      expect(refolds.map((refold) => refold.phase)).toEqual(["started", "finished"])
      expect(refolds.every((refold) => String(refold.rootTurnId) === String(ExecutionFixtures.rootId))).toBe(true)
      expect(refolds.every((refold) => String(refold.threadId) === String(ExecutionFixtures.threadId))).toBe(true)

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      expect(refolds).toHaveLength(2)
    }),
  )

  it.effect("reports current refold state to a watcher attached after refolding starts", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>()
      const { ingest, refolds } = yield* makeHarness({
        script: {
          root: {
            events: ExecutionFixtures.rootEvents,
            status: "completed",
            children: [ExecutionFixtures.childId],
            hold: held,
          },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
        stored: {
          units: Fixtures.TranscriptProjection.Projection.empty(String(ExecutionFixtures.rootId), "go").units,
          revision: 4,
          modelPhase: 0,
        },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      expect(refolds.map((refold) => refold.phase)).toEqual(["started"])

      const watch = yield* ingest.watchThread(ExecutionFixtures.threadId)
      expect(watch.snapshots).toHaveLength(1)
      expect(watch.refolding).toBe(true)

      yield* Deferred.succeed(held, undefined)
      yield* settle(ingest)
      expect(refolds.map((refold) => refold.phase)).toEqual(["started", "finished"])
    }),
  )
})
