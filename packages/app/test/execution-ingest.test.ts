import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Context, Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as ExecutionIngest from "../src/execution-ingest"
import { executionRoute } from "./current-state"

const threadId = Thread.ThreadId.make("ingest-thread")
const rootId = Turn.TurnId.make("root")
const childId = "child:root:call_1"
const grandchildId = "child:child%3Aroot%3Acall_1:call_2"

const makeTurn = (status: Turn.Status): Turn.Turn => ({
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
): ExecutionBackend.Event => ({ executionId, cursor, sequence, type, createdAt: sequence, ...extra })

const rootEvents: ReadonlyArray<ExecutionBackend.Event> = [
  event("root", "r1", 1, "tool.call.requested", {
    data: { tool_call_id: "call_1", tool_name: "task", input: { prompt: "go" } },
  }),
  event("root", "r2", 2, "child_run.spawned", { data: { child_execution_id: childId, preset_name: "Oracle" } }),
  event("root", "r3", 3, "execution.completed"),
]

const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
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

const makeHarness = Effect.fn("ExecutionIngestTest.makeHarness")(function* (options: {
  readonly script: Readonly<Record<string, ScriptEntry>>
  readonly turnStatus?: Turn.Status
  readonly stored?: Transcript.Projection
  readonly consumed?: TranscriptRepository.ConsumedExecutions
  readonly commitEvents?: number
  readonly pageHold?: { readonly after: string; readonly open: Deferred.Deferred<void> }
  readonly onFailure?: (failure: ExecutionIngest.IngestFailure) => void
}) {
  const turn = makeTurn(options.turnStatus ?? "completed")
  const turns = yield* TurnRepository.makeMemory([turn])
  const memory = Context.get(yield* Layer.build(TranscriptRepository.memoryLayer), TranscriptRepository.Service)
  if (options.stored !== undefined)
    yield* memory.replace(turn, options.stored, options.consumed === undefined ? {} : { consumed: options.consumed })
  const commits: Array<number> = []
  const transcripts = TranscriptRepository.Service.of({
    ...memory,
    replace: (replaced, projection, replaceOptions) =>
      memory
        .replace(replaced, projection, replaceOptions)
        .pipe(Effect.tap((stored) => Effect.sync(() => commits.push(stored.revision)))),
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
    listApprovals: () => Effect.succeed([]),
    resolveToolApproval: () => Effect.void,
    resolvePermission: () => Effect.void,
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
  const deliveries: Array<ExecutionIngest.Delivery> = []
  const refolds: Array<ExecutionIngest.Refold> = []
  const ingest = yield* ExecutionIngest.make({
    backend,
    transcripts,
    turns,
    onDelivered: (delivery) => deliveries.push(delivery),
    onRefold: (refold) => refolds.push(refold),
    ...(options.commitEvents === undefined ? {} : { commitEvents: options.commitEvents }),
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
  })
  return { ingest, transcripts, turns, turn, follows, inspections, commits, deliveries, refolds }
})

const followsOf = (follows: ReadonlyArray<Followed>, executionId: string) =>
  follows.filter((followed) => followed.executionId === executionId)

const settle = (ingest: ExecutionIngest.Interface) =>
  ingest.settled(rootId).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow))

describe("ExecutionIngest", () => {
  it.effect("refolds a legacy projection once and reads nothing from the backend when it reopens", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, follows, inspections, deliveries } = yield* makeHarness({
        script: {
          root: { events: rootEvents, status: "completed", children: [childId] },
          [childId]: { events: childEvents, status: "completed" },
        },
        stored: { units: Transcript.empty(String(rootId), "go").units, revision: 4, modelPhase: 0 },
      })
      expect((yield* transcripts.get(rootId))?.projectionVersion).toBe(TranscriptRepository.legacyProjectionVersion)

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      const refolded = yield* transcripts.get(rootId)
      expect(refolded?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect(refolded?.units.some((unit) => unit.parentId !== undefined)).toBe(true)
      expect(refolded?.consumed?.[Transcript.executionKey(String(rootId))]?.status).toBe("completed")
      expect(refolded?.consumed?.[Transcript.executionKey(childId)]?.status).toBe("completed")
      expect(deliveries.some((delivery) => delivery.executionId === String(rootId))).toBe(true)

      const reads = follows.length + inspections.length
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      expect(follows.length + inspections.length).toBe(reads)
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
      expect(stored?.consumed).toEqual({
        root: { cursor: "r3", sequence: 3, status: "completed" },
        [childId]: { cursor: "c3", sequence: 3, status: "completed" },
      })
      expect(stored?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      const consumedFollows = follows.length

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      expect(follows).toHaveLength(consumedFollows)
    }),
  )

  it.effect("resumes a partially consumed execution from its stored cursor", () =>
    Effect.gen(function* () {
      const partial: ReadonlyArray<ExecutionBackend.Event> = [rootEvents[0]!, rootEvents[1]!]
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: {
          root: { events: partial, status: "running" },
          [childId]: { events: childEvents, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)
      expect((yield* transcripts.get(rootId))?.consumed?.root).toEqual({ cursor: "r2", sequence: 2 })

      const resumedFrom = follows.length
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      expect(followsOf(follows.slice(resumedFrom), "root").map((followed) => followed.after)).toEqual(["r2"])
      expect(followsOf(follows, "root").every((followed, index) => index === 0 || followed.after === "r2")).toBe(true)
    }),
  )

  it.effect("attaches a child discovered mid-stream under its parent tool before the root ends", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>()
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: [rootEvents[0]!, rootEvents[1]!], status: "running", hold },
          [childId]: { events: childEvents, status: "completed" },
        },
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
      expect(stored?.consumed?.[childId]).toEqual({ cursor: "c3", sequence: 3, status: "completed" })
      expect(stored?.consumed?.root?.status).toBeUndefined()
      yield* Deferred.succeed(hold, undefined)
    }),
  )

  it.effect("folds a grandchild under the child tool that requested it", () =>
    Effect.gen(function* () {
      const nestedChildEvents: ReadonlyArray<ExecutionBackend.Event> = [
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
            events: [event(grandchildId, "g1", 1, "model.output.completed", { text: "deep answer" })].concat(
              event(grandchildId, "g2", 2, "execution.completed"),
            ),
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
      expect(Object.keys(stored?.consumed ?? {}).toSorted()).toEqual([childId, grandchildId, "root"].toSorted())
    }),
  )

  it.effect("reports a typed failure and keeps stored state when a resumed cursor is rejected", () =>
    Effect.gen(function* () {
      const failures: Array<ExecutionIngest.IngestFailure> = []
      const turn = makeTurn("completed")
      const turns = yield* TurnRepository.makeMemory([turn])
      const transcripts = Context.get(
        yield* Layer.build(TranscriptRepository.memoryLayer),
        TranscriptRepository.Service,
      )
      yield* transcripts.replace(turn, Transcript.project("root", "delegate", rootEvents.slice(0, 2)), {
        consumed: { root: { cursor: "r2", sequence: 2 } },
      })
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
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.void,
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
        onFailure: (failure) => failures.push(failure),
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* settle(ingest)

      expect(failures).toHaveLength(1)
      expect(failures[0]?.reason).toBe("cursor-rejected")
      expect(failures[0]?.executionId).toBe("root")
      const stored = yield* transcripts.get(rootId)
      expect(stored?.consumed?.root).toEqual({ cursor: "r2", sequence: 2 })
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
      expect((yield* transcripts.get(rootId))?.consumed?.root).toEqual({ cursor: "b3", sequence: 3 })
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
        commitEvents: 2,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow

      expect(commits).toHaveLength(1)
      yield* Deferred.succeed(hold, undefined)
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
      expect(stored?.consumed?.root).toEqual({ cursor: "r3", sequence: 3, status: "completed" })
      expect(stored?.units.some((unit) => unit.parentId !== undefined && unit.turnId === childId)).toBe(true)
    }),
  )

  it.effect("ignores redelivered owner events instead of reporting a rejected cursor", () =>
    Effect.gen(function* () {
      const failures: Array<ExecutionIngest.IngestFailure> = []
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
      expect((yield* transcripts.get(rootId))?.consumed?.root).toEqual({
        cursor: "r3",
        sequence: 3,
        status: "completed",
      })
    }),
  )

  it.effect("finishes a held catch-up page before recording terminal state and drops stale stored units", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const paged: ReadonlyArray<ExecutionBackend.Event> = [
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
      expect((yield* transcripts.get(rootId))?.consumed?.root?.status).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* settle(ingest)

      const stored = yield* transcripts.get(rootId)
      expect(stored?.consumed?.root).toEqual({ cursor: "p3", sequence: 3, status: "completed" })
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
        const failures: Array<ExecutionIngest.IngestFailure> = []
        const { ingest, transcripts } = yield* makeHarness({
          script: {
            root: {
              events: rootEvents,
              status: "running",
              pages: (after) => {
                if (after === undefined) return { events: rootEvents.slice(0, 1), hasMore: true, newestCursor: "r1" }
                if (malformedTerminal === "empty") return { events: [], hasMore: true, newestCursor: "r2" }
                return { events: rootEvents.slice(1, 2), hasMore: true, newestCursor: after }
              },
            },
          },
          turnStatus: "running",
          onFailure: (failure) => failures.push(failure),
        })

        yield* ingest.ensure({ threadId, turnId: rootId })
        yield* ingest.consumed(rootId)

        expect(failures).toHaveLength(1)
        expect(failures[0]?.reason).toBe("backend")
        expect(failures[0]?.executionId).toBe("root")
        expect(failures[0]?.message).toContain("did not advance")
        expect((yield* transcripts.get(rootId))?.consumed?.root?.status).toBeUndefined()
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

  it.effect("drops stored child units whose parent tool no longer exists", () =>
    Effect.gen(function* () {
      const orphan = Transcript.project("orphan", "", [
        event("orphan", "o1", 1, "model.output.completed", { text: "orphan text" }),
      ])
      const stored = Transcript.withNestedProjections(Transcript.project("root", "delegate", rootEvents), [
        { parentId: "missing-parent", projection: orphan },
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
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "orphan text"),
      ).toBe(false)
      expect(
        projection?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "child answered"),
      ).toBe(true)
    }),
  )
})
