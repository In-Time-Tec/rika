import { describe, expect, it } from "@effect/vitest"
import {
  Fixtures,
  Context,
  Deferred,
  Effect,
  Layer,
  ExecutionIngest,
  threadId,
  rootId,
  childId,
  grandchildId,
  checkpoint,
  makeTurn,
  event,
  started,
  rootEvents,
  childEvents,
  makeHarness,
  settle,
} from "./execution-ingest-behavior-support"

describe("ExecutionIngest", () => {
  it.effect("rejects a current parent status that contradicts its child's projected outcome", () =>
    Effect.gen(function* () {
      const root = Fixtures.TranscriptProjection.Projection.project("root", "delegate", rootEvents)
      const child = Fixtures.TranscriptProjection.Projection.project(childId, "", childEvents)
      const stored = Fixtures.TranscriptNestedProjection.withNestedProjections(root, [
        { parentId: "root:call_1", projection: child },
      ])
      const { ingest, writes } = yield* makeHarness({
        script: {},
        stored,
        consumed: {
          root: { cursor: "r3", sequence: 3, status: "completed" },
          [childId]: { cursor: "c3", sequence: 3, status: "completed" },
        },
        executionStates: {
          root: Fixtures.TranscriptProjection.Projection.projectionState(root),
          [childId]: Fixtures.TranscriptProjection.Projection.projectionState(child),
        },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      const failure = yield* Effect.flip(ingest.ensure({ threadId, turnId: rootId }))

      expect(failure.reason).toBe("checkpoint")
      expect(failure.message).toContain("contradicts its stored parent")
      expect(writes).toEqual([])
    }),
  )

  it.effect("rejects running descendant units beneath a failed current root outcome", () =>
    Effect.gen(function* () {
      const failedRootEvents = [
        event("root", "tool", 1, "tool.call.requested", {
          data: { tool_call_id: "call_1", tool_name: "task", input: { prompt: "go" } },
        }),
        event("root", "spawned", 2, "child_run.spawned", { data: { child_execution_id: childId } }),
        event("root", "failed", 3, "execution.failed", { text: "root failed" }),
      ]
      const runningChildEvents = [
        event(childId, "running-tool", 1, "tool.call.requested", {
          data: { tool_call_id: "shell", tool_name: "bash", input: { command: "sleep 10" } },
        }),
      ]
      const root = Fixtures.TranscriptProjection.Projection.project("root", "delegate", failedRootEvents)
      const child = Fixtures.TranscriptProjection.Projection.project(childId, "", runningChildEvents)
      const nested = Fixtures.TranscriptNestedProjection.withNestedProjections(root, [
        { parentId: "root:call_1", projection: child },
      ])
      const stored = {
        ...nested,
        units: nested.units.map((unit) => {
          if (unit.turnId !== childId || unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")
            return unit
          return Object.assign({}, unit, {
            content: {
              _tag: "Block" as const,
              block: Object.assign({}, unit.content.block, { status: "running" as const }),
            },
          })
        }),
      }
      const { ingest, writes } = yield* makeHarness({
        script: { [childId]: { events: runningChildEvents, status: "running" } },
        stored,
        consumed: {
          root: { cursor: "failed", sequence: 3, status: "failed" },
          [childId]: { cursor: "running-tool", sequence: 1 },
        },
        executionStates: {
          root: Fixtures.TranscriptProjection.Projection.projectionState(root),
          [childId]: Fixtures.TranscriptProjection.Projection.projectionState(child),
        },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      const result = yield* Effect.result(ingest.ensure({ threadId, turnId: rootId }))

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("checkpoint")
        expect(result.failure.message).toContain("descendant")
      }
      expect(writes).toEqual([])
    }),
  )

  it.effect("rejects contradictory current child attachment paths instead of normalizing them", () =>
    Effect.gen(function* () {
      const root = Fixtures.TranscriptProjection.Projection.project("root", "delegate", rootEvents)
      const child = Fixtures.TranscriptProjection.Projection.project(childId, "", childEvents)
      const valid = Fixtures.TranscriptNestedProjection.withNestedProjections(root, [
        { parentId: "root:call_1", projection: child },
      ])
      const childUnit = valid.units.find((unit) => unit.turnId === childId)
      const rootPrompt = valid.units.find((unit) => unit.turnId === rootId && unit.parentId === undefined)
      if (childUnit === undefined || rootPrompt === undefined) return yield* Effect.die("missing attachment fixture")
      const variants: ReadonlyArray<Fixtures.TranscriptProjectionModel.Projection> = [
        {
          ...valid,
          units: valid.units.map((unit) =>
            unit.key === childUnit.key ? { ...unit, parentId: "forged-parent" } : unit,
          ),
        },
        {
          ...valid,
          units: valid.units.map((unit) =>
            unit.key === childUnit.key
              ? {
                  ...unit,
                  order: Fixtures.TranscriptOrdering.childOrder(
                    rootPrompt.order,
                    childId,
                    Fixtures.TranscriptOrdering.localOrder(unit.order),
                  ),
                }
              : unit,
          ),
        },
      ]
      for (const stored of variants) {
        const { ingest, writes } = yield* makeHarness({
          script: {
            root: { events: rootEvents, status: "completed", children: [childId] },
            [childId]: { events: childEvents, status: "completed" },
          },
          stored: valid,
          exposeStored: (current) => ({ ...current, units: stored.units }),
          consumed: {
            root: { cursor: "r3", sequence: 3, status: "completed" },
            [childId]: { cursor: "c3", sequence: 3, status: "completed" },
          },
          executionStates: {
            root: Fixtures.TranscriptProjection.Projection.projectionState(root),
            [childId]: Fixtures.TranscriptProjection.Projection.projectionState(child),
          },
          storedProjectionVersion: ExecutionIngest.projectionVersion,
        })
        const failure = yield* Effect.flip(ingest.ensure({ threadId, turnId: rootId }))
        expect(failure.reason).toBe("attachment")
        expect(writes).toHaveLength(0)
      }
    }),
  )

  it.effect("rejects contradictory current root projections instead of repairing them", () =>
    Effect.gen(function* () {
      const valid = Fixtures.TranscriptProjection.Projection.project("root", "delegate", [
        event("root", "answer", 1, "model.output.completed", { text: "answer" }),
      ])
      const promptKey = "turn:root:user"
      const variants: ReadonlyArray<Fixtures.TranscriptProjectionModel.Projection> = [
        { ...valid, units: valid.units.filter((unit) => unit.key !== promptKey) },
        {
          ...valid,
          units: valid.units.map((unit) =>
            unit.key === promptKey
              ? { ...unit, content: { _tag: "Entry" as const, role: "user" as const, text: "wrong prompt" } }
              : unit,
          ),
        },
        {
          ...valid,
          units: valid.units.map((unit) => (unit.key === promptKey ? { ...unit, parentId: "foreign" } : unit)),
        },
      ]
      for (const stored of variants) {
        const { ingest, writes } = yield* makeHarness({
          script: { root: { events: [], status: "completed" } },
          stored: valid,
          exposeStored: (current) => ({ ...current, units: stored.units }),
          consumed: { root: { cursor: "answer", sequence: 1, status: "completed" } },
          storedProjectionVersion: ExecutionIngest.projectionVersion,
        })
        const failure = yield* Effect.flip(ingest.ensure({ threadId, turnId: rootId }))
        expect(failure.reason).toBe("checkpoint")
        expect(writes).toEqual([])
      }
    }),
  )

  it.effect("attaches a child discovered mid-stream under its parent tool before the root ends", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>()
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: [rootEvents[0]!, rootEvents[1]!, rootEvents[2]!], status: "running", hold },
          [childId]: { events: childEvents, status: "completed" },
        },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const projection = yield* transcripts.get(rootId)
        if (projection?.units.some((unit) => unit.parentId !== undefined) === true) break
        yield* Effect.yieldNow
      }

      const stored = yield* transcripts.get(rootId)
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
      expect(nested.some((unit) => unit.content._tag === "Entry" && unit.content.text === "child answered")).toBe(true)
      expect(checkpoint(stored, childId)).toEqual(
        expect.objectContaining({ cursor: "c3", sequence: 3, status: "completed" }),
      )
      expect(checkpoint(stored, "root")?.status).toBeUndefined()
      yield* Deferred.succeed(hold, undefined)
    }),
  )

  it.effect("folds a grandchild under the child tool that requested it", () =>
    Effect.gen(function* () {
      const nestedChildEvents: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        started(childId),
        event(childId, "c1", 1, "tool.call.requested", {
          data: { tool_call_id: "call_2", tool_name: "task", input: { prompt: "deeper" } },
        }),
        event(childId, "c2", 2, "child_run.spawned", { data: { child_execution_id: grandchildId } }),
        event(childId, "c3", 3, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed" },
          [childId]: { events: nestedChildEvents, status: "completed" },
          [grandchildId]: {
            events: [
              started(grandchildId),
              event(grandchildId, "g1", 1, "model.output.completed", { text: "deep answer" }),
            ].concat(event(grandchildId, "g2", 2, "execution.completed")),
            status: "completed",
          },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const stored = yield* transcripts.get(rootId)
      const deep = stored?.units.find((unit) => unit.content._tag === "Entry" && unit.content.text === "deep answer")
      const childTool = stored?.units.find(
        (unit) => unit.turnId === childId && unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
      )
      expect(deep?.parentId).toBeDefined()
      expect(childTool?.content._tag === "Block" ? childTool.content.block._tag : undefined).toBe("ToolCall")
      expect(deep?.parentId).toBe(
        childTool?.content._tag === "Block" && childTool.content.block._tag === "ToolCall"
          ? childTool.content.block.id
          : undefined,
      )
      expect(stored?.executionCheckpoints.map((entry) => entry.executionKey).toSorted()).toEqual(
        [childId, grandchildId, "root"].toSorted(),
      )
    }),
  )

  it.effect("reports a typed failure and keeps stored state when a resumed cursor is rejected", () =>
    Effect.gen(function* () {
      const failures: Array<ExecutionIngest.Failure> = []
      const turn = makeTurn("completed")
      const turns = yield* Fixtures.TurnRepository.makeMemory([turn])
      const transcripts = Context.get(
        yield* Layer.build(Fixtures.TranscriptRepository.memoryLayer),
        Fixtures.TranscriptRepository.Service,
      )
      const partial = Fixtures.TranscriptProjection.Projection.project("root", "delegate", rootEvents.slice(0, 3))
      yield* transcripts.commitDelta(
        turn,
        Fixtures.TranscriptProjection.Projection.projectionState(partial),
        { upsert: partial.units, remove: [] },
        {
          expectedGeneration: undefined,
          executionCheckpoints: [
            {
              executionKey: "root",
              executionId: "root",
              cursor: "r2",
              sequence: 2,
              state: Fixtures.TranscriptProjection.Projection.projectionState(partial),
            },
          ],
          projectionVersion: ExecutionIngest.projectionVersion,
        },
      )
      const backend = Fixtures.ExecutionBackend.Service.of({
        invokeChild: () => Effect.die("unused"),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        start: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        replay: () => Effect.die("unused"),
        resolveInvocationSource: () => Effect.die("unused"),
        inspect: (executionId) =>
          Effect.succeed({
            turnId: executionId,
            status: "running" as const,
            waits: [],
            pendingTools: [],
            children: [],
          }),
        follow: (executionId, _afterCursor, onEvent) =>
          Effect.sync(() => {
            for (const replayed of rootEvents) onEvent?.(replayed)
            return { turnId: executionId, status: "completed" as const, events: rootEvents }
          }),
      })
      const ingest = yield* ExecutionIngest.make({
        backend,
        transcripts,
        turns,
        usage: Context.get(yield* Layer.build(Fixtures.UsageRepository.memoryLayer), Fixtures.UsageRepository.Service),
        onFailure: (failure) => failures.push(failure),
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      const failure = yield* Effect.flip(settle(ingest))

      expect(failures).toHaveLength(1)
      expect(failure).toBe(failures[0])
      expect(failures[0]?.reason).toBe("cursor-rejected")
      expect(failures[0]?.executionId).toBe("root")
      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(expect.objectContaining({ cursor: "r2", sequence: 2 }))
      expect(stored?.units.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")).toBe(
        false,
      )
    }),
  )
})
