import * as InteractiveController from "../src/interactive-controller"
import type * as Operation from "@rika/app/operation"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ExecutionEvents, Keys, Palette, ViewState } from "@rika/tui"
import { renderTranscriptStyled } from "@rika/tui/adapter"
import { expect, it } from "vitest"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-a"),
  workspace: "/work",
  title: "Thread A",
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
    id: Turn.TurnId.make(id),
    threadId: thread.id,
    prompt: id,
    executionRoute: Turn.testExecutionRoute(),
    status: "completed" as const,
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

const initialState = (): InteractiveController.State => ({
  model: ViewState.initial("/work", "medium"),
  replayTurns: new Map(),
  entries: [],
  revisions: new Map(),
  projections: new Map(),
  threadCostUsd: 0,
  selectionEpoch: 0,
})

const key = (input: Partial<Keys.Key> & Pick<Keys.Key, "name">): Keys.Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

it("projects prepended pages without rebuilding the loaded transcript", () => {
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
  const loadedAnswer = page.state.model.entries.at(-1)
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
  expect(prepended.state.model.entries.some((value) => value === loadedAnswer)).toBe(true)
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
  expect(reset.projections.size).toBe(0)
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

it("rejects duplicate patches and stale units with the same semantic identity", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2, [
      { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const liveEvent = {
    cursor: "live-2",
    sequence: 2,
    type: "model.output.completed",
    createdAt: 2,
    text: "live answer",
  }
  const patched = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const duplicate = InteractiveController.update(patched.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const stale = InteractiveController.update(duplicate.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2, [
      { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const staleOlderEntry = entries("new", 2, [
    { cursor: "older-0", sequence: 0, type: "model.output.completed", createdAt: 0, text: "older answer" },
  ]).find((entry) => entry.unit.content._tag === "Entry" && entry.unit.content.role === "assistant")
  expect(staleOlderEntry).toBeDefined()
  if (staleOlderEntry === undefined) return
  const prepended = InteractiveController.update(duplicate.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [staleOlderEntry],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(patched.state.model.entries.at(-1)?.text).toBe("live answer")
  expect(duplicate.state).toBe(patched.state)
  expect(stale.state).toBe(patched.state)
  expect(prepended.state.model.entries.map((entry) => entry.text)).not.toContain("older answer")
  expect(prepended.state.revisions.get("new")).toBe(2)
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
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const patched = InteractiveController.update(prepended.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: {
      cursor: "cursor-1",
      sequence: 1,
      type: "model.output.completed",
      createdAt: 3,
      text: "answer",
    },
    revision: 2,
  })
  expect(page.state.entries.map((value) => value.turn.id)).toEqual([Turn.TurnId.make("new")])
  expect(prepended.state.entries.map((value) => value.turn.id)).toEqual([
    Turn.TurnId.make("old"),
    Turn.TurnId.make("new"),
  ])
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
    "assistant:old:0",
    "turn:new:user",
    "assistant:new:0",
  ])
  expect(prepended.state.entries).toEqual(selected.state.entries)
  expect(prepended.state.model.entries.map((entry) => entry.text)).toEqual(["old", "old answer", "new", "new answer"])
})

it("projects replayed child execution tools beneath the matching subagent", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const requested = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
    },
    revision: 0,
  })
  const spawned = InteractiveController.update(requested.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 4,
      data: {
        tool_call_id: "agent",
        child_execution_id: "execution:parent:child:agent",
      },
    },
    revision: 1,
  })
  const child = InteractiveController.update(spawned.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 5,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
    },
    revision: 0,
  })
  const response = InteractiveController.update(child.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-response",
      sequence: 1,
      type: "model.output.completed",
      createdAt: 6,
      text: "## Review complete\n\n**No defects found.**",
    },
    revision: 1,
  })

  expect(child.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "parent:agent", childId: "execution:parent:child:agent" }),
    expect.objectContaining({ _tag: "ToolCall", id: "parent:child:agent:read" }),
  ])
  expect(child.state.model.items[2]).toMatchObject({
    id: "tool:parent:child:agent:read",
    parentId: "parent:agent",
  })
  expect(child.state.revisions.get("parent:child:agent")).toBe(0)
  expect(response.state.model.entries).toContainEqual(
    expect.objectContaining({ role: "assistant", text: "## Review complete\n\n**No defects found.**" }),
  )
  expect(response.state.model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: "assistant:parent:child:agent:0",
      parentId: "parent:agent",
    }),
  )
  expect(response.state.revisions.get("parent:child:agent")).toBe(1)
})

it("attaches parallel child streams when task rows lack explicit spawn links", () => {
  const turnId = "parallel"
  const childIds = ["one", "two", "three", "four"].map(
    (callId) => `child:execution%3A${turnId}:rika:execution%3A${turnId}:${callId}`,
  )
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries(turnId, 2),
    hasOlder: false,
    threadCostUsd: 0,
  }).state

  for (const [sequence, callId] of ["one", "two", "three", "four"].entries())
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make(turnId),
      event: {
        cursor: `task-${callId}`,
        sequence,
        type: "tool.call.requested",
        createdAt: 3,
        data: { tool_call_id: callId, tool_name: "task", input: { prompt: `Explore ${callId}` } },
      },
      revision: sequence,
    }).state

  for (const [index, childId] of childIds.entries()) {
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make(childId),
      event: {
        cursor: `child-tool-${index}`,
        sequence: 0,
        type: "tool.call.requested",
        createdAt: 4,
        data: { tool_call_id: "read", tool_name: "read", input: { path: `src/${index}.ts` } },
      },
      revision: 0,
    }).state
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make(childId),
      event: {
        cursor: `child-response-${index}`,
        sequence: 1,
        type: "model.output.completed",
        createdAt: 5,
        text: `## Agent ${index + 1}\n\n**Complete.**`,
      },
      revision: 1,
    }).state
  }

  const toolRows = (state.model.items as ReadonlyArray<ViewState.TranscriptItem>).filter(
    (item) => item._tag === "Block" && item.id?.startsWith("tool:"),
  )
  expect(toolRows).toHaveLength(8)
  expect(toolRows.filter((item) => item.parentId !== undefined)).toHaveLength(4)
  expect(state.model.entries.filter((entry) => entry.text.startsWith("## Agent"))).toHaveLength(4)
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
      id: `assistant:${childId}:0`,
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
      expect.objectContaining({ id: `${childId}:bash`, status: "cancelled" }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(
      renderTranscriptStyled(model)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toContain("⊘ Subagent cancelled")
  }
})

it("buffers live child patches until the parent subagent link arrives", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const child = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
    },
    revision: 0,
  })
  const requested = InteractiveController.update(child.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
    },
    revision: 0,
  })
  const spawned = InteractiveController.update(requested.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 5,
      data: { tool_call_id: "agent", child_execution_id: "execution:parent:child:agent" },
    },
    revision: 1,
  })

  expect(child.state.projections.get("parent:child:agent")?.units).toHaveLength(2)
  expect(child.state.model.blocks).not.toContainEqual(expect.objectContaining({ id: "parent:child:agent:read" }))
  expect(spawned.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "parent:agent" }),
    expect.objectContaining({ _tag: "ToolCall", id: "parent:child:agent:read" }),
  ])
  expect(spawned.state.model.items[2]).toMatchObject({
    id: "tool:parent:child:agent:read",
    parentId: "parent:agent",
  })
})

it("surfaces a child projection whose parent tool has not arrived instead of dropping it", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const child = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
    },
    revision: 0,
  })
  const requested = InteractiveController.update(child.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review" } },
    },
    revision: 0,
  })
  const spawned = InteractiveController.update(requested.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 5,
      data: { tool_call_id: "agent", child_execution_id: "execution:parent:child:agent" },
    },
    revision: 1,
  })

  expect(child.unattached).toContain("parent:child:agent")
  expect(child.state.model.blocks).not.toContainEqual(expect.objectContaining({ id: "parent:child:agent:read" }))
  expect(spawned.unattached ?? []).not.toContain("parent:child:agent")
  expect(spawned.state.model.blocks).toContainEqual(expect.objectContaining({ id: "parent:child:agent:read" }))
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
    projections: new Map([[turn.id, Transcript.empty(turn.id, turn.prompt)]]),
  }
  const labels = ["Sending", "Waiting", "Thinking 2 tok", "Streaming 2 tok", "Running tools"]
  const expectStatus = (expected: string) => {
    const label = ViewState.formatActivity(state.model.activity)
    expect(label).toBe(expected)
    expect(labels).toContain(label)
  }
  const patch = (sequence: number, type: string, text?: string, data?: Readonly<Record<string, unknown>>) => {
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make("active"),
      event: {
        cursor: `event-${sequence}`,
        sequence,
        type,
        createdAt: sequence,
        ...(text === undefined ? {} : { text }),
        ...(data === undefined ? {} : { data }),
      },
      revision: sequence,
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
  expectStatus("Running tools")
  patch(5, "tool.call.requested", undefined, {
    tool_call_id: "status",
    tool_name: "bash",
    input: { command: "git --no-optional-locks status --short --branch" },
  })
  expectStatus("Running tools")
  patch(6, "tool.result.received", undefined, { tool_call_id: "read", output: "contents" })
  expectStatus("Running tools")
  patch(7, "tool.result.received", undefined, { tool_call_id: "status", output: "clean" })
  expectStatus("Waiting")
  patch(8, "model.output.delta", "abcdefgh")
  expectStatus("Streaming 2 tok")
  patch(9, "model.output.completed", "abcdefgh")
  expectStatus("Waiting")
  patch(10, "execution.completed")
  expect(ViewState.formatActivity(state.model.activity)).toBeUndefined()
  expect(state.model.busy).toBe(false)
})

it("keeps 200ms tool lifecycle events in distinct TUI frames", () => {
  type TranscriptPatched = Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptPatched" }>
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
    projections: new Map([[turn.id, Transcript.empty(turn.id, turn.prompt)]]),
  }
  let now = 0
  const scheduled: Array<{ readonly at: number; readonly flush: () => void }> = []
  const applied: Array<{ readonly at: number; readonly type: string; readonly activity: string | undefined }> = []
  const batcher = InteractiveController.makeFeedFrameBatcher<TranscriptPatched>({
    schedule: (flush) => scheduled.push({ at: now + 16, flush }),
    apply: (events) => {
      for (const event of events) {
        state = InteractiveController.update(state, event).state
        applied.push({ at: now, type: event.event.type, activity: ViewState.formatActivity(state.model.activity) })
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
  const event = (
    sequence: number,
    type: "tool.call.requested" | "tool.result.received",
    callId: string,
  ): TranscriptPatched => ({
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: turn.id,
    event: {
      cursor: `timed-${sequence}`,
      sequence,
      type,
      createdAt: now,
      data:
        type === "tool.call.requested"
          ? { tool_call_id: callId, tool_name: "read", input: { path: `${callId}.ts` } }
          : { tool_call_id: callId, output: callId },
    },
    revision: sequence,
  })

  batcher.offer(event(0, "tool.call.requested", "first"))
  batcher.offer(event(1, "tool.call.requested", "second"))
  advance(200)
  batcher.offer(event(2, "tool.result.received", "first"))
  advance(400)
  batcher.offer(event(3, "tool.result.received", "second"))
  advance(500)

  expect(applied.map(({ at }) => at)).toEqual([16, 16, 216, 416])
  expect(applied.map(({ activity }) => activity)).toEqual([
    "Running tools",
    "Running tools",
    "Running tools",
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
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:worker"),
    rootTurnId: Turn.TurnId.make("parent"),
    rootTurnCostUsd: 0.75,
    threadCostUsd: 0.75,
    globalCostUsd: 10.25,
    event: {
      cursor: "child-usage",
      sequence: 0,
      type: "model.usage.reported",
      createdAt: 3,
      data: { cost_usd: 0.25 },
    },
    revision: 0,
  })

  expect(page.state.model.costUsd).toBe(0.5)
  expect(child.state.model.costUsd).toBe(0.75)
  expect(child.state.threadCostUsd).toBe(0.75)
  expect(child.state.projections.get("parent")?.costUsd).toBe(0.75)
})

it("applies a late cost aggregate without lowering the semantic revision", () => {
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
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    threadCostUsd: 0.75,
    event: {
      cursor: "late-cost",
      sequence: 2,
      type: "model.attempt.completed",
      createdAt: 3,
    },
    revision: 2,
  })

  expect(late.state.model.costUsd).toBe(0.75)
  expect(late.state.threadCostUsd).toBe(0.75)
  expect(late.state.revisions.get("parent")).toBe(9)
})

it("clears working state when the semantic event stream reaches a terminal event", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const completed = InteractiveController.update(
    {
      ...page.state,
      model: { ...page.state.model, activeTurnId: "new", busy: true, activity: { _tag: "Sending" } },
    },
    {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make("new"),
      event: { cursor: "terminal", sequence: 0, type: "execution.completed", createdAt: 3 },
      revision: 0,
    },
  )

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
  const delayedPatch = InteractiveController.update(delayedA1.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("a-1"),
    event: { cursor: "stale", sequence: 9, type: "model.output.completed", createdAt: 9, text: "stale" },
    revision: 9,
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
  type TranscriptPatched = Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptPatched" }>
  const scheduled: Array<() => void> = []
  let received = 0
  let applied = 0
  let renders = 0
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("stream", 2),
    hasOlder: false,
    threadCostUsd: 0,
  }).state
  const events: ReadonlyArray<TranscriptPatched> = Array.from({ length: 257 }, (_, index) => ({
    _tag: "TranscriptPatched" as const,
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("stream"),
    event: {
      cursor: `chunk-${index}`,
      sequence: index,
      type: "model.output.delta",
      createdAt: index,
      text: index === 256 ? "FINAL-CHUNK" : "x",
    },
    revision: index,
  }))
  const batcher = InteractiveController.makeFeedFrameBatcher<TranscriptPatched>({
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
  const consume = (dispatch: (event: TranscriptPatched) => void) => {
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

it("applies a root lifecycle boundary without waiting behind a child delta flood", () => {
  type FeedEvent = {
    readonly id: string
    readonly lane: "root" | "child"
    readonly boundary: boolean
  }
  const scheduled: Array<() => void> = []
  const applied: Array<string> = []
  const batcher = InteractiveController.makeFeedFrameBatcher<FeedEvent>({
    schedule: (flush) => scheduled.push(flush),
    apply: (events) => applied.push(...events.map((event) => event.id)),
    render: () => undefined,
    lane: (event) => event.lane,
    boundary: (event) => event.boundary,
  })
  for (let index = 0; index < 300; index += 1) batcher.offer({ id: `child-${index}`, lane: "child", boundary: false })
  batcher.offer({ id: "root-progress", lane: "root", boundary: false })
  batcher.offer({ id: "root-result", lane: "root", boundary: true })

  scheduled.shift()?.()

  expect(applied).toHaveLength(256)
  expect(applied.at(-1)).toBe("root-result")
  expect(applied.at(-2)).toBe("root-progress")
  expect(applied.slice(0, -2)).toEqual(Array.from({ length: 254 }, (_, index) => `child-${index}`))
  while (scheduled.length > 0) scheduled.shift()?.()
  expect(applied.filter((id) => id.startsWith("child-"))).toEqual(
    Array.from({ length: 300 }, (_, index) => `child-${index}`),
  )
})
