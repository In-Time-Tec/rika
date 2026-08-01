import * as InteractiveController from "../src/interactive/controller/interactive-controller"
import * as InteractivePalette from "../src/interactive/controller/interactive-palette-controller"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as ViewState from "@rika/terminal/terminal-state"
import * as Reducer from "@rika/terminal/terminal-state-reducer"
import { expect, it } from "vitest"
import { thread, entries, initialState } from "./interactive-controller-transcript-fixtures"
import { transientDelta, makeProjectionFeed, key } from "./interactive-controller-stream-fixtures"

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

  expect(InteractivePalette.paletteCommand({ _tag: "NewThread" })).toEqual({ _tag: "NewThread" })
  expect(InteractivePalette.paletteCommands).toContainEqual({
    id: "new-thread",
    category: "thread",
    label: "New thread",
    action: { _tag: "NewThread" },
  })
  const palette: Array<InteractivePalette.PaletteCommand> = []
  InteractivePalette.installPaletteCommands(palette)
  InteractivePalette.installPaletteCommands(palette)
  expect(palette).toEqual(InteractivePalette.paletteCommands)
  InteractivePalette.installPaletteCommands(Reducer.commands as Array<InteractivePalette.PaletteCommand>)
  let paletteModel = Reducer.update(ViewState.initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  paletteModel = Reducer.update(paletteModel, { _tag: "KeyPressed", key: key({ name: "return" }) })
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
  const projection = TranscriptProjection.Projection.project(turn.id, turn.prompt, [
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

  const feed = makeProjectionFeed(
    page.state,
    turn,
    TranscriptProjection.Projection.project(turn.id, turn.prompt, source),
  )
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
  const feed = makeProjectionFeed(
    prepended.state,
    activeTurn,
    TranscriptProjection.Projection.empty(activeTurn.id, activeTurn.prompt),
  )
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
    TranscriptIdentity.identityKey("assistant", "old", 0),
    "turn:new:user",
    TranscriptIdentity.identityKey("assistant", "new", 0),
  ])
  expect(prepended.state.entries).toEqual(selected.state.entries)
  expect(prepended.state.model.entries.map((entry) => entry.text)).toEqual(["old", "old answer", "new", "new answer"])
})
