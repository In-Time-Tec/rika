import * as InteractiveController from "../src/interactive-controller"
import type * as Operation from "@rika/app/operation"
import * as Thread from "@rika/persistence/thread"
import type * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ExecutionEvents, Keys, Palette, ViewState } from "@rika/tui"
import { renderTranscriptStyled } from "@rika/tui/adapter"
import { HashMap } from "effect"
import { expect, it } from "vitest"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-a"),
  workspace: "/work",
  title: "Thread A",
  lineage: { _tag: "Original" },
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
}

const entries = (
  id: string,
  createdAt: number,
  events: ReadonlyArray<{
    readonly cursor: string
    readonly sequence: number
    readonly type: string
    readonly createdAt: number
    readonly text?: string
    readonly data?: Readonly<Record<string, unknown>>
  }> = [],
) => {
  const turn = {
    _tag: "AgentExecution" as const,
    id: Turn.TurnId.make(id),
    threadId: thread.id,
    prompt: id,
    author: { _tag: "Human" } as const,
    lineage: { _tag: "Original" } as const,
    executionRoute: Turn.testExecutionRoute(),
    status: "completed" as const,
    stopIntent: "none" as const,
    createdAt,
    updatedAt: createdAt,
  }
  const projection = Transcript.project(id, id, events)
  return projection.units.map((unit) =>
    Object.assign(
      {
        turn,
        unit,
        projectionRevision: projection.revision,
        projectionModelPhase: projection.modelPhase,
      },
      projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd },
    ),
  )
}

type AgentTranscriptEntry = Omit<TranscriptRepository.Entry, "turn"> & {
  readonly turn: Turn.AgentExecutionTurn
}

const asRunningEntry = (entry: TranscriptRepository.Entry): AgentTranscriptEntry => {
  if (!Turn.isAgentExecution(entry.turn)) throw new TypeError("Running transcript fixture requires an agent turn")
  return { ...entry, turn: { ...entry.turn, status: "running" } }
}

const cursor = (entry: TranscriptRepository.Entry): TranscriptRepository.PageCursor => ({
  createdAt: entry.turn.createdAt,
  turnId: entry.turn.id,
  orderKey: Transcript.encodeUnitOrder(entry.unit.order),
})

const initialState = (): InteractiveController.State => ({
  model: ViewState.initial("/work", "medium"),
  replayTurns: new Map(),
  entries: [],
  revisions: new Map(),
  liveProjections: new Map(),
  threadCostUsd: 0,
  selectionEpoch: 0,
})

const visibleState = (projection: Transcript.Projection) => ({
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.usableCompletionSequence === undefined
    ? {}
    : { usableCompletionSequence: projection.usableCompletionSequence }),
})

const unitDelta = (previous: Transcript.Projection, next: Transcript.Projection): Transcript.UnitDelta => {
  const previousUnits = new Map(previous.units.map((unit) => [unit.key, unit] as const))
  const nextUnits = new Map(next.units.map((unit) => [unit.key, unit] as const))
  return {
    upsert: next.units.filter((unit) => JSON.stringify(previousUnits.get(unit.key)) !== JSON.stringify(unit)),
    remove: previous.units.flatMap((unit) => (nextUnits.has(unit.key) ? [] : [unit.key])),
  }
}

const projectionOrigin = (
  event: Transcript.SourceEvent,
  executionId: string,
): Extract<
  Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>["origin"],
  { readonly _tag: "Event" }
> => {
  const blockId = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  const messageSequences = event.type === "steering.delivered" ? event.data?.message_sequences : undefined
  const steeringSequences = Array.isArray(messageSequences)
    ? messageSequences.filter((value): value is number => Number.isSafeInteger(value))
    : undefined
  return {
    _tag: "Event",
    executionId,
    cursor: event.cursor,
    sequence: event.sequence,
    type: event.type,
    createdAt: event.createdAt,
    transient: Transcript.isTransientEvent(event),
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(typeof blockId === "string" ? { blockId } : {}),
    ...(steeringSequences === undefined || steeringSequences.length === 0 ? {} : { steeringSequences }),
  }
}

const terminalRootStatus = (event: Transcript.SourceEvent): "completed" | "failed" | "cancelled" | undefined => {
  if (event.type === "execution.completed") return "completed"
  if (event.type === "execution.failed") return "failed"
  if (event.type === "execution.cancelled") return "cancelled"
  return undefined
}

const transientDelta = (index: number, text: string): Transcript.SourceEvent => ({
  cursor: `transient-${index}`,
  sequence: 2,
  type: "model.output.delta",
  createdAt: 3 + index,
  text,
  data: { delta: text, transient_index: index, model_call_id: "call-1", model_attempt_id: "attempt-1" },
})

const startProjection = (state: InteractiveController.State, turn: Turn.Turn, projection: Transcript.Projection) =>
  InteractiveController.update(state, {
    _tag: "TranscriptProjectionStarted",
    selectionEpoch: state.selectionEpoch,
    threadId: turn.threadId,
    rootTurnId: turn.id,
    turn,
    streamId: `stream:${turn.id}`,
    patchRevision: 0,
    state: visibleState(projection),
    units: projection.units,
  })

const openProjectionStream = (state: InteractiveController.State, turnId: string) => {
  const stream = state.projectionStreams?.get(turnId)
  if (stream?._tag !== "Open") throw new Error(`Projection ${turnId} is not open`)
  return stream
}

const makeProjectionFeed = (
  selected: InteractiveController.State,
  turn: Turn.Turn,
  initialProjection: Transcript.Projection,
) => {
  const streamId = `stream:${turn.id}`
  let state = startProjection(selected, turn, initialProjection).state
  let projection = initialProjection
  let patchRevision = 0
  return {
    get state() {
      return state
    },
    get projection() {
      return projection
    },
    apply(
      event: Transcript.SourceEvent,
      options: { readonly executionId?: string; readonly projection?: Transcript.Projection } = {},
    ) {
      const next = options.projection ?? Transcript.applyEvent(projection, event)
      const baseRevision = patchRevision
      patchRevision += 1
      const rootStatus = terminalRootStatus(event)
      const update = InteractiveController.update(state, {
        _tag: "TranscriptProjectionPatched",
        selectionEpoch: state.selectionEpoch,
        threadId: turn.threadId,
        rootTurnId: turn.id,
        streamId,
        baseRevision,
        patchRevision,
        origin: projectionOrigin(event, options.executionId ?? `execution:${turn.id}`),
        state: visibleState(next),
        delta: unitDelta(projection, next),
        ...(rootStatus === undefined ? {} : { rootStatus }),
      })
      state = update.state
      projection = next
      return update
    },
    stop(status: "completed" | "failed" | "cancelled") {
      const update = InteractiveController.update(state, {
        _tag: "TranscriptProjectionStopped",
        selectionEpoch: state.selectionEpoch,
        threadId: turn.threadId,
        rootTurnId: turn.id,
        streamId,
        patchRevision,
        status,
      })
      state = update.state
      return update
    },
  }
}

const key = (input: Partial<Keys.Key> & Pick<Keys.Key, "name">): Keys.Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

it("rebuilds prepended pages in authoritative transcript order", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [
      ...entries("new", 2, [
        {
          cursor: "new-answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 2,
          text: "new answer",
        },
      ]),
    ],
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [
      ...entries("old", 1, [
        {
          cursor: "old-answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 1,
          text: "old answer",
        },
      ]),
    ],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(prepended.state.model.entries.map((value) => value.text)).toEqual(["old", "old answer", "new", "new answer"])
})

it("clears queue edit mode when a selection loads a thread", () => {
  const initial: InteractiveController.State = {
    ...initialState(),
    model: {
      ...ViewState.initial("/work", "medium"),
      editingTurnId: "old-turn",
      editReturn: { input: "draft", attachments: [] },
      input: "half edited",
      cursor: 11,
    },
  }
  const loaded = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [],
    hasOlder: false,
    threadCostUsd: 0,
  })
  expect(loaded.state.model.editingTurnId).toBeUndefined()
  expect(loaded.state.model.editReturn).toBeUndefined()
})

it("forgets live child outcomes when SelectionLoaded replaces the transcript", () => {
  const remembered = {
    ...initialState(),
    model: {
      ...ViewState.initial("/work", "medium"),
      childExecutionOutcomes: { "turn:agent": { status: "complete" } },
    },
  }
  const loaded = InteractiveController.update(remembered, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("turn", 1, [
      {
        cursor: "agent",
        sequence: 0,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
      },
      { cursor: "failed", sequence: 1, type: "execution.failed", createdAt: 2, text: "replacement failed" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(loaded.state.model.childExecutionOutcomes).toEqual({})
  expect(loaded.state.model.blocks).toContainEqual(
    expect.objectContaining({ _tag: "Error", detail: "replacement failed" }),
  )
})

it("maps the new-thread palette action to a command and resets the transcript from the fresh selection", () => {
  const populated = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 1,
    queue: [{ id: Turn.TurnId.make("queued"), prompt: "queued" }],
    thread,
    entries: entries("old", 1, [
      { cursor: "answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "old answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 1,
  }).state

  expect(InteractiveController.paletteCommand({ _tag: "NewThread" })).toEqual({ _tag: "NewThread" })
  expect(InteractiveController.paletteCommands).toContainEqual({
    id: "new-thread",
    category: "thread",
    label: "New thread",
    action: { _tag: "NewThread" },
  })
  const palette: Array<InteractiveController.PaletteCommand> = []
  InteractiveController.installPaletteCommands(palette)
  InteractiveController.installPaletteCommands(palette)
  expect(palette).toEqual(InteractiveController.paletteCommands)
  InteractiveController.installPaletteCommands(Palette.commands as Array<InteractiveController.PaletteCommand>)
  let paletteModel = ViewState.update(ViewState.initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  paletteModel = ViewState.update(paletteModel, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(paletteModel.pendingAction).toEqual({ _tag: "NewThread" })
  const freshThread = { ...thread, id: Thread.ThreadId.make("fresh"), title: "New thread" }
  const reset = InteractiveController.update(populated, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread: freshThread,
    entries: [],
    hasOlder: false,
    threadCostUsd: 0,
  }).state

  expect(reset.model).toMatchObject({
    currentThreadId: "fresh",
    currentThreadTitle: "New thread",
    entries: [],
    blocks: [],
    items: [],
    queue: [],
    queueRevision: 0,
    costUsd: 0,
  })
  expect(reset.replayTurns.size).toBe(0)
  expect(reset.liveProjections.size).toBe(0)
  expect(reset.revisions.size).toBe(0)
})

it("defaults the queue selection to the newest item when the prior selection is gone", () => {
  const initial: InteractiveController.State = {
    ...initialState(),
    model: { ...ViewState.initial("/work", "medium"), queueSelection: "vanished" },
  }
  const loaded = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [
      { id: Turn.TurnId.make("q1"), prompt: "one" },
      { id: Turn.TurnId.make("q2"), prompt: "two" },
    ],
    thread,
    entries: [],
    hasOlder: false,
    threadCostUsd: 0,
  })
  expect(loaded.state.model.queueSelection).toBe("q2")
})

it("preserves repository order across Turns with overlapping event sequences", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [
      ...entries("old", 1, [
        { cursor: "old-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "old answer" },
      ]),
      ...entries("new", 2, [
        { cursor: "new-1", sequence: 1, type: "model.output.completed", createdAt: 2, text: "new answer" },
      ]),
    ],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(page.state.model.entries.map((entry) => entry.text)).toEqual(["old", "old answer", "new", "new answer"])
})

it("keeps a live projection when stale persisted units arrive for the same Turn", () => {
  const initial = initialState()
  const persisted = entries("new", 2, [
    { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
  ])
  const turn = { ...persisted[0]!.turn, status: "running" as const }
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persisted,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const liveEvent = {
    cursor: "live-2",
    sequence: 2,
    type: "model.output.completed",
    createdAt: 2,
    text: "live answer",
  }
  const projection = Transcript.project(turn.id, turn.prompt, [
    { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
  ])
  const feed = makeProjectionFeed(page.state, turn, projection)
  const patched = feed.apply(liveEvent)
  const stale = InteractiveController.update(patched.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persisted,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const staleOlderEntry = entries("new", 2, [
    { cursor: "older-0", sequence: 0, type: "model.output.completed", createdAt: 0, text: "older answer" },
  ]).find((entry) => entry.unit.content._tag === "Entry" && entry.unit.content.role === "assistant")
  expect(staleOlderEntry).toBeDefined()
  if (staleOlderEntry === undefined) return
  const prepended = InteractiveController.update(patched.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [staleOlderEntry],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(patched.state.model.entries.at(-1)?.text).toBe("live answer")
  expect(stale.state).toBe(patched.state)
  expect(prepended.state.model.entries.map((entry) => entry.text)).not.toContain("older answer")
  expect(prepended.state.model.entries.map((entry) => entry.text)).toContain("live answer")
  expect(prepended.state.revisions.get("new")).toBe(2)
})

it("applies transient output deltas that share the durable head sequence", () => {
  const initial = initialState()
  const source = [
    { cursor: "started-1", sequence: 1, type: "execution.started", createdAt: 1 },
    { cursor: "prepared-2", sequence: 2, type: "model.input.prepared", createdAt: 2 },
  ]
  const persisted = entries("new", 2, source)
  const turn = { ...persisted[0]!.turn, status: "running" as const }
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persisted,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  expect(page.state.revisions.get("new")).toBe(2)

  const feed = makeProjectionFeed(page.state, turn, Transcript.project(turn.id, turn.prompt, source))
  const first = feed.apply(transientDelta(1, "hel"))
  const second = feed.apply(transientDelta(2, "lo"))
  const completed = feed.apply({
    cursor: "cycle-3",
    sequence: 3,
    type: "model.cycle.completed",
    createdAt: 6,
    text: "hello world",
  })

  expect(first.state.model.entries.at(-1)?.text).toBe("hel")
  expect(second.state.model.entries.at(-1)?.text).toBe("hello")
  expect(first.state.revisions.get("new")).toBe(2)
  expect(second.state.revisions.get("new")).toBe(2)
  expect(completed.state.model.entries.at(-1)?.text).toBe("hello world")
  expect(completed.state.revisions.get("new")).toBe(3)
})

it("reconciles a stale prepended tool call with its newer retained result", () => {
  const initial = initialState()
  const resultPage = entries("new", 2, [
    {
      cursor: "result-2",
      sequence: 2,
      type: "tool.result.received",
      createdAt: 2,
      data: { tool_call_id: "call-1", output: "ok" },
    },
  ])
  const staleCall = entries("new", 2, [
    {
      cursor: "call-1",
      sequence: 1,
      type: "tool.call.requested",
      createdAt: 1,
      data: { tool_call_id: "call-1", tool_name: "read", input: "a.ts" },
    },
  ]).find((entry) => entry.unit.content._tag === "Block")
  expect(staleCall).toBeDefined()
  if (staleCall === undefined) return
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: resultPage,
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [staleCall],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(prepended.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "new:call-1", status: "complete", output: "ok" }),
  ])
  expect(prepended.state.revisions.get("new")).toBe(2)
})

it("owns transcript page, prepend, and patch reduction", () => {
  const initial = initialState()
  const currentEntries = entries("new", 2)
  const activeTurn = { ...currentEntries[0]!.turn, status: "running" as const }
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: currentEntries,
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const feed = makeProjectionFeed(prepended.state, activeTurn, Transcript.empty(activeTurn.id, activeTurn.prompt))
  const patched = feed.apply({
    cursor: "cursor-1",
    sequence: 1,
    type: "model.output.completed",
    createdAt: 3,
    text: "answer",
  })
  expect(page.state.entries).toEqual([])
  expect(page.state.liveProjections.has(activeTurn.id)).toBe(true)
  expect(prepended.state.entries.map((value) => value.turn.id)).toEqual([Turn.TurnId.make("old")])
  expect(prepended.preserveAnchor).toBe(true)
  expect(patched.state.model.entries.at(-1)).toMatchObject({ role: "assistant", text: "answer" })
})

it("normalizes malformed page order and duplicate units across selection and prepend", () => {
  const oldEntries = entries("old", 1, [
    { cursor: "old-answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "old answer" },
  ])
  const newEntries = entries("new", 2, [
    { cursor: "new-answer", sequence: 1, type: "model.output.completed", createdAt: 2, text: "new answer" },
  ])
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [...newEntries.toReversed(), ...oldEntries.toReversed(), ...newEntries],
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(selected.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [...oldEntries, ...oldEntries],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(selected.state.entries.map((entry) => entry.unit.key)).toEqual([
    "turn:old:user",
    Transcript.identityKey("assistant", "old", 0),
    "turn:new:user",
    Transcript.identityKey("assistant", "new", 0),
  ])
  expect(prepended.state.entries).toEqual(selected.state.entries)
  expect(prepended.state.model.entries.map((entry) => entry.text)).toEqual(["old", "old answer", "new", "new answer"])
})

it("inserts an older partial Turn page between retained opening and final entries", () => {
  const base = entries("partial", 2)
  const turn = base[0]!.turn
  const entry = (unitKey: string, sequence: number, text: string) => ({
    turn,
    unit: {
      key: unitKey,
      turnId: turn.id,
      order: Transcript.unitOrder(unitKey, sequence),
      revision: sequence,
      content: { _tag: "Entry" as const, role: "assistant" as const, text },
    },
    projectionRevision: 222,
    projectionModelPhase: 0,
  })
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [entry("opening", 1, "opening"), entry("final", 222, "final")],
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(selected.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [entry("middle-3", 3, "middle 3"), entry("middle-2", 2, "middle 2")],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(prepended.state.entries.map((value) => value.unit.key)).toEqual(["opening", "middle-2", "middle-3", "final"])
  expect(prepended.state.model.entries.map((value) => value.text)).toEqual(["opening", "middle 2", "middle 3", "final"])
})

it("projects child execution units beneath the matching subagent", () => {
  const pageEntries = entries("parent", 2)
  const turn = { ...pageEntries[0]!.turn, status: "running" as const }
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const requestedEvent: Transcript.SourceEvent = {
    cursor: "agent",
    sequence: 0,
    type: "tool.call.requested",
    createdAt: 3,
    data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
  }
  const spawnedEvent: Transcript.SourceEvent = {
    cursor: "spawned",
    sequence: 1,
    type: "child_run.spawned",
    createdAt: 4,
    data: {
      tool_call_id: "agent",
      child_execution_id: "execution:parent:child:agent",
    },
  }
  const childToolEvent: Transcript.SourceEvent = {
    cursor: "child-read",
    sequence: 0,
    type: "tool.call.requested",
    createdAt: 5,
    data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
  }
  const childResponseEvent: Transcript.SourceEvent = {
    cursor: "child-response",
    sequence: 1,
    type: "model.output.completed",
    createdAt: 6,
    text: "## Review complete\n\n**No defects found.**",
  }
  let parent = Transcript.empty(turn.id, turn.prompt)
  const feed = makeProjectionFeed(page.state, turn, parent)
  parent = Transcript.applyEvent(parent, requestedEvent)
  feed.apply(requestedEvent, { projection: parent })
  parent = Transcript.applyEvent(parent, spawnedEvent)
  feed.apply(spawnedEvent, { projection: parent })
  const childId = "parent:child:agent"
  let childProjection = Transcript.applyEvent(Transcript.empty(childId, ""), childToolEvent)
  const child = feed.apply(childToolEvent, {
    executionId: `execution:${childId}`,
    projection: Transcript.withNestedProjections(parent, [
      { parentId: `${turn.id}:agent`, projection: childProjection },
    ]),
  })
  childProjection = Transcript.applyEvent(childProjection, childResponseEvent)
  const response = feed.apply(childResponseEvent, {
    executionId: `execution:${childId}`,
    projection: Transcript.withNestedProjections(parent, [
      { parentId: `${turn.id}:agent`, projection: childProjection },
    ]),
  })

  expect(child.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "parent:agent", childId: "execution:parent:child:agent" }),
    expect.objectContaining({ _tag: "ToolCall", id: Transcript.scopedIdentity(childId, "read") }),
  ])
  expect(child.state.model.items[2]).toMatchObject({
    id: Transcript.identityKey("tool", childId, "read"),
    parentId: "parent:agent",
  })
  expect(child.state.revisions.get("parent")).toBe(1)
  expect(response.state.model.entries).toContainEqual(
    expect.objectContaining({ role: "assistant", text: "## Review complete\n\n**No defects found.**" }),
  )
  expect(response.state.model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: Transcript.identityKey("assistant", childId, 0),
      parentId: "parent:agent",
    }),
  )
  expect(response.state.revisions.get("parent")).toBe(1)
})

it("attaches parallel child streams when task rows lack explicit spawn links", () => {
  const turnId = "parallel"
  const childIds = ["one", "two", "three", "four"].map(
    (callId) => `child:execution%3A${turnId}:rika:execution%3A${turnId}:${callId}`,
  )
  const pageEntries = entries(turnId, 2)
  const turn = { ...pageEntries[0]!.turn, status: "running" as const }
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  let parent = Transcript.empty(turnId, turn.prompt)
  const feed = makeProjectionFeed(selected.state, turn, parent)

  for (const [sequence, callId] of ["one", "two", "three", "four"].entries()) {
    const event: Transcript.SourceEvent = {
      cursor: `task-${callId}`,
      sequence,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: callId, tool_name: "task", input: { prompt: `Explore ${callId}` } },
    }
    parent = Transcript.applyEvent(parent, event)
    feed.apply(event, { projection: parent })
  }

  const children = new Map<string, Transcript.Projection>()
  for (const [index, childId] of childIds.entries()) {
    const toolEvent: Transcript.SourceEvent = {
      cursor: `child-tool-${index}`,
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "read", tool_name: "read", input: { path: `src/${index}.ts` } },
    }
    const responseEvent: Transcript.SourceEvent = {
      cursor: `child-response-${index}`,
      sequence: 1,
      type: "model.output.completed",
      createdAt: 5,
      text: `## Agent ${index + 1}\n\n**Complete.**`,
    }
    children.set(childId, Transcript.applyEvent(Transcript.empty(childId, ""), toolEvent))
    const nested = () =>
      Transcript.withNestedProjections(
        parent,
        [...children].map(([, projection], childIndex) => ({
          parentId: `${turnId}:${["one", "two", "three", "four"][childIndex]}`,
          projection,
        })),
      )
    feed.apply(toolEvent, { executionId: `execution:${childId}`, projection: nested() })
    children.set(childId, Transcript.applyEvent(children.get(childId)!, responseEvent))
    feed.apply(responseEvent, { executionId: `execution:${childId}`, projection: nested() })
  }

  const toolRows = (feed.state.model.items as ReadonlyArray<ViewState.TranscriptItem>).filter(
    (item) => item._tag === "Block" && item.id?.startsWith("tool:"),
  )
  expect(toolRows).toHaveLength(8)
  expect(toolRows.filter((item) => item.parentId !== undefined)).toHaveLength(4)
  expect(feed.state.model.entries.filter((entry) => entry.text.startsWith("## Agent"))).toHaveLength(4)
})

it("reloads one completed subagent tree with rendered markdown and no serialized result", () => {
  const target = entries("durable-parent", 2)[0]!.turn
  const childId = "durable-parent:child:agent"
  const serialized =
    '{"status":"completed","output":[{"type":"text","text":"## Review complete\\n\\n**No defects found.**"}]}'
  const parent = Transcript.project(target.id, target.prompt, [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 2,
      data: {
        tool_call_id: "agent",
        tool_name: "transfer_to_oracle",
        input: { input: [{ type: "text", text: "Review the projection" }] },
      },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 3,
      data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
    },
    {
      cursor: "result",
      sequence: 2,
      type: "tool.result.received",
      createdAt: 4,
      data: { tool_call_id: "agent", output: serialized },
    },
    { cursor: "done", sequence: 3, type: "execution.completed", createdAt: 5 },
  ])
  const child = Transcript.project(childId, "", [
    {
      cursor: "read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/projection.ts" } },
    },
    {
      cursor: "answer",
      sequence: 1,
      type: "model.output.completed",
      createdAt: 4,
      text: "## Review complete\n\n**No defects found.**",
    },
    { cursor: "child-done", sequence: 2, type: "execution.completed", createdAt: 5 },
  ])
  const durable = Transcript.withNestedProjections(parent, [{ parentId: `${target.id}:agent`, projection: child }])
  const persistedEntries = durable.units.map((unit) => ({
    turn: target,
    unit,
    projectionRevision: durable.revision,
    projectionModelPhase: durable.modelPhase,
  }))
  const base = initialState()
  const initial = { ...base, model: { ...base.model, expandedRowKeys: [`tool:${target.id}:agent`] } }

  const loaded = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persistedEntries,
    hasOlder: false,
    threadCostUsd: 0,
  })
  let liveModel = ExecutionEvents.projectUnits(ViewState.initial("/work", "medium"), parent.units)
  liveModel = ExecutionEvents.projectChildUnits(liveModel, `${target.id}:agent`, child.units)
  liveModel = { ...liveModel, expandedRowKeys: [`tool:${target.id}:agent`] }
  const rendered = renderTranscriptStyled(loaded.state.model)
  const text = rendered.chunks.map((chunk) => chunk.text).join("")
  const liveText = renderTranscriptStyled(liveModel)
    .chunks.map((chunk) => chunk.text)
    .join("")
  const blocks = loaded.state.model.blocks as ReadonlyArray<ViewState.TranscriptBlock>
  const agents = blocks.filter((block) => block._tag === "ToolCall" && block.presentation.family === "agent")

  expect(agents).toHaveLength(1)
  expect(blocks.filter((block) => block._tag === "ChildAgent")).toHaveLength(0)
  expect(loaded.state.model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: Transcript.identityKey("assistant", childId, 0),
      parentId: `${target.id}:agent`,
    }),
  )
  expect(text).toBe(liveText)
  expect(text).toContain("Review the projection")
  expect(text).toContain("Review complete")
  expect(text).toContain("No defects found.")
  expect(text).not.toContain("##")
  expect(text).not.toContain("**")
  expect(text).not.toContain("\\n")
  expect(text).not.toContain('"}]}')
  expect(text).not.toContain(serialized)
})

it("keeps cancelled child tools terminal in live and reloaded projections", () => {
  const target = { ...entries("cancel-parent", 2)[0]!.turn, status: "running" as const }
  const childId = "child:execution%3Acancel-parent:agent"
  const parent = Transcript.project(target.id, target.prompt, [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 2,
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Run the checks" } },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 3,
      data: { child_execution_id: childId },
    },
    { cursor: "root-cancelled", sequence: 2, type: "execution.cancelled", createdAt: 6 },
  ])
  const child = Transcript.project(childId, "", [
    {
      cursor: "bash",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "bash", tool_name: "bash", input: { command: "sleep 60" } },
    },
  ])
  const durable = Transcript.withNestedProjections(parent, [{ parentId: `${target.id}:agent`, projection: child }])
  const persistedEntries = durable.units.map((unit) => ({
    turn: { ...target, status: "cancelled" as const },
    unit,
    projectionRevision: durable.revision,
    projectionModelPhase: durable.modelPhase,
  }))
  const base = initialState()
  const loaded = InteractiveController.update(base, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persistedEntries,
    hasOlder: false,
    threadCostUsd: 0,
  }).state.model
  let live = ExecutionEvents.projectUnits(ViewState.initial("/work", "medium"), parent.units)
  live = ExecutionEvents.projectChildUnits(live, `${target.id}:agent`, child.units)

  for (const model of [live, loaded]) {
    expect(model.blocks).toEqual([
      expect.objectContaining({ id: `${target.id}:agent`, status: "cancelled" }),
      expect.objectContaining({ id: Transcript.scopedIdentity(childId, "bash"), status: "cancelled" }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(
      renderTranscriptStyled(model)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toContain("⊘ Subagent cancelled")
  }
})

const runningTurn = (id: string): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: Turn.TurnId.make(id),
  threadId: thread.id,
  prompt: `${id} prompt`,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  executionRoute: Turn.testExecutionRoute(),
  status: "running",
  stopIntent: "none",
  createdAt: 2,
  updatedAt: 2,
})

const orphanEntries = (turn: Turn.Turn, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    turn,
    unit: {
      key: `${turn.id}:nested:${index}`,
      turnId: turn.id,
      order: Transcript.unitOrder(`${turn.id}:nested:${index}`, index + 10),
      revision: index + 10,
      parentId: `${turn.id}:agent`,
      content: {
        _tag: "Block" as const,
        block: { _tag: "Notification" as const, title: `nested ${index}`, detail: "detail" },
      },
    },
    projectionRevision: index + 10,
    projectionModelPhase: 0,
  }))

const populatedSelection = (turn: Turn.Turn) =>
  InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("history", 1, [
      { cursor: "history-answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "history answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })

const projectionEvent = (turn: Turn.Turn, text: string, transient = false) => ({
  executionId: `execution:${turn.id}`,
  cursor: `output:${text}`,
  sequence: 1,
  type: "model.output.delta",
  createdAt: 3,
  text,
  ...(transient ? { data: { transient: true } } : {}),
})

it("installs an authoritative projection snapshot for the active turn", () => {
  const active = runningTurn("projection-snapshot")
  const selected = populatedSelection(active)
  const projection = Transcript.project(active.id, active.prompt, [projectionEvent(active, "live answer")])
  const started = startProjection(selected.state, active, projection)

  expect(started.state.model.entries.map((entry) => entry.text)).toContain("live answer")
  expect(started.state.projectionStreams?.get(active.id)).toMatchObject({
    streamId: `stream:${active.id}`,
    patchRevision: 0,
    state: visibleState(projection),
  })
  expect(HashMap.size(openProjectionStream(started.state, active.id).units)).toBe(projection.units.length)
})

it("keeps every open projection visible when snapshots arrive in sequence", () => {
  const active = runningTurn("projection-active")
  const concurrent = { ...runningTurn("projection-concurrent"), createdAt: 3, updatedAt: 3 }
  const activeProjection = Transcript.project(active.id, active.prompt, [projectionEvent(active, "active answer")])
  const concurrentProjection = Transcript.project(concurrent.id, concurrent.prompt, [
    projectionEvent(concurrent, "concurrent answer"),
  ])
  const activeStarted = startProjection(populatedSelection(active).state, active, activeProjection)
  const concurrentStarted = startProjection(activeStarted.state, concurrent, concurrentProjection)

  expect(concurrentStarted.state.model.entries.map((entry) => entry.text)).toEqual(
    expect.arrayContaining([active.prompt, "active answer", concurrent.prompt, "concurrent answer"]),
  )
  expect(concurrentStarted.state.projectionStreams?.size).toBe(2)
})

it("applies exact projection upserts and removals without replaying source events", () => {
  const active = runningTurn("projection-delta")
  const initialProjection = Transcript.project(active.id, active.prompt, [projectionEvent(active, "hel")])
  const selected = populatedSelection(active)
  const started = startProjection(selected.state, active, initialProjection)
  const updatedProjection = Transcript.project(active.id, active.prompt, [projectionEvent(active, "hello")])
  const updatedUnit = updatedProjection.units.find(
    (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant",
  )!
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: {
      _tag: "Event",
      executionId: `execution:${active.id}`,
      cursor: "output:hello",
      sequence: 1,
      type: "model.output.delta",
      createdAt: 3,
      transient: false,
    },
    state: visibleState(updatedProjection),
    delta: { upsert: [updatedUnit], remove: [] },
  })
  const removed = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 1,
    patchRevision: 2,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(updatedProjection),
    delta: { upsert: [], remove: [updatedUnit.key] },
  })

  expect(patched.resync).toBeUndefined()
  expect(patched.state.model.entries.map((entry) => entry.text)).toContain("hello")
  expect(patched.state.model.entries.map((entry) => entry.text)).not.toContain("hel")
  expect(removed.state.model.entries.map((entry) => entry.text)).not.toContain("hello")
  expect(HashMap.has(openProjectionStream(removed.state, active.id).units, updatedUnit.key)).toBe(false)
})

it("inserts a newly discovered projection unit at its stable order", () => {
  const active = runningTurn("projection-order")
  const later: Transcript.Unit = {
    key: `${active.id}:later`,
    turnId: active.id,
    order: Transcript.unitOrder(`${active.id}:later`, 2),
    revision: 2,
    content: { _tag: "Entry", role: "assistant", text: "later" },
  }
  const earlier: Transcript.Unit = {
    key: `${active.id}:earlier`,
    turnId: active.id,
    order: Transcript.unitOrder(`${active.id}:earlier`, 1),
    revision: 1,
    content: { _tag: "Entry", role: "assistant", text: "earlier" },
  }
  const projection = { ...Transcript.empty(active.id, active.prompt), units: [later] }
  const started = startProjection(populatedSelection(active).state, active, projection)
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [earlier], remove: [] },
  })
  const orderedText = (patched.state.model.items as ReadonlyArray<ViewState.TranscriptItem>)
    .filter((item) => item.id === earlier.key || item.id === later.key)
    .map((item) => (item._tag === "Entry" ? patched.state.model.entries[item.index]?.text : undefined))

  expect(patched.resync).toBeUndefined()
  expect(orderedText).toEqual(["earlier", "later"])
})

it("requests an authoritative resync for a projection stream or revision mismatch", () => {
  const active = runningTurn("projection-gap")
  const projection = Transcript.project(active.id, active.prompt, [])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const patch = {
    _tag: "TranscriptProjectionPatched" as const,
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery" as const, executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
  }

  expect(InteractiveController.update(started.state, { ...patch, streamId: "wrong-stream" }).resync).toBe(true)
  expect(InteractiveController.update(started.state, { ...patch, patchRevision: 2 }).resync).toBe(true)
  expect(started.state.projectionStreams?.get(active.id)?.patchRevision).toBe(0)
})

it("keeps the visible projection at a terminal boundary and rejects later patches", () => {
  const active = runningTurn("projection-terminal")
  const projection = Transcript.project(active.id, active.prompt, [projectionEvent(active, "final answer")])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const terminal = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
    rootStatus: "completed",
  })
  const settled = InteractiveController.update(terminal.state, {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: active.id,
    status: "completed",
  })
  const stopped = InteractiveController.update(settled.state, {
    _tag: "TranscriptProjectionStopped",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    patchRevision: 1,
    status: "completed",
  })
  const late = InteractiveController.update(stopped.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 1,
    patchRevision: 2,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
  })

  expect(stopped.state.model.entries.map((entry) => entry.text)).toContain("final answer")
  expect(stopped.state.model).toMatchObject({ busy: false, activeTurnId: undefined })
  expect(stopped.state.projectionStreams?.get(active.id)).toEqual({
    _tag: "Stopped",
    streamId: `stream:${active.id}`,
    patchRevision: 1,
    boundary: { _tag: "Stopped", status: "completed" },
  })
  expect(stopped.state.projectionStreams?.get(active.id)).not.toHaveProperty("units")
  expect(late.resync).toBe(true)
})

it("rejects a terminal boundary that contradicts the last projection patch", () => {
  const active = runningTurn("projection-terminal-mismatch")
  const projection = Transcript.project(active.id, active.prompt, [projectionEvent(active, "final answer")])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [] },
    rootStatus: "failed",
  })
  const stopped = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionStopped",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    patchRevision: 1,
    status: "completed",
  })

  expect(stopped.resync).toBe(true)
  expect(stopped.state).toBe(patched.state)
})

it("settles a recorded shell projection without treating it as an agent execution", () => {
  const running: Turn.RunningRecordedShellTurn = {
    _tag: "RecordedShell",
    id: Turn.TurnId.make("recorded-shell"),
    threadId: thread.id,
    prompt: "$ printf done",
    command: "printf done",
    status: "running",
    stopIntent: "none",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: 2,
    updatedAt: 2,
  }
  const initial = Transcript.recordedShellProjection({ id: running.id, command: running.command, status: "running" })
  const started = startProjection(populatedSelection(running).state, running, initial)
  const terminal: Turn.TerminalRecordedShellTurn = {
    ...running,
    status: "completed",
    result: { text: "done", truncated: false, exitCode: 0 },
    updatedAt: 3,
  }
  const settled = Transcript.settleRecordedShellProjection(initial, terminal)
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: terminal.id,
    turn: terminal,
    streamId: `stream:${terminal.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "RecordedShell", phase: "settled" },
    state: visibleState(settled),
    delta: unitDelta(initial, settled),
    rootStatus: "completed",
  })
  const stopped = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionStopped",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: terminal.id,
    streamId: `stream:${terminal.id}`,
    patchRevision: 1,
    status: "completed",
  })

  expect(patched.resync).toBeUndefined()
  expect(patched.state.replayTurns.get(terminal.id)).toEqual(terminal)
  expect(stopped.resync).toBeUndefined()
  expect(stopped.state.projectionStreams?.get(terminal.id)).toMatchObject({
    _tag: "Stopped",
    boundary: { _tag: "Stopped", status: "completed" },
  })
  expect(stopped.state.model.blocks).toContainEqual(
    expect.objectContaining({
      _tag: "ToolCall",
      id: `${terminal.id}:recorded-shell`,
      status: "complete",
      output: "done",
    }),
  )
})

it("retains the typed projection failure boundary and requests resync", () => {
  const active = runningTurn("projection-failure")
  const projection = Transcript.project(active.id, active.prompt, [])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const failed = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionFailed",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    patchRevision: 0,
    executionId: `execution:${active.id}`,
    reason: "BackendReadFailed",
    message: "backend unavailable",
  })

  expect(failed.resync).toBe(true)
  expect(failed.state.projectionStreams?.get(active.id)).toMatchObject({
    _tag: "Failed",
    boundary: {
      _tag: "Failed",
      executionId: `execution:${active.id}`,
      reason: "BackendReadFailed",
      message: "backend unavailable",
    },
  })
})

it("renders transient projection deltas without advancing the durable fold revision", () => {
  const active = runningTurn("projection-transient")
  const projection = Transcript.project(active.id, active.prompt, [])
  const started = startProjection(populatedSelection(active).state, active, projection)
  const transientProjection = Transcript.project(active.id, active.prompt, [projectionEvent(active, "stream", true)])
  const transientUnit = transientProjection.units.find(
    (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant",
  )!
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: {
      _tag: "Event",
      executionId: `execution:${active.id}`,
      cursor: "transient",
      sequence: 1,
      type: "model.output.delta",
      createdAt: 3,
      transient: true,
      text: "stream",
    },
    state: visibleState(projection),
    delta: { upsert: [transientUnit], remove: [] },
  })

  expect(patched.state.model.entries.map((entry) => entry.text)).toContain("stream")
  expect(patched.state.projectionStreams?.get(active.id)).toMatchObject({
    patchRevision: 1,
    state: visibleState(projection),
  })
})

it("does not traverse unchanged projection units for a one-unit delta", () => {
  const active = runningTurn("projection-complexity")
  const template = Transcript.project(active.id, active.prompt, []).units[0]!
  let unchangedReads = 0
  const units = Array.from(
    { length: 2_000 },
    (_, index) =>
      new Proxy(
        {
          ...template,
          key: `${active.id}:unit:${index}`,
          order: Transcript.unitOrder(active.id, index),
          content: { _tag: "Entry" as const, role: "assistant" as const, text: `line ${index}` },
        },
        {
          get(target, property, receiver) {
            if (index !== 1_000 && (property === "key" || property === "content" || property === "order"))
              unchangedReads += 1
            return Reflect.get(target, property, receiver)
          },
        },
      ),
  )
  const projection = { ...Transcript.project(active.id, active.prompt, []), units }
  const started = startProjection(populatedSelection(active).state, active, projection)
  const replacement = {
    ...units[1_000]!,
    content: { _tag: "Entry" as const, role: "assistant" as const, text: "changed" },
  }
  unchangedReads = 0
  const patched = InteractiveController.update(started.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 0,
    patchRevision: 1,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [replacement], remove: [] },
  })

  expect(patched.resync).toBeUndefined()
  expect(unchangedReads).toBe(0)
  expect(HashMap.size(openProjectionStream(patched.state, active.id).units)).toBe(2_000)
  unchangedReads = 0
  const removed = InteractiveController.update(patched.state, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: active.id,
    streamId: `stream:${active.id}`,
    baseRevision: 1,
    patchRevision: 2,
    origin: { _tag: "Discovery", executionId: `execution:${active.id}` },
    state: visibleState(projection),
    delta: { upsert: [], remove: [replacement.key] },
  })
  expect(removed.resync).toBeUndefined()
  expect(unchangedReads).toBe(0)
  expect(HashMap.size(openProjectionStream(removed.state, active.id).units)).toBe(1_999)
})

it("keeps a populated view when a reload delivers a window that renders nothing", () => {
  const active = runningTurn("active")
  const populated = populatedSelection(active)
  const reloaded = InteractiveController.update(populated.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: orphanEntries(active, 5),
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn: active,
  })

  expect(populated.state.model.entries.map((value) => value.text)).toContain("history answer")
  expect(reloaded.discarded).toBe(true)
  expect(reloaded.state.model.entries.map((value) => value.text)).toContain("history answer")
  expect(reloaded.state.selectionEpoch).toBe(2)
})

it("repaints live patches for the in-flight turn after a reload that renders nothing", () => {
  const active = runningTurn("active")
  const populated = populatedSelection(active)
  const reloaded = InteractiveController.update(populated.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: orphanEntries(active, 5),
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn: active,
  })
  const feed = makeProjectionFeed(reloaded.state, active, Transcript.empty(active.id, active.prompt))
  const patched = feed.apply({
    cursor: "answer",
    sequence: 9,
    type: "model.output.completed",
    createdAt: 9,
    text: "live answer",
  })

  const texts = patched.state.model.entries.map((value) => value.text)
  expect(texts).toContain("history answer")
  expect(texts).toContain("live answer")
})

it("seeds the in-flight turn so an empty reload still paints and keeps taking live patches", () => {
  const active = runningTurn("active")
  const reloaded = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [],
    hasOlder: true,
    threadCostUsd: 0,
    activeTurn: active,
  })
  const feed = makeProjectionFeed(reloaded.state, active, Transcript.empty(active.id, active.prompt))
  const patched = feed.apply({
    cursor: "answer",
    sequence: 9,
    type: "model.output.completed",
    createdAt: 9,
    text: "live answer",
  })

  expect(reloaded.discarded).toBeUndefined()
  expect(reloaded.state.model.entries.map((value) => value.text)).toEqual(["active prompt"])
  expect(patched.state.model.entries.map((value) => value.text)).toEqual(["active prompt", "live answer"])
})

it("keeps live child patches rendering after a mid-turn selection reload", () => {
  const parentEvents: ReadonlyArray<Transcript.SourceEvent> = [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review" } },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 5,
      data: { tool_call_id: "agent", child_execution_id: "execution:parent:child:agent" },
    },
  ]
  const running = entries("parent", 2, parentEvents).map(asRunningEntry)
  const turn = running[0]!.turn
  const childId = "parent:child:agent"
  const childReadEvent: Transcript.SourceEvent = {
    cursor: "child-read",
    sequence: 0,
    type: "tool.call.requested",
    createdAt: 6,
    data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
  }
  const parent = Transcript.project(turn.id, turn.prompt, parentEvents)
  let childProjection = Transcript.applyEvent(Transcript.empty(childId, ""), childReadEvent)
  const nested = () =>
    Transcript.withNestedProjections(parent, [{ parentId: `${turn.id}:agent`, projection: childProjection }])
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: running,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const firstFeed = makeProjectionFeed(selected.state, turn, nested())
  const reloaded = InteractiveController.update(firstFeed.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: running,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  })
  const secondFeed = makeProjectionFeed(reloaded.state, turn, nested())
  const childWriteEvent: Transcript.SourceEvent = {
    cursor: "child-write",
    sequence: 1,
    type: "tool.call.requested",
    createdAt: 7,
    data: { tool_call_id: "write", tool_name: "write", input: { path: "src/b.ts" } },
  }
  childProjection = Transcript.applyEvent(childProjection, childWriteEvent)
  const resumed = secondFeed.apply(childWriteEvent, {
    executionId: `execution:${childId}`,
    projection: nested(),
  })

  expect(firstFeed.state.model.blocks).toContainEqual(
    expect.objectContaining({ id: Transcript.scopedIdentity(childId, "read") }),
  )
  expect(secondFeed.state.model.blocks).toContainEqual(expect.objectContaining({ id: "parent:agent" }))
  expect(secondFeed.state.model.items.length).toBeGreaterThan(0)
  expect(resumed.state.model.blocks).toContainEqual(
    expect.objectContaining({ id: Transcript.scopedIdentity(childId, "write") }),
  )
})

it("keeps one of five status labels from submit until the turn completes", () => {
  const turn = { ...entries("active", 2)[0]!.turn, status: "running" as const }
  const submitted = ViewState.update(
    { ...ViewState.initial("/work", "medium"), input: "run it", cursor: 6 },
    { _tag: "Submitted" },
  )
  let state: InteractiveController.State = {
    ...initialState(),
    selectionEpoch: 1,
    model: { ...submitted, currentThreadId: thread.id, activeTurnId: turn.id },
    replayTurns: new Map([[turn.id, turn]]),
    entries: entries(turn.id, turn.createdAt),
  }
  const feed = makeProjectionFeed(state, turn, Transcript.empty(turn.id, turn.prompt))
  state = feed.state
  const labels = ["Sending", "Waiting", "Thinking 2 tok", "Streaming 2 tok", "Running 1 tool", "Running 2 tools"]
  const expectStatus = (expected: string) => {
    const label = ViewState.formatActivity(state.model.activity)
    expect(label).toBe(expected)
    expect(labels).toContain(label)
  }
  const patch = (sequence: number, type: string, text?: string, data?: Readonly<Record<string, unknown>>) => {
    state = feed.apply({
      cursor: `event-${sequence}`,
      sequence,
      type,
      createdAt: sequence,
      ...(text === undefined ? {} : { text }),
      ...(data === undefined ? {} : { data }),
    }).state
  }

  expectStatus("Sending")
  patch(0, "execution.accepted")
  expectStatus("Waiting")
  patch(1, "execution.started")
  expectStatus("Waiting")
  patch(2, "model.input.prepared")
  expectStatus("Waiting")
  patch(3, "model.reasoning.delta", "12345678")
  expectStatus("Thinking 2 tok")
  patch(4, "tool.call.requested", undefined, {
    tool_call_id: "read",
    tool_name: "read",
    input: { path: "src/a.ts" },
  })
  expectStatus("Running 1 tool")
  patch(5, "tool.call.requested", undefined, {
    tool_call_id: "status",
    tool_name: "bash",
    input: { command: "git --no-optional-locks status --short --branch" },
  })
  expectStatus("Running 2 tools")
  patch(6, "tool.result.received", undefined, { tool_call_id: "read", output: "contents" })
  expectStatus("Running 1 tool")
  patch(7, "tool.result.received", undefined, { tool_call_id: "status", output: "clean" })
  expectStatus("Waiting")
  patch(8, "model.output.delta", "abcdefgh")
  expectStatus("Streaming 2 tok")
  patch(9, "model.output.completed", "abcdefgh")
  expectStatus("Waiting")
  patch(10, "execution.completed")
  expectStatus("Waiting")
  expect(state.model.busy).toBe(true)
  state = InteractiveController.update(state, {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: turn.id,
    status: "completed",
  }).state
  expect(ViewState.formatActivity(state.model.activity)).toBeUndefined()
  expect(state.model.busy).toBe(false)
})

it("keeps 200ms tool lifecycle events in distinct TUI frames", () => {
  type ProjectionPatchedEvent = Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>
  type ProjectionPatched = ProjectionPatchedEvent & {
    readonly origin: Extract<ProjectionPatchedEvent["origin"], { readonly _tag: "Event" }>
  }
  const turn = { ...entries("timed", 2)[0]!.turn, status: "running" as const }
  let state: InteractiveController.State = {
    ...initialState(),
    selectionEpoch: 1,
    model: {
      ...initialState().model,
      currentThreadId: thread.id,
      activeTurnId: turn.id,
      busy: true,
      activity: { _tag: "Waiting" },
    },
    replayTurns: new Map([[turn.id, turn]]),
    entries: entries(turn.id, turn.createdAt),
  }
  state = startProjection(state, turn, Transcript.empty(turn.id, turn.prompt)).state
  let now = 0
  const scheduled: Array<{ readonly at: number; readonly flush: () => void }> = []
  const applied: Array<{ readonly at: number; readonly type: string; readonly activity: string | undefined }> = []
  const batcher = InteractiveController.makeFeedFrameBatcher<ProjectionPatched>({
    schedule: (flush) => scheduled.push({ at: now + 16, flush }),
    apply: (events) => {
      for (const event of events) {
        state = InteractiveController.update(state, event).state
        applied.push({ at: now, type: event.origin.type, activity: ViewState.formatActivity(state.model.activity) })
      }
    },
    render: () => {},
  })
  const advance = (target: number) => {
    while (scheduled[0] !== undefined && scheduled[0].at <= target) {
      const next = scheduled.shift()!
      now = next.at
      next.flush()
    }
    now = target
  }
  let projection = Transcript.empty(turn.id, turn.prompt)
  let patchRevision = 0
  const event = (
    sequence: number,
    type: "tool.call.requested" | "tool.result.received",
    callId: string,
  ): ProjectionPatched => {
    const source: Transcript.SourceEvent = {
      cursor: `timed-${sequence}`,
      sequence,
      type,
      createdAt: now,
      data:
        type === "tool.call.requested"
          ? { tool_call_id: callId, tool_name: "read", input: { path: `${callId}.ts` } }
          : { tool_call_id: callId, output: callId },
    }
    const next = Transcript.applyEvent(projection, source)
    const baseRevision = patchRevision
    patchRevision += 1
    const patched: ProjectionPatched = {
      _tag: "TranscriptProjectionPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      rootTurnId: turn.id,
      streamId: `stream:${turn.id}`,
      baseRevision,
      patchRevision,
      origin: projectionOrigin(source, `execution:${turn.id}`),
      state: visibleState(next),
      delta: unitDelta(projection, next),
    }
    projection = next
    return patched
  }

  batcher.offer(event(0, "tool.call.requested", "first"))
  batcher.offer(event(1, "tool.call.requested", "second"))
  advance(200)
  batcher.offer(event(2, "tool.result.received", "first"))
  advance(400)
  batcher.offer(event(3, "tool.result.received", "second"))
  advance(500)

  expect(applied.map(({ at }) => at)).toEqual([16, 16, 216, 416])
  expect(applied.map(({ activity }) => activity)).toEqual([
    "Running 1 tool",
    "Running 2 tools",
    "Running 1 tool",
    "Waiting",
  ])
})

it("keeps the authoritative thread cost stable while older pages are prepended", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: true,
    threadCostUsd: 3.75,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 3.75,
  })

  expect(page.state.model.costUsd).toBe(3.75)
  expect(prepended.state.model.costUsd).toBe(3.75)
})

it("keeps known context through transient unavailable updates and ignores stale selections", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
  })
  const active = InteractiveController.update(page.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 1,
    context: { _tag: "Available", inputTokens: 208_294, contextWindow: 1_050_000, reserveTokens: 128_000 },
    cost: { _tag: "Unavailable" },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Available", accumulatedMillis: 5_000, activeSince: 10_000 },
  })
  const transient = InteractiveController.update(active.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 2,
    context: { _tag: "Unavailable" },
    cost: { _tag: "Unavailable" },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Available", accumulatedMillis: 6_000, activeSince: 10_000 },
  })
  const stale = InteractiveController.update(transient.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 0,
    threadId: thread.id,
    revision: 3,
    context: { _tag: "Unavailable" },
    cost: { _tag: "Unavailable" },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Available", accumulatedMillis: 99_000 },
  })

  expect(active.state.model.contextUsage).toEqual({
    _tag: "Available",
    inputTokens: 208_294,
    contextWindow: 1_050_000,
    reserveTokens: 128_000,
  })
  expect(transient.state.model.contextUsage).toBe(active.state.model.contextUsage)
  expect(active.state.model.usageTime).toEqual({
    _tag: "Available",
    accumulatedMillis: 5_000,
    activeSince: 10_000,
  })
  expect(stale.state.model.usageTime).toBe(transient.state.model.usageTime)
})

it("keeps the newest committed usage revision and drops older ones", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
  })
  const usage = (revision: number, usd: number, accumulatedMillis: number) =>
    ({
      _tag: "ThreadUsageUpdated",
      selectionEpoch: 1,
      threadId: thread.id,
      revision,
      context: { _tag: "Unavailable" },
      cost: { _tag: "Available", usd, unpricedAttempts: 0 },
      tokens: { _tag: "Unavailable" },
      time: { _tag: "Available", accumulatedMillis },
    }) as const
  const committed = InteractiveController.update(page.state, usage(7, 100.0014, 30_000))
  const late = InteractiveController.update(committed.state, usage(6, 150, 0))
  const newer = InteractiveController.update(late.state, usage(8, 100.5, 31_000))

  expect(committed.state.model.usageCost).toEqual({ _tag: "Available", usd: 100.0014, unpricedAttempts: 0 })
  expect(late.state.model.usageCost).toBe(committed.state.model.usageCost)
  expect(late.state.model.usageTime).toBe(committed.state.model.usageTime)
  expect(newer.state.model.usageCost).toEqual({ _tag: "Available", usd: 100.5, unpricedAttempts: 0 })
  expect(newer.state.model.usageTime).toEqual({ _tag: "Available", accumulatedMillis: 31_000 })
})

it("shows the session total and updates it when child usage arrives", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2, [
      {
        cursor: "parent-usage",
        sequence: 0,
        type: "model.usage.reported",
        createdAt: 2,
        data: { cost_usd: 0.5 },
      },
    ]),
    hasOlder: false,
    threadCostUsd: 0.5,
    globalCostUsd: 10,
  })
  const child = InteractiveController.update(page.state, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 1,
    context: { _tag: "Unavailable" },
    cost: { _tag: "Available", usd: 0.75, unpricedAttempts: 0 },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Unavailable" },
  })

  expect(page.state.model.costUsd).toBe(0.5)
  expect(child.state.model.costUsd).toBe(0.75)
  expect(child.state.threadCostUsd).toBe(0.75)
})

it("applies a usage aggregate without lowering the semantic projection revision", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2),
    hasOlder: false,
    threadCostUsd: 0.5,
  })
  const current = { ...page.state, revisions: new Map([["parent", 9]]) }
  const late = InteractiveController.update(current, {
    _tag: "ThreadUsageUpdated",
    selectionEpoch: 1,
    threadId: thread.id,
    revision: 1,
    context: { _tag: "Unavailable" },
    cost: { _tag: "Available", usd: 0.75, unpricedAttempts: 0 },
    tokens: { _tag: "Unavailable" },
    time: { _tag: "Unavailable" },
  })

  expect(late.state.model.costUsd).toBe(0.75)
  expect(late.state.threadCostUsd).toBe(0.75)
  expect(late.state.revisions.get("parent")).toBe(9)
})

it("clears working state when the semantic event stream reaches a terminal event", () => {
  const persisted = entries("new", 2)
  const activeTurn = { ...persisted[0]!.turn, status: "running" as const }
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persisted,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn,
  })
  const feed = makeProjectionFeed(page.state, activeTurn, Transcript.empty(activeTurn.id, activeTurn.prompt))
  const terminal = feed.apply({ cursor: "completed", sequence: 1, type: "execution.completed", createdAt: 3 })
  const completed = InteractiveController.update(terminal.state, {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: activeTurn.id,
    status: "completed",
  })

  expect(completed.state.model).toMatchObject({ busy: false, activity: undefined, activeTurnId: undefined })
})

it("keeps the newest logical selection when delayed A to B to A work arrives", () => {
  const threadB = { ...thread, id: Thread.ThreadId.make("thread-b"), title: "Thread B" }
  const load = (
    state: InteractiveController.State,
    selected: Thread.Thread,
    selectionEpoch: number,
    values: ReturnType<typeof entries>,
  ) =>
    InteractiveController.update(state, {
      _tag: "SelectionLoaded",
      selectionEpoch,
      activitySequence: selectionEpoch,
      thread: selected,
      entries: values,
      hasOlder: false,
      threadCostUsd: 0,
      queueRevision: selectionEpoch,
      queue: [],
    })
  const a1 = load(initialState(), thread, 1, entries("a-1", 1))
  const b2 = load(a1.state, threadB, 2, [])
  const a3 = load(b2.state, thread, 3, entries("a-3", 3))
  const delayedA1 = load(a3.state, thread, 1, entries("stale-a", 4))
  const staleTurn = entries("a-1", 1)[0]!.turn
  const staleProjection = Transcript.project(staleTurn.id, staleTurn.prompt, [
    {
      cursor: "stale",
      sequence: 9,
      type: "model.output.completed",
      createdAt: 9,
      text: "stale",
    },
  ])
  const delayedPatch = InteractiveController.update(delayedA1.state, {
    _tag: "TranscriptProjectionStarted",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: staleTurn.id,
    turn: staleTurn,
    streamId: "stream:a-1",
    patchRevision: 0,
    state: visibleState(staleProjection),
    units: staleProjection.units,
  })

  expect(delayedA1.state).toBe(a3.state)
  expect(delayedPatch.state).toBe(a3.state)
  expect(delayedPatch.state.selectionEpoch).toBe(3)
  expect(delayedPatch.state.model).toMatchObject({ currentThreadId: "thread-a", currentThreadTitle: "Thread A" })
  expect(delayedPatch.state.model.entries.map((entry) => entry.text)).toEqual(["a-3"])
})

it("requests a queue resync when the durable count disagrees with an otherwise contiguous delta", () => {
  const model = {
    ...initialState().model,
    currentThreadId: "thread-a",
    queueThreadId: "thread-a",
    queueRevision: 1,
  }
  const updated = InteractiveController.updateQueue(model, {
    _tag: "QueueUpdated",
    selectionEpoch: 1,
    threadId: Thread.ThreadId.make("thread-a"),
    revision: 2,
    queuedCount: 2,
    change: { _tag: "Added", item: { id: Turn.TurnId.make("queued"), prompt: "queued" } },
  })

  expect(updated.model.queue).toEqual([{ id: "queued", prompt: "queued" }])
  expect(updated.resync).toBe(true)
})

it("restores the rejected composer and reports the pending count when the queue is full", () => {
  const submitted = ViewState.update(
    ViewState.update(initialState().model, { _tag: "ComposerReplaced", text: "retry this prompt" }),
    { _tag: "Submitted" },
  )
  const updated = InteractiveController.updateQueue(submitted, {
    _tag: "QueueFull",
    selectionEpoch: 0,
    threadId: Thread.ThreadId.make("thread-a"),
    capacity: 2,
    count: 2,
  })

  expect(updated.model.input).toBe("retry this prompt")
  expect(updated.model.blocks.at(-1)).toMatchObject({
    _tag: "Error",
    detail: "Queue full: 2 pending prompts",
  })
})

it("removes a promoted turn and exits queue edit mode synchronously", () => {
  const queued = ViewState.resetQueue(
    {
      ...initialState().model,
      currentThreadId: "thread-a",
      editingTurnId: "promoted",
      editReturn: { input: "keep this draft", attachments: [] },
      input: "edited queued prompt",
      cursor: 20,
    },
    "thread-a",
    4,
    [{ id: "promoted", prompt: "edited queued prompt" }],
  )

  const promoted = InteractiveController.removePromotedTurn(queued, "thread-a", "promoted")

  expect(promoted.queue).toEqual([])
  expect(promoted.queueRevision).toBe(5)
  expect(promoted.editingTurnId).toBeUndefined()
  expect(promoted.input).toBe("keep this draft")
})

it("eagerly consumes more than one frame of events while bounding reducer work per render frame", () => {
  type ProjectionPatched = Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>
  const scheduled: Array<() => void> = []
  let received = 0
  let applied = 0
  let renders = 0
  const persisted = entries("stream", 2)
  const turn = { ...persisted[0]!.turn, status: "running" as const }
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persisted,
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: turn,
  }).state
  let projection = Transcript.empty(turn.id, turn.prompt)
  state = startProjection(state, turn, projection).state
  const events: ReadonlyArray<ProjectionPatched> = Array.from({ length: 257 }, (_, index) => {
    const source: Transcript.SourceEvent = {
      cursor: `chunk-${index}`,
      sequence: index,
      type: "model.output.delta",
      createdAt: index,
      text: index === 256 ? "FINAL-CHUNK" : "x",
    }
    const next = Transcript.applyEvent(projection, source)
    const event: ProjectionPatched = {
      _tag: "TranscriptProjectionPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      rootTurnId: turn.id,
      streamId: `stream:${turn.id}`,
      baseRevision: index,
      patchRevision: index + 1,
      origin: projectionOrigin(source, `execution:${turn.id}`),
      state: visibleState(next),
      delta: unitDelta(projection, next),
    }
    projection = next
    return event
  })
  const batcher = InteractiveController.makeFeedFrameBatcher<ProjectionPatched>({
    schedule: (flush) => scheduled.push(flush),
    apply: (batch) => {
      for (const event of batch) {
        state = InteractiveController.update(state, event).state
        applied += 1
      }
    },
    render: () => {
      renders += 1
    },
  })
  const consume = (dispatch: (event: ProjectionPatched) => void) => {
    for (const event of events) {
      received += 1
      dispatch(event)
    }
  }

  consume(batcher.offer)

  expect(received).toBe(257)
  expect(applied).toBe(0)
  expect(scheduled).toHaveLength(1)
  scheduled.shift()?.()
  expect(applied).toBe(256)
  expect(scheduled).toHaveLength(1)
  while (scheduled.length > 0) scheduled.shift()?.()
  expect(applied).toBe(257)
  expect(renders).toBe(2)
  expect(state.model.entries.some((entry) => entry.text.includes("FINAL-CHUNK"))).toBe(true)

  batcher.offer(events[0]!)
  expect(scheduled).toHaveLength(1)
})

it("preserves feed order across lanes and batch boundaries", () => {
  type FeedEvent = {
    readonly id: string
    readonly lane: "root" | "child"
  }
  const scheduled: Array<() => void> = []
  const applied: Array<string> = []
  const batcher = InteractiveController.makeFeedFrameBatcher<FeedEvent>({
    schedule: (flush) => scheduled.push(flush),
    apply: (events) => applied.push(...events.map((event) => event.id)),
    render: () => undefined,
  })
  for (let index = 0; index < 300; index += 1) batcher.offer({ id: `child-${index}`, lane: "child" })
  batcher.offer({ id: "root-progress", lane: "root" })
  batcher.offer({ id: "root-result", lane: "root" })

  scheduled.shift()?.()

  expect(applied).toHaveLength(256)
  expect(applied).toEqual(Array.from({ length: 256 }, (_, index) => `child-${index}`))
  while (scheduled.length > 0) scheduled.shift()?.()
  expect(applied).toEqual([
    ...Array.from({ length: 300 }, (_, index) => `child-${index}`),
    "root-progress",
    "root-result",
  ])
})

it("keeps bidirectional transcript navigation within the semantic window budget", () => {
  const pageEntries = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => entries(`window-${from + index}`, from + index)[0]!)
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries(200, 200),
    hasOlder: true,
  }).state
  for (let page = 0; page < 6; page++)
    state = InteractiveController.update(state, {
      _tag: "TranscriptPagePrepended",
      selectionEpoch: 1,
      threadId: thread.id,
      entries: pageEntries(150 - page * 50, 50),
      hasOlder: page < 5,
    }).state

  expect(state.entries.length).toBeLessThanOrEqual(InteractiveController.transcriptWindowEntryBudget)
  expect(new Set(state.entries.map((entry) => entry.unit.key)).size).toBe(state.entries.length)
  expect(state.entries[0]!.turn.createdAt).toBeLessThan(200)
  expect(state.hasNewer).toBe(true)

  for (let page = 0; page < 6; page++)
    state = InteractiveController.update(state, {
      _tag: "TranscriptPageAppended",
      selectionEpoch: 1,
      threadId: thread.id,
      entries: pageEntries(200 + page * 50, 50),
      hasNewer: page < 5,
      requestedAfter: cursor(state.entries.at(-1)!),
    }).state

  expect(state.entries.length).toBeLessThanOrEqual(InteractiveController.transcriptWindowEntryBudget)
  expect(new Set(state.entries.map((entry) => entry.unit.key)).size).toBe(state.entries.length)
  expect(state.entries.map((entry) => entry.turn.createdAt)).toEqual(
    state.entries.map((entry) => entry.turn.createdAt).toSorted((left, right) => left - right),
  )
  expect(state.entries.at(-1)!.turn.createdAt).toBeGreaterThanOrEqual(450)
  expect(state.hasNewer).toBe(false)
  expect(state.hasOlder).toBe(true)
  const stale = InteractiveController.update(state, {
    _tag: "TranscriptPageAppended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: pageEntries(900, 10),
    hasNewer: false,
    requestedAfter: cursor(state.entries[0]!),
  })
  expect(stale.state).toBe(state)
})

it("keeps the active projection outside the bounded contiguous history window", () => {
  const active = runningTurn("active-window")
  const pageEntries = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => entries(`active-history-${from + index}`, from + index)[0]!)
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: pageEntries(200, 200),
    hasOlder: true,
    activeTurn: active,
  }).state
  for (let page = 0; page < 6; page += 1)
    state = InteractiveController.update(state, {
      _tag: "TranscriptPagePrepended",
      selectionEpoch: 1,
      threadId: thread.id,
      entries: pageEntries(150 - page * 50, 50),
      hasOlder: page < 5,
    }).state

  expect(state.entries).toHaveLength(InteractiveController.transcriptWindowEntryBudget)
  expect(state.entries.some((entry) => entry.turn.id === active.id)).toBe(false)
  expect(state.model.entries.map((entry) => entry.text)).toContain(active.prompt)
  expect(state.newestCursor?.turnId).not.toBe(active.id)
})

it("settles an active turn before its projection stream closes", () => {
  const turn = runningTurn("settled-before-stop")
  const selected = populatedSelection(turn).state
  const opened = startProjection(selected, turn, Transcript.empty(String(turn.id), turn.prompt)).state
  const settled = InteractiveController.update(opened, {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: turn.id,
    status: "completed",
  })

  expect(settled.state.model.busy).toBe(false)
  expect(settled.state.model.activity).toBeUndefined()
  expect(settled.state.model.activeTurnId).toBeUndefined()
  expect(openProjectionStream(settled.state, String(turn.id))._tag).toBe("Open")
})

it("does not restore activity from late projection patches after settlement", () => {
  const turn = runningTurn("settled-late-patch")
  const selected = populatedSelection(turn).state
  const opened = startProjection(selected, turn, Transcript.empty(String(turn.id), turn.prompt)).state
  const settled = InteractiveController.update(opened, {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: turn.id,
    status: "completed",
  }).state
  const stream = openProjectionStream(settled, String(turn.id))
  const projection = Transcript.applyEvent(
    Transcript.empty(String(turn.id), turn.prompt),
    projectionEvent(turn, "late child output"),
  )
  const patched = InteractiveController.update(settled, {
    _tag: "TranscriptProjectionPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    rootTurnId: turn.id,
    streamId: stream.streamId,
    baseRevision: stream.patchRevision,
    patchRevision: stream.patchRevision + 1,
    origin: projectionOrigin(projectionEvent(turn, "late child output"), `execution:${turn.id}`),
    state: visibleState(projection),
    delta: unitDelta(Transcript.empty(String(turn.id), turn.prompt), projection),
  })

  expect(patched.state.model.busy).toBe(false)
  expect(patched.state.model.activity).toBeUndefined()
})

it("rejects stale selection lifecycle snapshots after settlement while applying their transcript", () => {
  const turn = runningTurn("stale-selection")
  const selected = populatedSelection(turn).state
  const settled = InteractiveController.update(selected, {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 2,
    threadId: thread.id,
    turnId: turn.id,
    status: "completed",
  }).state
  const reloaded = InteractiveController.update(settled, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 1,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("stale-selection-history", 3),
    hasOlder: false,
    activeTurn: turn,
  })

  expect(reloaded.state.entries.map((entry) => String(entry.turn.id))).toContain("stale-selection-history")
  expect(reloaded.state.model.busy).toBe(false)
  expect(reloaded.state.model.activity).toBeUndefined()
  expect(reloaded.state.model.activeTurnId).toBeUndefined()
})

it("applies failed settlement terminal semantics before a legacy failure event", () => {
  const turn = runningTurn("settled-failed")
  const selected = populatedSelection(turn).state
  const settled = InteractiveController.update(selected, {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: turn.id,
    status: "failed",
  }).state
  const legacy = ViewState.update(settled.model, {
    _tag: "ExecutionFailed",
    turnId: String(turn.id),
    message: "later failure",
  })

  expect(settled.model).toMatchObject({ busy: false, activeTurnId: undefined, cancelPending: false })
  expect(settled.model.blocks).toContainEqual(expect.objectContaining({ _tag: "Error", title: "Message failed" }))
  expect(legacy.blocks).toEqual(settled.model.blocks)
})

it("applies cancelled settlement terminal semantics and remains idempotent", () => {
  const turn = runningTurn("settled-cancelled")
  const selected = populatedSelection(turn).state
  const cancelling = { ...selected, model: { ...selected.model, cancelPending: true } }
  const event: Extract<Operation.InteractiveEvent, { readonly _tag: "TurnSettled" }> = {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: turn.id,
    status: "cancelled",
  }
  const settled = InteractiveController.update(cancelling, event).state
  const duplicate = InteractiveController.update(settled, event).state

  expect(settled.model).toMatchObject({ busy: false, activeTurnId: undefined, cancelPending: false })
  expect(duplicate.model).toEqual(settled.model)
})

const cancellableSettlementState = (turn: Turn.AgentExecutionTurn): InteractiveController.State => {
  let model = ViewState.initial("/work", "medium")
  model = ViewState.update(model, { _tag: "Submitted" })
  model = ViewState.update(model, { _tag: "SubmissionAdmitted", turnId: String(turn.id) })
  model = ViewState.update(model, { _tag: "TurnStarted", turnId: String(turn.id), prompt: turn.prompt })
  return {
    ...initialState(),
    selectionEpoch: 1,
    model: { ...model, currentThreadId: String(thread.id) },
    replayTurns: new Map([[String(turn.id), turn]]),
  }
}

it("converges cancelled settlement and legacy cancellation in either delivery order", () => {
  const turn = runningTurn("cancel-order-false")
  const event: Extract<Operation.InteractiveEvent, { readonly _tag: "TurnSettled" }> = {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: turn.id,
    status: "cancelled",
    agentResponseArrived: false,
  }
  const settlementFirst = ViewState.update(
    InteractiveController.update(cancellableSettlementState(turn), event).state.model,
    {
      _tag: "ExecutionCancelled",
      turnId: String(turn.id),
      agentResponseArrived: false,
    },
  )
  const legacyFirstState = cancellableSettlementState(turn)
  const legacyFirst = InteractiveController.update(
    {
      ...legacyFirstState,
      model: ViewState.update(legacyFirstState.model, {
        _tag: "ExecutionCancelled",
        turnId: String(turn.id),
        agentResponseArrived: false,
      }),
    },
    event,
  ).state.model

  expect(settlementFirst).toEqual(legacyFirst)
})

it("converges cancelled settlement with agent response already arrived", () => {
  const turn = runningTurn("cancel-order-true")
  const event: Extract<Operation.InteractiveEvent, { readonly _tag: "TurnSettled" }> = {
    _tag: "TurnSettled",
    selectionEpoch: 1,
    activitySequence: 1,
    threadId: thread.id,
    turnId: turn.id,
    status: "cancelled",
    agentResponseArrived: true,
  }
  const settlementFirst = ViewState.update(
    InteractiveController.update(cancellableSettlementState(turn), event).state.model,
    {
      _tag: "ExecutionCancelled",
      turnId: String(turn.id),
      agentResponseArrived: true,
    },
  )
  const legacyFirstState = cancellableSettlementState(turn)
  const legacyFirst = InteractiveController.update(
    {
      ...legacyFirstState,
      model: ViewState.update(legacyFirstState.model, {
        _tag: "ExecutionCancelled",
        turnId: String(turn.id),
        agentResponseArrived: true,
      }),
    },
    event,
  ).state.model

  expect(settlementFirst).toEqual(legacyFirst)
  expect(settlementFirst.input).toBe("")
})
