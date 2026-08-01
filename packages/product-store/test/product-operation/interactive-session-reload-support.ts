import * as TranscriptPage from "@rika/product/transcript-page"
import { OperationUnavailable } from "@rika/product/product-operation"
import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as ExecutionInspection from "@rika/product/execution-inspection"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { Context, Deferred, Effect, Fiber, Layer, Ref, Schema, Scope } from "effect"
import * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import * as TurnContract from "@rika/product/turn-repository"
import {
  RuntimeFixtures,
  TranscriptFixtures,
  completeServerTimeline,
  executionRoute,
  invalidatedProjection,
  storeProjection,
  thread,
  waitForSessions,
  productLayer,
  collectEvents,
  serverEvents,
  active,
} from "./interactive-session-base-support"
import { projectionVersion } from "./interactive-session-base-support"

export const subagentToolId = "done:call_1"
export const subagentChildId = "child:execution%3Adone:call_1"

export const subagentRootEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = serverEvents([
  {
    executionId: "execution:done",
    cursor: "done-started",
    sequence: 0,
    type: "execution.started",
    createdAt: 0,
  },
  {
    executionId: "execution:done",
    cursor: "done-call",
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 1,
    data: { tool_call_id: "call_1", tool_name: "oracle", input: { prompt: "Review the plan." } },
  },
  {
    executionId: "execution:done",
    cursor: "done-spawn",
    sequence: 2,
    type: "child_run.spawned",
    createdAt: 2,
    data: { child_execution_id: subagentChildId, preset_name: "Oracle" },
  },
  {
    executionId: "execution:done",
    cursor: "done-child-completed",
    sequence: 3,
    type: "child_run.event",
    createdAt: 3,
    data: { child_execution_id: subagentChildId, status: "completed" },
  },
  {
    executionId: "execution:done",
    cursor: "done-result",
    sequence: 4,
    type: "tool.result.received",
    createdAt: 4,
    data: { tool_call_id: "call_1", output: { output: [{ type: "text", text: "**All tests pass.**" }] } },
  },
  { executionId: "execution:done", cursor: "done-final", sequence: 5, type: "execution.completed", createdAt: 5 },
])

export const subagentChildEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> = serverEvents([
  {
    executionId: subagentChildId,
    cursor: "childstarted~a0",
    sequence: 0,
    type: "execution.started",
    createdAt: 0,
  },
  {
    executionId: subagentChildId,
    cursor: "childtool~a1",
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 1,
    data: { tool_call_id: "child-call", tool_name: "bash", input: { command: "bun test" } },
  },
  {
    executionId: subagentChildId,
    cursor: "childresult~a2",
    sequence: 2,
    type: "tool.result.received",
    createdAt: 2,
    data: { tool_call_id: "child-call", output: { text: "ok" } },
  },
  {
    executionId: subagentChildId,
    cursor: "childanswer~a3",
    sequence: 3,
    type: "model.output.completed",
    createdAt: 3,
    text: "**All tests pass.**",
  },
  { executionId: subagentChildId, cursor: "childdone~a4", sequence: 4, type: "execution.completed", createdAt: 4 },
])

export interface SubagentReloadHarness {
  readonly session: InteractiveSession
  readonly subagentThread: RuntimeFixtures.Thread.Thread
  readonly transcripts: TranscriptRepositoryContract.Interface
  readonly turns: TurnContract.Interface
}

type SubagentReloadOptions = {
  readonly storedTree: TranscriptFixtures.TranscriptProjectionModel.Projection
  readonly turnLastCursor: string
  readonly childReplayEvents: ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>
  readonly consumed?: Readonly<
    Record<
      string,
      { readonly cursor: string; readonly sequence: number; readonly status?: "completed" | "failed" | "cancelled" }
    >
  >
  readonly turnStatus?: RuntimeFixtures.ExecutionStatus.Status
  readonly followed?: Ref.Ref<ReadonlyArray<string>>
  readonly inspection?: (executionId: string) => RuntimeFixtures.ExecutionInspection.Inspection | undefined
  readonly replayEvents?: (executionId: string) => ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event>
  readonly pageEvents?: (executionId: string, after: string | undefined) => RuntimeFixtures.ExecutionEvent.EventPage
  readonly projectionVersion?: number
}

export const makeSubagentReloadHarness: (
  options: SubagentReloadOptions,
) => Effect.Effect<SubagentReloadHarness, object, Scope.Scope> = Effect.fn(
  "InteractiveSessionTest.makeSubagentReloadHarness",
)(function* (options) {
  const subagentThread = thread("subagent-thread", 1)
  const doneTurn: RuntimeFixtures.Turn.AgentExecutionTurn = {
    _tag: "AgentExecution",
    id: RuntimeFixtures.Turn.TurnId.make("done"),
    threadId: subagentThread.id,
    prompt: "delegate",
    stopIntent: "none",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    executionRoute: executionRoute(),
    status: options.turnStatus ?? "completed",
    createdAt: 1,
    updatedAt: 1,
    lastCursor: options.turnLastCursor,
  }
  const repositories = yield* RuntimeFixtures.ThreadRepository.makeMemory([subagentThread])
  const turns = yield* RuntimeFixtures.TurnRepository.makeMemory([doneTurn])
  const sessions = yield* Ref.make<ReadonlyArray<InteractiveSession>>([])
  const transcripts =
    options.projectionVersion === RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion
      ? yield* RuntimeFixtures.TranscriptRepository.makeMemory({
          initial: [invalidatedProjection(doneTurn, options.storedTree.revision)],
          turns,
        })
      : yield* RuntimeFixtures.TranscriptRepository.makeMemory({ turns })
  if (options.projectionVersion !== RuntimeFixtures.TranscriptRepository.invalidatedProjectionVersion)
    yield* storeProjection(transcripts, doneTurn, options.storedTree, {
      ...(options.consumed === undefined ? {} : { consumed: options.consumed }),
      ...(options.projectionVersion === undefined ? {} : { projectionVersion: options.projectionVersion }),
    })
  const inspection = (turnId: string): RuntimeFixtures.ExecutionInspection.Inspection | undefined => {
    if (options.inspection !== undefined) return options.inspection(turnId)
    if (turnId !== "done") return { turnId, status: "completed", waits: [], pendingTools: [], children: [] }
    return {
      turnId,
      status: options.turnStatus ?? "completed",
      lastCursor: "done-final",
      waits: [],
      pendingTools: [],
      children: [{ executionId: subagentChildId, status: "completed" }],
    }
  }
  const eventsFor = (turnId: string): ReadonlyArray<RuntimeFixtures.ExecutionEvent.Event> => {
    const replay = options.replayEvents?.(turnId)
    if (replay !== undefined)
      return completeServerTimeline(replay).map((event) => Object.assign({}, event, { executionId: turnId }))
    if (turnId === "done")
      return completeServerTimeline(subagentRootEvents).map((event) =>
        Object.assign({}, event, { executionId: turnId }),
      )
    if (turnId === subagentChildId)
      return completeServerTimeline(options.childReplayEvents).map((event) =>
        Object.assign({}, event, { executionId: turnId }),
      )
    return []
  }
  const backend = RuntimeFixtures.ExecutionBackend.Service.of({
    invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
    createFanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    registerWorkflows: () => Effect.die("unused"),
    startWorkflow: () => Effect.die("unused"),
    inspectWorkflow: () => Effect.die("unused"),
    cancelWorkflow: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    inspect: (turnId) => Effect.succeed(inspection(turnId)),
    follow: (turnId, cursor, onEvent) => {
      const after = typeof cursor === "string" ? cursor : cursor?.cursor
      const all = eventsFor(turnId)
      const boundary = after === undefined ? -1 : all.findIndex((event) => event.cursor === after)
      const events = all.slice(boundary + 1)
      const inspected = inspection(turnId)
      return (
        options.followed === undefined ? Effect.void : Ref.update(options.followed, (followed) => [...followed, turnId])
      ).pipe(
        Effect.andThen(
          inspected === undefined
            ? RuntimeFixtures.ExecutionBackend.BackendError.make({ message: `ExecutionNotFound ${turnId}` })
            : Effect.void,
        ),
        Effect.tap(() => Effect.sync(() => events.forEach((event) => onEvent?.(event)))),
        Effect.as({ turnId, status: inspected?.status ?? ("completed" as const), events }),
      )
    },
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    replay: (turnId) => Effect.succeed({ turnId, status: "completed" as const, events: eventsFor(turnId) }),
    pageEvents: (turnId, _direction, cursor) =>
      Effect.sync(() => {
        if (options.pageEvents !== undefined) return options.pageEvents(turnId, cursor)
        const events = eventsFor(turnId)
        const boundary = cursor === undefined ? -1 : events.findIndex((event) => event.cursor === cursor)
        return {
          events: events.slice(boundary + 1),
          hasMore: false,
          ...(events.at(-1) === undefined ? {} : { newestCursor: events.at(-1)!.cursor }),
        }
      }),
    resolveInvocationSource: () => Effect.die("unused"),
  })
  const layer = productLayer({
    repositoryLayer: Layer.succeed(RuntimeFixtures.ThreadRepository.Service, repositories),
    turnRepositoryLayer: Layer.succeed(RuntimeFixtures.TurnRepository.Service, turns),
    transcriptRepositoryLayer: Layer.succeed(RuntimeFixtures.TranscriptRepository.Service, transcripts),
    backendLayer: Layer.succeed(RuntimeFixtures.ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.die("unused"),
    makeTurnId: Effect.die("unused"),
    interactive: (_, session) =>
      Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
  })
  const context = yield* Layer.build(layer)
  const operation = Context.get(context, Service)
  yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
  yield* waitForSessions(sessions)
  const session = (yield* Ref.get(sessions))[0]
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return { session, subagentThread, transcripts, turns }
})

export interface ObservedProjectionStream {
  readonly turn: RuntimeFixtures.Turn.AgentExecutionTurn
  readonly streamId: string
  readonly patchRevision: number
  readonly state: Extract<InteractiveEvent, { readonly _tag: "TranscriptProjectionStarted" }>["state"]
  readonly units: ReadonlyMap<string, TranscriptFixtures.TranscriptUnit.Unit>
  readonly rootStatus?: "completed" | "failed" | "cancelled"
}

export const observedProjectionEntries = (
  stream: ObservedProjectionStream,
): ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry> => {
  const turn = stream.rootStatus === undefined ? stream.turn : { ...stream.turn, status: stream.rootStatus }
  return [...stream.units.values()].map((unit) => ({
    turn,
    unit,
    projectionRevision: stream.state.revision,
    projectionModelPhase: stream.state.modelPhase,
  }))
}

export const sortObservedEntries = (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) =>
  entries.toSorted(
    (left, right) =>
      left.turn.createdAt - right.turn.createdAt ||
      String(left.turn.id).localeCompare(String(right.turn.id)) ||
      TranscriptFixtures.TranscriptOrdering.compareUnitOrder(left.unit.order, right.unit.order),
  )

export const latestSelectionEntries = (events: ReadonlyArray<InteractiveEvent>) => {
  let entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry> | undefined
  let selectionEpoch: number | undefined
  let threadId: string | undefined
  const streams = new Map<string, ObservedProjectionStream>()
  for (const event of events) {
    if (event._tag === "SelectionLoaded") {
      entries = event.entries
      selectionEpoch = event.selectionEpoch
      threadId = String(event.thread.id)
      streams.clear()
      continue
    }
    if (event._tag === "TranscriptProjectionStarted") {
      if (!RuntimeFixtures.ThreadResult.TurnResult.isAgentExecution(event.turn)) continue
      if (
        selectionEpoch !== undefined &&
        (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId)
      )
        continue
      selectionEpoch = event.selectionEpoch
      threadId = String(event.threadId)
      streams.set(String(event.rootTurnId), {
        turn: event.turn,
        streamId: event.streamId,
        patchRevision: event.patchRevision,
        state: event.state,
        units: new Map(event.units.map((unit) => [unit.key, unit])),
        ...(event.rootStatus === undefined ? {} : { rootStatus: event.rootStatus }),
      })
      continue
    }
    if (event._tag === "TranscriptProjectionPatched") {
      if (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId) continue
      const rootTurnId = String(event.rootTurnId)
      const current = streams.get(rootTurnId)
      if (
        current === undefined ||
        current.streamId !== event.streamId ||
        current.patchRevision !== event.baseRevision ||
        event.patchRevision !== event.baseRevision + 1
      )
        continue
      const units = new Map(current.units)
      for (const key of event.delta.remove) units.delete(key)
      for (const unit of event.delta.upsert) units.set(unit.key, unit)
      streams.set(rootTurnId, {
        ...current,
        patchRevision: event.patchRevision,
        state: event.state,
        units,
        ...(event.rootStatus === undefined ? {} : { rootStatus: event.rootStatus }),
      })
      continue
    }
    if (event._tag === "TranscriptProjectionStopped") {
      if (event.selectionEpoch !== selectionEpoch || String(event.threadId) !== threadId) continue
      const rootTurnId = String(event.rootTurnId)
      const current = streams.get(rootTurnId)
      if (current === undefined || current.streamId !== event.streamId || current.patchRevision !== event.patchRevision)
        continue
      streams.set(rootTurnId, { ...current, rootStatus: event.status })
    }
  }
  if (entries === undefined && streams.size === 0) return undefined
  const roots = new Set(streams.keys())
  return sortObservedEntries([
    ...(entries ?? []).filter((entry) => !roots.has(String(entry.turn.id))),
    ...[...streams.values()].flatMap(observedProjectionEntries),
  ])
}

export const awaitSelectionEntries = (
  events: ReadonlyArray<InteractiveEvent>,
  until: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const entries = latestSelectionEntries(events)
      if (entries !== undefined && until(entries)) return entries
      yield* Effect.yieldNow
    }
    return latestSelectionEntries(events) ?? []
  })

type SelectionLoadedEvent = Extract<InteractiveEvent, { readonly _tag: "SelectionLoaded" }>
type TranscriptPagePrependedEvent = Extract<InteractiveEvent, { readonly _tag: "TranscriptPagePrepended" }>

export const awaitSelectionLoaded = (
  events: ReadonlyArray<InteractiveEvent>,
  until: (event: SelectionLoadedEvent) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const event = events.findLast(
        (candidate): candidate is SelectionLoadedEvent => candidate._tag === "SelectionLoaded" && until(candidate),
      )
      if (event !== undefined) return event
      yield* Effect.yieldNow
    }
    const detail = events.map((event) => {
      if (event._tag === "SelectionLoaded")
        return {
          tag: event._tag,
          entries: event.entries.map((entry) => entry.unit.key),
          hasOlder: event.hasOlder,
          oldestCursor: event.oldestCursor,
        }
      if (event._tag === "ExecutionFailed") return { tag: event._tag, message: event.message }
      return { tag: event._tag }
    })
    const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(detail).pipe(Effect.orDie)
    return yield* Effect.die(`selection did not load the expected transcript page: ${encoded}`)
  })

export const awaitPrependedPage = (events: ReadonlyArray<InteractiveEvent>, previousCount: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const pages = events.filter(
        (event): event is TranscriptPagePrependedEvent => event._tag === "TranscriptPagePrepended",
      )
      if (pages.length > previousCount) return pages.at(-1)!
      yield* Effect.yieldNow
    }
    return yield* Effect.die("older transcript page did not load")
  })

export const selectionEntriesFor = (
  session: InteractiveSession,
  threadId: RuntimeFixtures.Thread.ThreadId,
  until?: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
): Effect.Effect<
  {
    readonly entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>
    readonly events: ReadonlyArray<InteractiveEvent>
  },
  OperationUnavailable
> =>
  Effect.gen(function* () {
    const events: Array<InteractiveEvent> = []
    yield* collectEvents(session, events)
    yield* session.selectThread(threadId, 1)
    const entries = yield* awaitSelectionEntries(events, (loaded) => until === undefined || until(loaded))
    return { entries, events }
  })

export const nestedSubagentReady = (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => {
  const { nestedTool, nestedAnswer } = nestedSubagentExpectations(entries)
  return nestedTool && nestedAnswer
}

export const nestedSubagentExpectations = (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => {
  const nested = entries.filter((entry) => entry.unit.parentId === subagentToolId)
  const nestedTool = nested.some(
    (entry) =>
      entry.unit.content._tag === "Block" &&
      entry.unit.content.block._tag === "ToolCall" &&
      entry.unit.content.block.name === "bash",
  )
  const nestedAnswer = nested.some(
    (entry) =>
      entry.unit.content._tag === "Entry" &&
      entry.unit.content.role === "assistant" &&
      entry.unit.content.text.includes("All tests pass."),
  )
  return { nestedTool, nestedAnswer }
}

export { Context, Deferred, Effect, Fiber, Layer, Ref, Schema }
export {
  RuntimeFixtures,
  TranscriptFixtures,
  completeServerTimeline,
  executionRoute,
  invalidatedProjection,
  storeProjection,
  thread,
  waitForSessions,
  productLayer,
  collectEvents,
  serverEvents,
  active,
}
export { projectionVersion }
