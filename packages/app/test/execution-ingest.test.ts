import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as UsageRepository from "@rika/persistence/usage-repository"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Context, Deferred, Effect, Exit, Layer, Logger, Ref, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ExecutionIngest from "../src/execution-ingest"
import * as UsageCost from "../src/usage-cost"
import { executionRoute } from "./current-state"
import { storeProjection } from "./transcript-repository-fixture"

const threadId = Thread.ThreadId.make("ingest-thread")
const rootId = Turn.TurnId.make("root")
const childId = "child:root:call_1"
const grandchildId = "child:child%3Aroot%3Acall_1:call_2"
const checkpoint = (projection: TranscriptRepository.Projection | undefined, key: string) =>
  projection?.executionCheckpoints.find((entry) => entry.executionKey === Transcript.executionKey(key))

const makeTurn = (status: Turn.Status): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: rootId,
  threadId,
  prompt: "delegate",
  stopIntent: "none",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: executionRoute(),
  status,
  createdAt: 1,
  updatedAt: 1,
})

const event = (
  executionId: string,
  cursor: string,
  sequence: number,
  type: string,
  extra: Partial<ExecutionBackend.Event> = {},
): ExecutionBackend.Event => ({
  executionId,
  cursor,
  sequence,
  type,
  createdAt: sequence,
  timestampSource: "server",
  ...extra,
})

const started = (executionId: string): ExecutionBackend.Event =>
  event(executionId, `${executionId}:started`, 0, "execution.started", { createdAt: 0 })

const rootEvents: ReadonlyArray<ExecutionBackend.Event> = [
  started("root"),
  event("root", "r1", 1, "tool.call.requested", {
    data: { tool_call_id: "call_1", tool_name: "task", input: { prompt: "go" } },
  }),
  event("root", "r2", 2, "child_run.spawned", { data: { child_execution_id: childId, preset_name: "Oracle" } }),
  event("root", "r3", 3, "execution.completed"),
]

const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
  started(childId),
  event(childId, "c1", 1, "tool.call.requested", {
    data: { tool_call_id: "child_call", tool_name: "bash", input: { command: "bun test" } },
  }),
  event(childId, "c2", 2, "model.output.completed", { text: "child answered" }),
  event(childId, "c3", 3, "execution.completed"),
]

interface ScriptEntry {
  readonly events: ReadonlyArray<ExecutionBackend.Event>
  readonly status: ExecutionBackend.Status
  readonly children?: ReadonlyArray<string>
  readonly hold?: Deferred.Deferred<void>
  readonly ignoreCursor?: boolean
  readonly pages?: (after: string | undefined) => ExecutionBackend.EventPage
}

interface Followed {
  readonly executionId: string
  readonly after: string | undefined
}

interface DeltaWrite {
  readonly upsert: ReadonlyArray<string>
  readonly remove: ReadonlyArray<string>
}

const makeHarness = Effect.fn("ExecutionIngestTest.makeHarness")(function* (options: {
  readonly script: Readonly<Record<string, ScriptEntry>>
  readonly turnStatus?: Turn.Status
  readonly stored?: Transcript.Projection
  readonly executionCheckpoints?: ReadonlyArray<TranscriptRepository.ExecutionCheckpoint>
  readonly consumed?: Readonly<
    Record<
      string,
      { readonly cursor: string; readonly sequence: number; readonly status?: "completed" | "failed" | "cancelled" }
    >
  >
  readonly executionStates?: Readonly<Record<string, Transcript.ProjectionState>>
  readonly storedProjectionVersion?: number
  readonly exposeStored?: (stored: TranscriptRepository.Projection) => TranscriptRepository.Projection
  readonly commitEvents?: number
  readonly watchCapacity?: number
  readonly commitOutcome?: "failure" | "stale"
  readonly commitFailures?: Ref.Ref<number>
  readonly commitGate?: (write: number) => Effect.Effect<void>
  readonly pageHold?: { readonly after: string; readonly open: Deferred.Deferred<void> }
  readonly onFailure?: (failure: ExecutionIngest.Failure) => void
  readonly mapUsage?: (usage: UsageRepository.Interface) => UsageRepository.Interface
}) {
  const turn = makeTurn(options.turnStatus ?? "completed")
  const turns = yield* TurnRepository.makeMemory([turn])
  const usage =
    options.mapUsage?.(Context.get(yield* Layer.build(UsageRepository.memoryLayer), UsageRepository.Service)) ??
    Context.get(yield* Layer.build(UsageRepository.memoryLayer), UsageRepository.Service)
  if (options.consumed !== undefined) {
    const observations = Object.entries(options.consumed).flatMap(([executionId, consumed]) =>
      (options.script[executionId]?.events ?? [])
        .filter((candidate) => candidate.sequence <= consumed.sequence)
        .map((candidate) => ({
          threadId: String(threadId),
          turnId: String(rootId),
          event: candidate,
        })),
    )
    const folded = UsageCost.foldBatch(UsageCost.empty, observations)
    if (folded._tag === "Failure") return yield* Effect.die(folded.failure)
    yield* usage.admitSource(String(rootId), String(rootId), String(threadId))
    yield* usage.commitSource(String(rootId), String(rootId), 0, UsageCost.serialize(folded.success), {
      ...UsageCost.materialize(folded.success, String(rootId), String(threadId)),
      sourceComplete: false,
    })
  }
  const memory = yield* TranscriptRepository.makeMemory({ turns })
  if (options.stored !== undefined)
    yield* storeProjection(memory, turn, options.stored, {
      ...(options.executionCheckpoints === undefined ? {} : { executionCheckpoints: options.executionCheckpoints }),
      ...(options.consumed === undefined ? {} : { consumed: options.consumed }),
      ...(options.executionStates === undefined ? {} : { executionStates: options.executionStates }),
      projectionVersion: options.storedProjectionVersion ?? TranscriptRepository.invalidatedProjectionVersion,
    })
  const commits: Array<number> = []
  const writes: Array<DeltaWrite> = []
  const transcripts = TranscriptRepository.Service.of({
    ...memory,
    get: (turnId) =>
      memory
        .get(turnId)
        .pipe(
          Effect.map((stored) =>
            stored === undefined || options.exposeStored === undefined ? stored : options.exposeStored(stored),
          ),
        ),
    commitDelta: (committedTurn, state, delta, commitOptions) => {
      writes.push({ upsert: delta.upsert.map((unit) => unit.key), remove: [...delta.remove] })
      const gate = options.commitGate?.(writes.length) ?? Effect.void
      const outcome =
        options.commitFailures === undefined
          ? Effect.succeed(options.commitOutcome)
          : Ref.modify(options.commitFailures, (remaining) =>
              remaining > 0 ? (["failure", remaining - 1] as const) : ([undefined, remaining] as const),
            )
      const write = gate.pipe(
        Effect.andThen(outcome),
        Effect.flatMap((selected) => {
          if (selected === "failure")
            return Effect.fail(
              TranscriptRepository.RepositoryError.make({ message: "injected transcript write failure" }),
            )
          if (selected === "stale") return Effect.succeed("stale" as const)
          return memory.commitDelta(committedTurn, state, delta, commitOptions)
        }),
      )
      return write.pipe(
        Effect.tap((result) =>
          result === "committed" ? Effect.sync(() => commits.push(state.revision)) : Effect.void,
        ),
      )
    },
    replaceForRefold: (refoldedTurn, projection, refoldOptions) =>
      memory
        .replaceForRefold(refoldedTurn, projection, refoldOptions)
        .pipe(
          Effect.tap((result) =>
            result._tag === "Committed" ? Effect.sync(() => commits.push(projection.revision)) : Effect.void,
          ),
        ),
  })
  const follows: Array<Followed> = []
  const inspections: Array<string> = []
  const backend = ExecutionBackend.Service.of({
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
      Effect.sync(() => {
        inspections.push(executionId)
        const entry = options.script[executionId]
        if (entry === undefined) return undefined
        return {
          turnId: executionId,
          status: entry.status,
          ...(entry.events.at(-1) === undefined ? {} : { lastCursor: entry.events.at(-1)!.cursor }),
          waits: [],
          pendingTools: [],
          children: (entry.children ?? []).map((id) => ({
            executionId: id,
            status: options.script[id]?.status ?? ("running" as const),
          })),
        }
      }),
    pageEvents: (executionId, _direction, cursor) =>
      Effect.gen(function* () {
        const pageHold = options.pageHold
        if (pageHold !== undefined && cursor === pageHold.after) yield* Deferred.await(pageHold.open)
        const entry = options.script[executionId]
        if (entry?.pages !== undefined) return entry.pages(cursor)
        const events = entry?.events ?? []
        const boundary = cursor === undefined ? -1 : events.findIndex((candidate) => candidate.cursor === cursor)
        return {
          events: events.slice(boundary + 1),
          hasMore: false,
          ...(events.at(-1) === undefined ? {} : { newestCursor: events.at(-1)!.cursor }),
        }
      }),
    follow: (executionId, afterCursor, onEvent) =>
      Effect.gen(function* () {
        const after = typeof afterCursor === "string" ? afterCursor : afterCursor?.cursor
        follows.push({ executionId, after })
        const entry = options.script[executionId]
        if (entry === undefined)
          return yield* ExecutionBackend.BackendError.make({ message: `ExecutionNotFound ${executionId}` })
        const boundary =
          after === undefined || entry.ignoreCursor === true
            ? -1
            : entry.events.findIndex((candidate) => candidate.cursor === after)
        const pending = entry.events.slice(boundary + 1)
        for (const pendingEvent of pending) onEvent?.(pendingEvent)
        if (entry.hold !== undefined) yield* Deferred.await(entry.hold)
        return { turnId: executionId, status: entry.status, events: pending }
      }),
  })
  const refolds: Array<ExecutionIngest.Refold> = []
  const ingest = yield* ExecutionIngest.make({
    backend,
    transcripts,
    turns,
    usage,
    onRefold: (refold) => refolds.push(refold),
    ...(options.commitEvents === undefined ? {} : { commitEvents: options.commitEvents }),
    ...(options.watchCapacity === undefined ? {} : { watchCapacity: options.watchCapacity }),
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
  })
  const projectionChanges: Array<ExecutionIngest.ProjectionChange> = []
  const projectionWatch = yield* ingest.watchThread(threadId)
  yield* projectionWatch.changes.pipe(
    Stream.runForEach((change) => Effect.sync(() => projectionChanges.push(change))),
    Effect.forkScoped,
  )
  return {
    ingest,
    transcripts,
    turns,
    turn,
    follows,
    inspections,
    commits,
    writes,
    usage,
    refolds,
    projectionChanges,
    projectionWatch,
  }
})

const followsOf = (follows: ReadonlyArray<Followed>, executionId: string) =>
  follows.filter((followed) => followed.executionId === executionId)

const settle = (ingest: ExecutionIngest.Interface) =>
  ingest.settled(rootId).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow))

describe("ExecutionIngest", () => {
  it.effect("publishes one anchored global patch for each accepted projection mutation", () =>
    Effect.gen(function* () {
      const { ingest, projectionChanges, projectionWatch, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: childEvents, status: "completed" },
        },
      })

      expect(projectionWatch.snapshots).toEqual([])
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const projectionStarted = projectionChanges.find((change) => change._tag === "ProjectionStarted")
      if (projectionStarted?._tag !== "ProjectionStarted") return yield* Effect.die("projection stream did not start")
      const patches = projectionChanges.flatMap((change) => (change._tag === "ProjectionPatched" ? [change.patch] : []))
      expect(patches.length).toBeGreaterThan(0)
      expect(patches.every((patch) => patch.streamId === projectionStarted.snapshot.streamId)).toBe(true)
      expect(patches.map((patch) => [patch.baseRevision, patch.patchRevision])).toEqual(
        patches.map((_, index) => [index, index + 1]),
      )

      const childAttachment = patches.find(
        (patch) =>
          patch.delta.upsert.some((unit) => unit.turnId === childId) &&
          patch.delta.upsert.some((unit) => unit.key === "tool:root:call_1"),
      )
      expect(childAttachment).toBeDefined()

      const visible = new Map(projectionStarted.snapshot.units.map((unit) => [unit.key, unit]))
      for (const patch of patches) {
        for (const key of patch.delta.remove) visible.delete(key)
        for (const unit of patch.delta.upsert) visible.set(unit.key, unit)
      }
      const stored = yield* transcripts.get(rootId)
      expect(
        [...visible.values()].toSorted((left, right) => Transcript.compareUnitOrder(left.order, right.order)),
      ).toEqual(stored?.units)
      expect(projectionChanges.at(-1)).toMatchObject({
        _tag: "ProjectionStopped",
        streamId: projectionStarted.snapshot.streamId,
        patchRevision: patches.length,
        status: "completed",
      })
    }),
  )

  it.effect("rejects one durable cursor reused at a different sequence", () =>
    Effect.gen(function* () {
      const duplicateCursorEvents: ReadonlyArray<ExecutionBackend.Event> = [
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
      const events: ReadonlyArray<ExecutionBackend.Event> = [
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
        stored: { units: Transcript.empty(String(rootId), "go").units, revision: 4, modelPhase: 0 },
      })
      expect((yield* transcripts.get(rootId))?.projectionVersion).toBe(
        TranscriptRepository.invalidatedProjectionVersion,
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
      const failedEvents: ReadonlyArray<ExecutionBackend.Event> = [
        started("root"),
        event("root", "failed", 1, "execution.failed", { text: "backend failed" }),
      ]
      const { ingest, transcripts, turns } = yield* makeHarness({
        script: { root: { events: failedEvents, status: "failed" } },
        turnStatus: "completed",
        stored: Transcript.empty(String(rootId), "delegate"),
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
        stored: { units: Transcript.empty(String(rootId), "go").units, revision: 4, modelPhase: 0 },
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
        stored: { units: Transcript.empty(String(rootId), "go").units, revision: 4, modelPhase: 0 },
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

  it.effect("follows each execution exactly once across repeated ensure calls", () =>
    Effect.gen(function* () {
      const { ingest, follows, refolds } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed" },
          [childId]: { events: childEvents, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      expect(followsOf(follows, "root")).toHaveLength(1)
      expect(followsOf(follows, childId)).toHaveLength(1)
      expect(refolds).toHaveLength(0)
    }),
  )

  it.effect("records terminal consumed state that makes a later ensure a no-op", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, turns, follows } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed" },
          [childId]: { events: childEvents, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      yield* turns.setStatus(rootId, "completed", "r3", 2)
      const stored = yield* transcripts.get(rootId)
      expect(
        stored?.executionCheckpoints.map(({ executionKey, cursor, sequence, status }) => ({
          executionKey,
          cursor,
          sequence,
          status,
        })),
      ).toEqual(
        expect.arrayContaining([
          { executionKey: "root", cursor: "r3", sequence: 3, status: "completed" },
          { executionKey: childId, cursor: "c3", sequence: 3, status: "completed" },
        ]),
      )
      expect(stored?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      const consumedFollows = follows.length

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      expect(follows).toHaveLength(consumedFollows)
    }),
  )

  it.effect("resumes a partially consumed execution from its stored cursor", () =>
    Effect.gen(function* () {
      const partial: ReadonlyArray<ExecutionBackend.Event> = rootEvents.slice(0, 3)
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: childEvents, status: "completed" },
        },
        stored: Transcript.project("root", "delegate", partial),
        consumed: { root: { cursor: "r2", sequence: 2 } },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({
          cursor: "r3",
          sequence: 3,
          status: "completed",
        }),
      )
      expect(followsOf(follows, "root").map((followed) => followed.after)).toEqual(["r2"])
    }),
  )

  it.effect("resumes unfinished children without inspecting an already-terminal root", () =>
    Effect.gen(function* () {
      const partialChildEvents = childEvents.slice(0, 3)
      const root = Transcript.project("root", "delegate", rootEvents)
      const child = Transcript.project(childId, "", partialChildEvents)
      const stored = Transcript.withNestedProjections(root, [{ parentId: "root:call_1", projection: child }])
      const { ingest, transcripts, follows, inspections } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: childEvents, status: "completed" },
        },
        turnStatus: "completed",
        stored,
        consumed: {
          root: { cursor: "r3", sequence: 3, status: "completed" },
          [childId]: { cursor: "c2", sequence: 2 },
        },
        executionStates: {
          root: Transcript.projectionState(root),
          [childId]: Transcript.projectionState(child),
        },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      expect(inspections).toEqual([childId])
      expect(followsOf(follows, "root")).toEqual([])
      expect(followsOf(follows, childId).map((followed) => followed.after)).toEqual(["c2"])
      expect(checkpoint(yield* transcripts.get(rootId), childId)?.status).toBe("completed")
    }),
  )

  it.effect("restores a child's fold state before resuming its durable suffix", () =>
    Effect.gen(function* () {
      const partialChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
        started(childId),
        event(childId, "c1", 1, "model.input.prepared"),
        event(childId, "c2", 2, "model.output.completed", { text: "first child answer" }),
        event(childId, "c3", 3, "tool.call.requested", {
          data: { tool_call_id: "read", tool_name: "read", input: { path: "src/first.ts" } },
        }),
      ]
      const completeChildEvents = partialChildEvents.concat(
        event(childId, "c4", 4, "model.output.completed", { text: "second child answer" }),
        event(childId, "c5", 5, "execution.completed"),
      )
      const root = Transcript.project("root", "delegate", rootEvents)
      const child = {
        ...Transcript.project(childId, "", partialChildEvents),
        costUsd: 1.25,
        usageCursors: ["usage-cursor"],
        pricingVersion: Transcript.pricingVersion,
      }
      let expectedChild: Transcript.Projection = child
      for (const suffix of completeChildEvents.slice(partialChildEvents.length))
        expectedChild = Transcript.applyEvent(expectedChild, suffix)
      const stored = Transcript.withNestedProjections(root, [{ parentId: "root:call_1", projection: child }])
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: completeChildEvents, status: "completed" },
        },
        stored,
        consumed: {
          root: { cursor: "r3", sequence: 3, status: "completed" },
          [childId]: { cursor: "c3", sequence: 3 },
        },
        executionStates: {
          root: Transcript.projectionState(root),
          [childId]: Transcript.projectionState(child),
        },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const resumed = yield* transcripts.get(rootId)
      expect(followsOf(follows, childId).map((followed) => followed.after)).toEqual(["c3"])
      expect(
        resumed?.units.flatMap((unit) =>
          unit.turnId === childId && unit.content._tag === "Entry" && unit.content.role === "assistant"
            ? [unit.content.text]
            : [],
        ),
      ).toEqual(["first child answer", "second child answer"])
      expect(checkpoint(resumed, childId)?.state).toEqual(Transcript.projectionState(expectedChild))
      expect(checkpoint(resumed, childId)).toEqual(
        expect.objectContaining({ cursor: "c5", sequence: 5, status: "completed" }),
      )
    }),
  )

  it.effect("uses the child's projected completion when its backend status is failed", () =>
    Effect.gen(function* () {
      const recoveredChild = [
        started(childId),
        event(childId, "answer", 1, "model.output.completed", { text: "usable child answer" }),
        event(childId, "failed", 2, "execution.failed", { text: "late backend failure" }),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: recoveredChild, status: "failed" },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const stored = yield* transcripts.get(rootId)
      const parent = stored?.units.find(
        (unit) =>
          unit.parentId === undefined &&
          unit.content._tag === "Block" &&
          unit.content.block._tag === "ToolCall" &&
          unit.content.block.childId === childId,
      )
      expect(parent).toMatchObject({ content: { block: { status: "complete" } } })
      expect(checkpoint(stored, childId)?.status).toBe("failed")
      expect(
        stored?.units.find((unit) => unit.turnId === childId && unit.executionOutcome !== undefined)?.executionOutcome,
      ).toEqual({ status: "complete" })
    }),
  )

  it.effect("fails when backend terminality has no durable projected outcome", () =>
    Effect.gen(function* () {
      const { ingest, projectionChanges, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: {
            events: [event(childId, "answer", 1, "model.output.completed", { text: "unterminated answer" })],
            status: "completed",
          },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      const failure = yield* Effect.flip(ingest.settled(rootId))

      expect(failure.reason).toBe("backend")
      expect(failure.executionId).toBe(childId)
      expect(failure.message).toContain("projected durable terminal outcome")
      expect(yield* transcripts.get(rootId)).toBeUndefined()
      yield* Effect.yieldNow
      expect(projectionChanges.at(-1)).toMatchObject({
        _tag: "ProjectionFailed",
        failure,
      })
    }),
  )

  it.effect("rejects a current parent status that contradicts its child's projected outcome", () =>
    Effect.gen(function* () {
      const root = Transcript.project("root", "delegate", rootEvents)
      const child = Transcript.project(childId, "", childEvents)
      const stored = Transcript.withNestedProjections(root, [{ parentId: "root:call_1", projection: child }])
      const { ingest, writes } = yield* makeHarness({
        script: {},
        stored,
        consumed: {
          root: { cursor: "r3", sequence: 3, status: "completed" },
          [childId]: { cursor: "c3", sequence: 3, status: "completed" },
        },
        executionStates: {
          root: Transcript.projectionState(root),
          [childId]: Transcript.projectionState(child),
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
      const root = Transcript.project("root", "delegate", failedRootEvents)
      const child = Transcript.project(childId, "", runningChildEvents)
      const nested = Transcript.withNestedProjections(root, [{ parentId: "root:call_1", projection: child }])
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
          root: Transcript.projectionState(root),
          [childId]: Transcript.projectionState(child),
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
      const root = Transcript.project("root", "delegate", rootEvents)
      const child = Transcript.project(childId, "", childEvents)
      const valid = Transcript.withNestedProjections(root, [{ parentId: "root:call_1", projection: child }])
      const childUnit = valid.units.find((unit) => unit.turnId === childId)
      const rootPrompt = valid.units.find((unit) => unit.turnId === rootId && unit.parentId === undefined)
      if (childUnit === undefined || rootPrompt === undefined) return yield* Effect.die("missing attachment fixture")
      const variants: ReadonlyArray<Transcript.Projection> = [
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
                  order: Transcript.childOrder(rootPrompt.order, childId, Transcript.localOrder(unit.order)),
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
            root: Transcript.projectionState(root),
            [childId]: Transcript.projectionState(child),
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
      const valid = Transcript.project("root", "delegate", [
        event("root", "answer", 1, "model.output.completed", { text: "answer" }),
      ])
      const promptKey = "turn:root:user"
      const variants: ReadonlyArray<Transcript.Projection> = [
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
      const nestedChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
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
      const turns = yield* TurnRepository.makeMemory([turn])
      const transcripts = Context.get(
        yield* Layer.build(TranscriptRepository.memoryLayer),
        TranscriptRepository.Service,
      )
      const partial = Transcript.project("root", "delegate", rootEvents.slice(0, 3))
      yield* transcripts.commitDelta(
        turn,
        Transcript.projectionState(partial),
        { upsert: partial.units, remove: [] },
        {
          expectedGeneration: undefined,
          executionCheckpoints: [
            {
              executionKey: "root",
              executionId: "root",
              cursor: "r2",
              sequence: 2,
              state: Transcript.projectionState(partial),
            },
          ],
          projectionVersion: ExecutionIngest.projectionVersion,
        },
      )
      const backend = ExecutionBackend.Service.of({
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
        usage: Context.get(yield* Layer.build(UsageRepository.memoryLayer), UsageRepository.Service),
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

  it.effect("coalesces a burst of events into one commit per debounce window", () =>
    Effect.gen(function* () {
      const burst = [
        event("root", "b1", 1, "model.output.completed", { text: "one" }),
        event("root", "b2", 2, "model.output.completed", { text: "two" }),
        event("root", "b3", 3, "model.output.completed", { text: "three" }),
      ]
      const { ingest, transcripts, commits } = yield* makeHarness({
        script: {},
        turnStatus: "running",
        commitEvents: 64,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      const caughtUp = commits.length

      for (const delivered of burst) ingest.deliver(rootId, delivered)
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow
      expect(commits).toHaveLength(caughtUp)

      yield* TestClock.adjust(ExecutionIngest.defaultCommitWindow)
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow

      expect(commits).toHaveLength(caughtUp + 1)
      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "b3", sequence: 3 }),
      )
    }),
  )

  it.effect("flushes events accepted after the initial durable prefix", () =>
    Effect.gen(function* () {
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, event("root", "late", 1, "model.output.completed", { text: "late answer" }))
      yield* ingest.flush(rootId)

      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(expect.objectContaining({ cursor: "late", sequence: 1 }))
      expect(
        stored?.units.some(
          (unit) =>
            unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === "late answer",
        ),
      ).toBe(true)
    }),
  )

  it.effect("flushes owner events delivered while the initial backend page is still loading", () =>
    Effect.gen(function* () {
      const pageOpen = yield* Deferred.make<void>()
      const first = event("root", "prefix", 1, "model.output.completed", { text: "durable prefix" })
      const late = event("root", "late", 2, "model.output.completed", { text: "owner delivery" })
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: {
            events: [first],
            status: "running",
            pages: (after) =>
              after === undefined
                ? { events: [first], hasMore: true, newestCursor: first.cursor }
                : { events: [], hasMore: false, newestCursor: first.cursor },
          },
        },
        turnStatus: "running",
        pageHold: { after: first.cursor, open: pageOpen },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      ingest.deliver(rootId, late)
      const flushed = yield* Deferred.make<void>()
      yield* Effect.forkChild(ingest.flush(rootId).pipe(Effect.andThen(Deferred.succeed(flushed, undefined))))
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow

      expect(yield* Deferred.isDone(flushed)).toBe(false)
      yield* Deferred.succeed(pageOpen, undefined)
      yield* Deferred.await(flushed)

      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "late", sequence: 2 }),
      )
    }),
  )

  it.effect("flushes exactly the accepted version while a repository write is suspended", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>()
      const writeOpen = yield* Deferred.make<void>()
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
        commitGate: (write) =>
          write === 2
            ? Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Deferred.await(writeOpen)))
            : Effect.void,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, event("root", "first", 1, "model.output.completed", { text: "first" }))
      const firstFlushed = yield* Deferred.make<void>()
      yield* Effect.forkChild(ingest.flush(rootId).pipe(Effect.andThen(Deferred.succeed(firstFlushed, undefined))))
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(writeStarted)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writeStarted)).toBe(true)
      yield* Deferred.await(writeStarted)

      ingest.deliver(rootId, event("root", "second", 2, "model.output.completed", { text: "second" }))
      yield* Deferred.succeed(writeOpen, undefined)
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(firstFlushed)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(firstFlushed)).toBe(true)
      yield* Deferred.await(firstFlushed)

      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "first", sequence: 1 }),
      )
      const secondFlushed = yield* Deferred.make<void>()
      yield* Effect.forkChild(ingest.flush(rootId).pipe(Effect.andThen(Deferred.succeed(secondFlushed, undefined))))
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(secondFlushed)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(secondFlushed)).toBe(true)
      yield* Deferred.await(secondFlushed)
      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "second", sequence: 2 }),
      )
    }),
  )

  it.effect("persists an event accepted while cancellation waits on its final repository write", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>()
      const writeOpen = yield* Deferred.make<void>()
      const { ingest, transcripts, turns } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
        commitGate: (write) =>
          write === 2
            ? Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Deferred.await(writeOpen)))
            : Effect.void,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, started("root"))
      ingest.deliver(rootId, event("root", "answer", 1, "model.output.completed", { text: "before cancel" }))
      yield* turns.setStatus(rootId, "cancelled", "cancelled", 2)
      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(writeStarted)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writeStarted)).toBe(true)

      ingest.deliver(rootId, event("root", "cancelled", 2, "execution.cancelled"))
      yield* Deferred.succeed(writeOpen, undefined)
      yield* ingest.settled(rootId)

      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(
        expect.objectContaining({ cursor: "cancelled", sequence: 2, status: "cancelled" }),
      )
      expect(stored?.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "cancelled",
      })
      yield* ingest.flush(rootId)
    }),
  )

  it.effect("fails every concurrent flush waiter when its repository write fails", () =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(0)
      const writeStarted = yield* Deferred.make<void>()
      const writeOpen = yield* Deferred.make<void>()
      const { ingest } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
        commitFailures: failures,
        commitGate: (write) =>
          write === 2
            ? Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Deferred.await(writeOpen)))
            : Effect.void,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, event("root", "failing", 1, "model.output.completed", { text: "fail" }))
      const first = yield* Deferred.make<ExecutionIngest.Failure>()
      const second = yield* Deferred.make<ExecutionIngest.Failure>()
      yield* Effect.forkChild(
        Effect.flip(ingest.flush(rootId)).pipe(Effect.flatMap((failure) => Deferred.succeed(first, failure))),
      )
      yield* Deferred.await(writeStarted)
      yield* Effect.forkChild(
        Effect.flip(ingest.flush(rootId)).pipe(Effect.flatMap((failure) => Deferred.succeed(second, failure))),
      )
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow
      yield* Ref.set(failures, 1)
      yield* Deferred.succeed(writeOpen, undefined)

      const firstFailure = yield* Deferred.await(first)
      const secondFailure = yield* Deferred.await(second)
      expect(firstFailure).toBe(secondFailure)
      expect(firstFailure.reason).toBe("repository")
    }),
  )

  it.effect("commits without waiting for the window once the batch size is reached", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>()
      const burst = [
        event("root", "b1", 1, "model.output.completed", { text: "one" }),
        event("root", "b2", 2, "model.output.completed", { text: "two" }),
      ]
      const { ingest, commits } = yield* makeHarness({
        script: { root: { events: burst, status: "running", hold } },
        turnStatus: "running",
        commitEvents: 2,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow

      expect(commits).toHaveLength(1)
      yield* Deferred.succeed(hold, undefined)
    }),
  )

  it.effect("commits each projection delta with the latest persisted Turn", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, turns } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, started("root"))
      yield* turns.setStatus(rootId, "running", "newer-turn-cursor", 2)
      ingest.deliver(rootId, event("root", "projection-cursor", 1, "model.output.completed", { text: "answer" }))
      yield* ingest.flush(rootId)

      expect(yield* transcripts.get(rootId)).toMatchObject({
        turn: { status: "running", lastCursor: "newer-turn-cursor", updatedAt: 2 },
      })

      yield* turns.setStatus(rootId, "completed", "done", 3)
      ingest.deliver(rootId, event("root", "done", 2, "execution.completed"))
      yield* settle(ingest)
    }),
  )

  it.effect("writes only units changed by a resumed event regardless of transcript size", () =>
    Effect.gen(function* () {
      const history = Array.from({ length: 40 }, (_, index) =>
        event("root", `call-${index}`, index + 1, "tool.call.requested", {
          data: { tool_call_id: `call_${index}`, tool_name: "read", input: { path: `src/${index}.ts` } },
        }),
      )
      const result = event("root", "result", 41, "tool.result.received", {
        data: { tool_call_id: "call_20", output: "updated result" },
      })
      const stored = Transcript.project("root", "delegate", history)
      const { ingest, transcripts, writes } = yield* makeHarness({
        script: { root: { events: history.concat(result), status: "running" } },
        turnStatus: "running",
        stored,
        consumed: { root: { cursor: "call-39", sequence: 40 } },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)

      expect(writes).toEqual([{ upsert: ["tool:root:call_20"], remove: [] }])
      expect((yield* transcripts.get(rootId))?.units).toHaveLength(stored.units.length)
    }),
  )

  it.effect("backfills an incomplete parallel-wait usage source", () =>
    Effect.gen(function* () {
      const staleUsage = yield* UsageRepository.makeMemory({
        initial: [
          {
            sourceId: String(rootId),
            turnId: String(rootId),
            threadId: String(threadId),
            revision: 0,
            projectionVersion: UsageRepository.projectionVersion,
            pricedAttempts: 0,
            unpricedAttempts: 0,
            countedAttempts: 0,
            uncountedAttempts: 0,
            sourceComplete: false,
          },
        ],
      })
      const parallelWaits = [
        event("root", "accepted", 0, "execution.accepted"),
        event("root", "started", 1, "execution.started"),
        event("root", "wait-a", 2, "wait.created"),
        event("root", "wait-b", 3, "wait.created"),
        event("root", "wait-c", 4, "wait.created"),
        event("root", "cancel-a", 5, "wait.cancelled"),
        event("root", "wake-b", 6, "wait.woken"),
        event("root", "timeout-c", 7, "wait.timed_out"),
        event("root", "done", 8, "execution.cancelled"),
      ]
      const stored = Transcript.project("root", "delegate", parallelWaits)
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events: parallelWaits, status: "cancelled" } },
        turnStatus: "cancelled",
        stored,
        storedProjectionVersion: ExecutionIngest.projectionVersion,
        executionCheckpoints: [
          {
            executionKey: "root",
            executionId: "root",
            cursor: "done",
            sequence: 8,
            status: "cancelled",
            state: Transcript.projectionState(stored),
          },
        ],
        mapUsage: () => staleUsage,
      })

      expect((yield* transcripts.get(rootId))?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect((yield* staleUsage.readSource(String(rootId), String(rootId)))?.sourceComplete).toBe(false)
      yield* ingest.backfillUsage({ threadId, turnId: rootId })

      const recovered = yield* staleUsage.readSource(String(rootId), String(rootId))
      expect(recovered).toMatchObject({
        projectionVersion: UsageRepository.projectionVersion,
        sourceComplete: true,
      })
      expect(recovered?.foldJson).toBeDefined()
      const decoded = recovered?.foldJson === undefined ? undefined : UsageCost.deserialize(recovered.foldJson)
      expect(decoded?._tag).toBe("Success")
      if (decoded?._tag === "Success")
        expect(UsageCost.activeTime(decoded.success, String(threadId))).toMatchObject({ _tag: "Available" })
    }),
  )

  it.effect("degrades usage without interrupting live transcript delivery", () => {
    const lines: Array<string> = []
    const logger = Logger.make((options) => lines.push(Logger.formatJson.log(options)))
    return Effect.gen(function* () {
      const failures: Array<ExecutionIngest.Failure> = []
      const { ingest, projectionChanges, transcripts, usage } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
        onFailure: (failure) => failures.push(failure),
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      for (const delivered of [
        started("root"),
        event("root", "first", 1, "model.output.completed", { text: "before degraded usage" }),
        event("root", "bad-wake", 2, "wait.woken"),
        event("root", "second", 3, "model.output.completed", { text: "after degraded usage" }),
        event("root", "done", 4, "execution.completed"),
      ])
        ingest.deliver(rootId, delivered)
      yield* settle(ingest)

      expect(failures).toEqual([])
      expect((yield* Effect.result(ingest.consumed(rootId)))._tag).toBe("Success")
      expect(
        (yield* transcripts.get(rootId))?.units.some(
          (unit) => unit.content._tag === "Entry" && unit.content.text === "after degraded usage",
        ),
      ).toBe(true)
      expect(
        projectionChanges.some(
          (change) =>
            change._tag === "ProjectionPatched" &&
            change.patch.delta.upsert.some(
              (unit) => unit.content._tag === "Entry" && unit.content.text === "after degraded usage",
            ),
        ),
      ).toBe(true)
      expect((yield* usage.readSource(String(rootId), String(rootId)))?.sourceComplete).toBe(false)
      expect(lines.filter((line) => line.includes("execution.usage.degraded"))).toHaveLength(1)
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
  })

  for (const outcome of ["failure", "stale"] as const)
    it.effect(`reports a typed ${outcome} checkpoint write to every waiter`, () =>
      Effect.gen(function* () {
        const failures: Array<ExecutionIngest.Failure> = []
        const events = [
          started("root"),
          event("root", "answer", 1, "model.output.completed", { text: "answer" }),
          event("root", "done", 2, "execution.completed"),
        ]
        const { ingest, transcripts } = yield* makeHarness({
          script: { root: { events, status: "completed" } },
          commitOutcome: outcome,
          onFailure: (failure) => failures.push(failure),
        })

        yield* ingest.ensure({ threadId, turnId: rootId })
        const consumedFailure = yield* Effect.flip(ingest.consumed(rootId))
        const settledFailure = yield* Effect.flip(ingest.settled(rootId))

        expect(failures).toEqual([consumedFailure])
        expect(settledFailure).toBe(consumedFailure)
        expect(consumedFailure.reason).toBe(outcome === "failure" ? "repository" : "checkpoint")
        expect(yield* transcripts.get(rootId)).toBeUndefined()
      }),
    )

  it.effect("clears a retained failure after a later authoritative retry succeeds", () =>
    Effect.gen(function* () {
      const commitFailures = yield* Ref.make(1)
      const events = [
        started("root"),
        event("root", "answer", 1, "model.output.completed", { text: "answer" }),
        event("root", "done", 2, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events, status: "completed" } },
        commitFailures,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      expect((yield* Effect.result(ingest.settled(rootId)))._tag).toBe("Failure")
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      yield* ingest.settled(rootId)

      expect((yield* transcripts.get(rootId))?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect((yield* Effect.result(ingest.consumed(rootId)))._tag).toBe("Success")
      expect((yield* Effect.result(ingest.settled(rootId)))._tag).toBe("Success")
    }),
  )

  it.effect("fails a terminal child whose durable parent tool never existed", () =>
    Effect.gen(function* () {
      const rootWithoutTool = [
        started("root"),
        event("root", "spawned", 1, "child_run.spawned", { data: { child_execution_id: childId } }),
        event("root", "done", 2, "execution.completed"),
      ]
      const terminalChild = [
        started(childId),
        event(childId, "answer", 1, "model.output.completed", { text: "detached answer" }),
        event(childId, "done", 2, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootWithoutTool, status: "completed", children: [childId] },
          [childId]: { events: terminalChild, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      const failure = yield* Effect.flip(ingest.settled(rootId))

      expect(failure.reason).toBe("attachment")
      expect(failure.executionId).toBe(childId)
      expect(yield* transcripts.get(rootId)).toBeUndefined()
    }),
  )

  it.effect("folds owner-delivered root events without following the root itself", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: { [childId]: { events: childEvents, status: "completed" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (const delivered of rootEvents) ingest.deliver(rootId, delivered)
      yield* settle(ingest)

      expect(followsOf(follows, "root")).toHaveLength(0)
      expect(followsOf(follows, childId)).toHaveLength(1)
      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(
        expect.objectContaining({ cursor: "r3", sequence: 3, status: "completed" }),
      )
      expect(stored?.units.some((unit) => unit.parentId !== undefined && unit.turnId === childId)).toBe(true)
    }),
  )

  it.effect("ignores redelivered owner events instead of reporting a rejected cursor", () =>
    Effect.gen(function* () {
      const failures: Array<ExecutionIngest.Failure> = []
      const { ingest, transcripts } = yield* makeHarness({
        script: { [childId]: { events: childEvents, status: "completed" } },
        turnStatus: "running",
        onFailure: (failure) => failures.push(failure),
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (const delivered of rootEvents) ingest.deliver(rootId, delivered)
      for (const delivered of rootEvents) ingest.deliver(rootId, delivered)
      yield* settle(ingest)

      expect(failures).toHaveLength(0)
      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({
          cursor: "r3",
          sequence: 3,
          status: "completed",
        }),
      )
    }),
  )

  it.effect("finishes a held catch-up page before recording terminal state and drops stale stored units", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const paged: ReadonlyArray<ExecutionBackend.Event> = [
        started("root"),
        event("root", "p1", 1, "model.output.completed", { text: "replayed one" }),
        event("root", "p2", 2, "model.output.completed", { text: "replayed two" }),
        event("root", "p3", 3, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: {
            events: paged,
            status: "running",
            pages: (after) => {
              const boundary = after === undefined ? -1 : paged.findIndex((candidate) => candidate.cursor === after)
              const next = paged[boundary + 1]
              return next === undefined
                ? { events: [], hasMore: false, ...(after === undefined ? {} : { newestCursor: after }) }
                : { events: [next], hasMore: boundary + 2 < paged.length, newestCursor: next.cursor }
            },
          },
        },
        turnStatus: "running",
        stored: Transcript.project("root", "stale stored prompt", [
          event("root", "stale", 9, "model.output.completed", { text: "stale stored content" }),
        ]),
        pageHold: { after: "p1", open: gate },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow
      expect(checkpoint(yield* transcripts.get(rootId), "root")?.status).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* settle(ingest)

      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(
        expect.objectContaining({ cursor: "p3", sequence: 3, status: "completed" }),
      )
      expect(
        stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "stale stored content"),
      ).toBe(false)
      expect(stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "replayed two")).toBe(
        true,
      )
      expect(stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "delegate")).toBe(true)
    }),
  )

  for (const malformedTerminal of ["empty", "nonadvancing"] as const)
    it.effect(`reports a typed failure and stops after a ${malformedTerminal} continuation page`, () =>
      Effect.gen(function* () {
        const failures: Array<ExecutionIngest.Failure> = []
        const paged = [
          event("root", "r1", 1, "model.output.completed", { text: "one" }),
          event("root", "r2", 2, "model.output.completed", { text: "two" }),
        ]
        const { ingest, transcripts } = yield* makeHarness({
          script: {
            root: {
              events: paged,
              status: "running",
              pages: (after) => {
                if (after === undefined) return { events: paged.slice(0, 1), hasMore: true, newestCursor: "r1" }
                if (malformedTerminal === "empty") return { events: [], hasMore: true, newestCursor: "r2" }
                return { events: paged.slice(1, 2), hasMore: true, newestCursor: after }
              },
            },
          },
          turnStatus: "running",
          onFailure: (failure) => failures.push(failure),
        })

        yield* ingest.ensure({ threadId, turnId: rootId })
        const failure = yield* Effect.flip(ingest.consumed(rootId))

        expect(failures).toHaveLength(1)
        expect(failure).toBe(failures[0])
        expect(failures[0]?.reason).toBe("backend")
        expect(failures[0]?.executionId).toBe("root")
        expect(failures[0]?.message).toContain("did not advance")
        expect(checkpoint(yield* transcripts.get(rootId), "root")?.status).toBeUndefined()
      }),
    )

  it.effect("ignores a queued turn and a turn that no longer exists", () =>
    Effect.gen(function* () {
      const { ingest, follows } = yield* makeHarness({
        script: { root: { events: rootEvents, status: "completed" } },
        turnStatus: "queued",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.ensure({ threadId, turnId: Turn.TurnId.make("absent") })
      yield* settle(ingest)

      expect(follows).toHaveLength(0)
    }),
  )

  it.effect("replaces invalidated units only with projections derived from Relay events", () =>
    Effect.gen(function* () {
      const stored = Transcript.project("root", "delegate", [
        event("root", "stale", 1, "model.output.completed", { text: "stale projected text" }),
        event("root", "stale-done", 2, "execution.completed"),
      ])
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed" },
          [childId]: { events: childEvents, status: "completed" },
        },
        stored,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const projection = yield* transcripts.get(rootId)
      expect(
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "stale projected text"),
      ).toBe(false)
      expect(
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "child answered"),
      ).toBe(true)
    }),
  )
})
