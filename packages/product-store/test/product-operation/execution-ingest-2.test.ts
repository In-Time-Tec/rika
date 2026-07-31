import { describe, expect, it } from "@effect/vitest"
import {
  Fixtures,
  Deferred,
  Effect,
  Exit,
  Scope,
  Stream,
  ExecutionIngest,
  threadId,
  rootId,
  childId,
  checkpoint,
  event,
  started,
  rootEvents,
  childEvents,
  makeHarness,
  settle,
} from "./execution-ingest-behavior-support"

describe("ExecutionIngest", () => {
  it.effect("rejects one durable cursor reused at a different sequence", () =>
    Effect.gen(function* () {
      const duplicateCursorEvents: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        started("root"),
        event("root", "duplicate", 1, "model.output.completed", { text: "first" }),
        event("root", "duplicate", 2, "model.output.completed", { text: "second" }),
        event("root", "terminal", 3, "execution.completed"),
      ]
      const { ingest, writes } = yield* makeHarness({
        script: { root: { events: duplicateCursorEvents, status: "completed" } },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      const result = yield* Effect.result(ingest.settled(rootId))

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

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, started("root"))
      yield* ingest.flush(rootId)
      const watch = yield* ingest.watchThread(threadId)
      const anchor = watch.snapshots[0]
      if (anchor === undefined) return yield* Effect.die("active projection snapshot was not anchored")

      ingest.deliver(rootId, event("root", "answer", 1, "model.output.completed", { text: "answer" }))
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

      yield* turns.setStatus(rootId, "completed", "done", 2)
      ingest.deliver(rootId, event("root", "done", 2, "execution.completed"))
      yield* settle(ingest)
    }),
  )

  it.effect("streams transient units without advancing the durable checkpoint", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, turns, writes } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, started("root"))
      yield* ingest.flush(rootId)
      const watch = yield* ingest.watchThread(threadId)
      const anchor = watch.snapshots[0]
      if (anchor === undefined) return yield* Effect.die("active projection snapshot was not anchored")
      const storedBefore = yield* transcripts.get(rootId)
      const writesBefore = writes.length

      ingest.deliver(
        rootId,
        event("root", "transient", 1, "model.output.delta", {
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

      yield* ingest.flush(rootId)
      expect(writes).toHaveLength(writesBefore)
      expect(yield* transcripts.get(rootId)).toEqual(storedBefore)

      ingest.deliver(rootId, event("root", "answer", 1, "model.output.completed", { text: "streamed" }))
      yield* turns.setStatus(rootId, "completed", "done", 2)
      ingest.deliver(rootId, event("root", "done", 2, "execution.completed"))
      yield* settle(ingest)
    }),
  )

  it.effect("keeps ingest live while streamed parallel tool calls resolve one at a time", () =>
    Effect.gen(function* () {
      const toolIds = ["call-a", "call-b", "call-c", "call-d", "call-e"] as const
      const events: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        started("root"),
        ...toolIds.map((toolId, index) =>
          event("root", `transient-${toolId}`, 0, "model.toolcall.delta", {
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
          event("root", `requested-${toolId}`, index + 1, "tool.call.requested", {
            data: { tool_call_id: toolId, tool_name: "read", input: { path: `${toolId}.txt` } },
          }),
        ),
        ...toolIds.map((toolId, index) =>
          event("root", `result-${toolId}`, index + 6, "tool.result.received", {
            data: { tool_call_id: toolId, tool_name: "read", output: toolId },
          }),
        ),
        event("root", "completed", 11, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events, status: "completed" } },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const stored = yield* transcripts.get(rootId)
      expect(
        stored?.units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"),
      ).toHaveLength(toolIds.length)
      expect(checkpoint(stored, "root")?.status).toBe("completed")
    }),
  )

  it.effect("removes a projection watcher when its scope closes", () =>
    Effect.gen(function* () {
      const { ingest } = yield* makeHarness({
        script: {
          root: { events: [started("root"), event("root", "done", 1, "execution.completed")], status: "completed" },
        },
      })
      const scope = yield* Scope.make()
      const watch = yield* ingest.watchThread(threadId).pipe(Effect.provideService(Scope.Scope, scope))
      yield* Scope.close(scope, Exit.void)

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      expect(yield* Stream.runCollect(watch.changes)).toEqual([])
    }),
  )

  it.effect("fails a slow projection watcher explicitly when its bounded feed overflows", () =>
    Effect.gen(function* () {
      const { ingest } = yield* makeHarness({
        script: {
          root: { events: [started("root"), event("root", "done", 1, "execution.completed")], status: "completed" },
        },
        watchCapacity: 2,
      })
      const watch = yield* ingest.watchThread(threadId)

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      const result = yield* Effect.result(Stream.runCollect(watch.changes))

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ExecutionIngestProjectionWatchOverflow")
        expect(result.failure.threadId).toBe(String(threadId))
        expect(result.failure.capacity).toBe(2)
      }
    }),
  )

  it.effect("refolds a legacy projection once and reads nothing from the backend when it reopens", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, follows, inspections } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: childEvents, status: "completed" },
        },
        stored: {
          units: Fixtures.TranscriptProjection.Projection.empty(String(rootId), "go").units,
          revision: 4,
          modelPhase: 0,
        },
      })
      expect((yield* transcripts.get(rootId))?.projectionVersion).toBe(
        Fixtures.TranscriptRepository.invalidatedProjectionVersion,
      )

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const refolded = yield* transcripts.get(rootId)
      expect(refolded?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect(refolded?.units.some((unit) => unit.parentId !== undefined)).toBe(true)
      expect(checkpoint(refolded, String(rootId))?.status).toBe("completed")
      expect(checkpoint(refolded, childId)?.status).toBe("completed")
      const reads = follows.length + inspections.length
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      expect(follows.length + inspections.length).toBe(reads)
    }),
  )

  it.effect("authoritatively corrects a completed turn from a versioned Relay refold", () =>
    Effect.gen(function* () {
      const failedEvents: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        started("root"),
        event("root", "failed", 1, "execution.failed", { text: "backend failed" }),
      ]
      const { ingest, transcripts, turns } = yield* makeHarness({
        script: { root: { events: failedEvents, status: "failed" } },
        turnStatus: "completed",
        stored: Fixtures.TranscriptProjection.Projection.empty(String(rootId), "delegate"),
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.settled(rootId)

      expect(yield* turns.get(rootId)).toMatchObject({ status: "failed", lastCursor: "failed" })
      const refolded = yield* transcripts.get(rootId)
      expect(refolded).toMatchObject({
        turn: { status: "failed", lastCursor: "failed" },
        projectionVersion: ExecutionIngest.projectionVersion,
        checkpointGeneration: 1,
      })
      expect(checkpoint(refolded, String(rootId))).toMatchObject({
        cursor: "failed",
        sequence: 1,
        status: "failed",
      })
      expect(
        refolded?.units.find(
          (unit) => unit.turnId === rootId && unit.parentId === undefined && unit.executionOutcome !== undefined,
        )?.executionOutcome,
      ).toMatchObject({ status: "failed" })
    }),
  )

  it.effect("reports the refold of a legacy projection and reports nothing when the consumed thread reopens", () =>
    Effect.gen(function* () {
      const { ingest, refolds } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: childEvents, status: "completed" },
        },
        stored: {
          units: Fixtures.TranscriptProjection.Projection.empty(String(rootId), "go").units,
          revision: 4,
          modelPhase: 0,
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      expect(refolds.map((refold) => refold.phase)).toEqual(["started", "finished"])
      expect(refolds.every((refold) => String(refold.rootTurnId) === String(rootId))).toBe(true)
      expect(refolds.every((refold) => String(refold.threadId) === String(threadId))).toBe(true)

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      expect(refolds).toHaveLength(2)
    }),
  )

  it.effect("reports current refold state to a watcher attached after refolding starts", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>()
      const { ingest, refolds } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId], hold: held },
          [childId]: { events: childEvents, status: "completed" },
        },
        stored: {
          units: Fixtures.TranscriptProjection.Projection.empty(String(rootId), "go").units,
          revision: 4,
          modelPhase: 0,
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      expect(refolds.map((refold) => refold.phase)).toEqual(["started"])

      const watch = yield* ingest.watchThread(threadId)
      expect(watch.snapshots).toHaveLength(1)
      expect(watch.refolding).toBe(true)

      yield* Deferred.succeed(held, undefined)
      yield* settle(ingest)
      expect(refolds.map((refold) => refold.phase)).toEqual(["started", "finished"])
    }),
  )
})
