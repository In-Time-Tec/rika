import { OperationUnavailable } from "@rika/product/product-operation"
import type { InteractiveSession } from "@rika/product/interactive-session"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Service } from "@rika/product/product-operation-service"
import { Context, Effect, Layer, Ref, Scope } from "effect"
import * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import * as TurnContract from "@rika/product/turn-repository"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"
import {
  completeServerTimeline,
  thread,
  waitForSessions,
  productLayer,
  collectEvents,
  serverEvents,
} from "./interactive-session-base-support"
import { executionRoute } from "../support/product-test-current-state"
import { invalidatedProjection, storeProjection } from "../support/product-test-transcript-fixture"
import { awaitSelectionEntries } from "./interactive-session-selection-support"

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

interface SubagentReloadHarness {
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

type SelectionEntries = {
  readonly entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>
  readonly events: ReadonlyArray<InteractiveEvent>
}

function selectionEntriesForImplementation(
  threadId: RuntimeFixtures.Thread.ThreadId,
  until?: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
): (session: InteractiveSession) => Effect.Effect<SelectionEntries, OperationUnavailable>
function selectionEntriesForImplementation(
  session: InteractiveSession,
  threadId: RuntimeFixtures.Thread.ThreadId,
  until?: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
): Effect.Effect<SelectionEntries, OperationUnavailable>
function selectionEntriesForImplementation(
  sessionOrThreadId: InteractiveSession | RuntimeFixtures.Thread.ThreadId,
  threadIdOrUntil?:
    | RuntimeFixtures.Thread.ThreadId
    | ((entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean),
  until?: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
):
  | Effect.Effect<SelectionEntries, OperationUnavailable>
  | ((session: InteractiveSession) => Effect.Effect<SelectionEntries, OperationUnavailable>) {
  if (typeof sessionOrThreadId === "string") {
    if (threadIdOrUntil !== undefined && typeof threadIdOrUntil !== "function")
      throw new Error("Invalid selection arguments")
    const threadId = sessionOrThreadId
    const untilPredicate = threadIdOrUntil
    return (session) => selectionEntriesForImplementation(session, threadId, untilPredicate)
  }
  if (typeof threadIdOrUntil !== "string") throw new Error("Invalid selection arguments")
  const threadId = threadIdOrUntil
  return Effect.gen(function* () {
    const events: Array<InteractiveEvent> = []
    yield* collectEvents(sessionOrThreadId, events)
    yield* sessionOrThreadId.selectThread(threadId, 1)
    const entries = yield* awaitSelectionEntries(events, (loaded) => until === undefined || until(loaded))
    return { entries, events }
  })
}

type SelectionEntriesFor = {
  (
    session: InteractiveSession,
    threadId: RuntimeFixtures.Thread.ThreadId,
    until?: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
  ): Effect.Effect<SelectionEntries, OperationUnavailable>
  (
    threadId: RuntimeFixtures.Thread.ThreadId,
    until?: (entries: ReadonlyArray<RuntimeFixtures.TranscriptPage.Entry>) => boolean,
  ): (session: InteractiveSession) => Effect.Effect<SelectionEntries, OperationUnavailable>
}

export const selectionEntriesFor: SelectionEntriesFor = selectionEntriesForImplementation

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
