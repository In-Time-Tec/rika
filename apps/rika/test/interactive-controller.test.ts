import * as InteractiveController from "../src/interactive-controller"
import type * as Operation from "@rika/app/operation"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { Keys, Palette, ViewState } from "@rika/tui"
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

it("updates one typed apply-patch row while its diff is streaming", () => {
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
  const first = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: {
      cursor: "patch-0",
      sequence: 0,
      type: "model.toolcall.delta",
      createdAt: 3,
      data: {
        tool_call_id: "call-1",
        tool_name: "apply_patch",
        delta: '{"patchText":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old\\n+new',
      },
    },
    revision: 0,
  })
  const second = InteractiveController.update(first.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: {
      cursor: "patch-1",
      sequence: 1,
      type: "model.toolcall.delta",
      createdAt: 4,
      data: { tool_call_id: "call-1", tool_name: "apply_patch", delta: '\\n*** End Patch"}' },
    },
    revision: 1,
  })

  expect(first.state.model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      id: "new:call-1",
      files: [expect.objectContaining({ path: "src/a.ts", preview: true, additions: 1, deletions: 1 })],
    }),
  ])
  expect(second.state.model.blocks).toHaveLength(1)
  expect(second.state.model.items).toHaveLength(2)
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
      data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/a.ts" } },
    },
    revision: 0,
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
})

it("maps semantic stream events to counters and inline tool activity without Waiting", () => {
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("active", 2),
    hasOlder: false,
    threadCostUsd: 0,
    activeTurn: entries("active", 2)[0]!.turn,
  }).state
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

  patch(0, "model.reasoning.delta", "12345678")
  expect(ViewState.formatActivity(state.model.activity)).toBe("Thinking 2 tok")
  patch(1, "model.reasoning.delta", "🙂")
  expect(ViewState.formatActivity(state.model.activity)).toBe("Thinking 3 tok")
  patch(2, "model.output.delta", "abcdefgh")
  expect(ViewState.formatActivity(state.model.activity)).toBe("Streaming 2 tok")
  patch(3, "tool.call.requested", undefined, {
    tool_call_id: "read",
    tool_name: "read_file",
    input: { path: "src/a.ts" },
  })
  expect(ViewState.formatActivity(state.model.activity)).toBe("Exploring src/a.ts")
  patch(4, "tool.result.received", undefined, { tool_call_id: "read", output: "contents" })
  expect(ViewState.formatActivity(state.model.activity)).toBeUndefined()
  expect(JSON.stringify(state.model)).not.toContain("Waiting")
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

it("eagerly consumes a 2000-event feed while bounding reducer work per render frame", () => {
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
  const events: ReadonlyArray<TranscriptPatched> = Array.from({ length: 2_000 }, (_, index) => ({
    _tag: "TranscriptPatched" as const,
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("stream"),
    event: {
      cursor: `chunk-${index}`,
      sequence: index,
      type: "model.output.delta",
      createdAt: index,
      text: index === 1_999 ? "FINAL-CHUNK" : "x",
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
      const until = performance.now() + 2
      while (performance.now() < until) {}
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

  expect(received).toBe(2_000)
  expect(applied).toBe(0)
  expect(scheduled).toHaveLength(1)
  scheduled.shift()?.()
  expect(applied).toBe(256)
  expect(scheduled).toHaveLength(1)
  while (scheduled.length > 0) scheduled.shift()?.()
  expect(applied).toBe(2_000)
  expect(renders).toBeLessThan(20)
  expect(state.model.entries.some((entry) => entry.text.includes("FINAL-CHUNK"))).toBe(true)

  batcher.offer(events[0]!)
  expect(scheduled).toHaveLength(1)
})
