import * as InteractiveController from "../src/interactive-controller"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ViewState } from "@rika/tui"
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
    status: "completed" as const,
    createdAt,
    updatedAt: createdAt,
  }
  const projection = Transcript.project(id, id, events)
  return projection.units.map((unit) => ({ turn, unit, projectionRevision: projection.revision }))
}

it("projects prepended pages without rebuilding the loaded transcript", () => {
  const initial: InteractiveController.State = {
    model: ViewState.initial("/work", "medium"),
    replayTurns: new Map(),
    entries: [],
    revisions: new Map(),
  }
  const page = InteractiveController.update(initial, {
    _tag: "TranscriptPageReceived",
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
  })
  const loadedAnswer = page.state.model.entries.at(-1)
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
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
  })

  expect(prepended.state.model.entries.map((value) => value.text)).toEqual(["old", "old answer", "new", "new answer"])
  expect(prepended.state.model.entries.some((value) => value === loadedAnswer)).toBe(true)
})

it("preserves repository order across Turns with overlapping event sequences", () => {
  const initial: InteractiveController.State = {
    model: ViewState.initial("/work", "medium"),
    replayTurns: new Map(),
    entries: [],
    revisions: new Map(),
  }
  const page = InteractiveController.update(initial, {
    _tag: "TranscriptPageReceived",
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
  })

  expect(page.state.model.entries.map((entry) => entry.text)).toEqual(["old", "old answer", "new", "new answer"])
})

it("rejects duplicate patches and replacement pages older than live state while accepting unknown older units", () => {
  const initial: InteractiveController.State = {
    model: ViewState.initial("/work", "medium"),
    replayTurns: new Map(),
    entries: [],
    revisions: new Map(),
  }
  const page = InteractiveController.update(initial, {
    _tag: "TranscriptPageReceived",
    thread,
    entries: entries("new", 2, [
      { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
    ]),
    hasOlder: false,
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
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const duplicate = InteractiveController.update(patched.state, {
    _tag: "TranscriptPatched",
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const stale = InteractiveController.update(duplicate.state, {
    _tag: "TranscriptPageReceived",
    thread,
    entries: entries("new", 2, [
      { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
    ]),
    hasOlder: false,
  })
  const staleOlderEntry = entries("new", 2, [
    { cursor: "older-0", sequence: 0, type: "model.output.completed", createdAt: 0, text: "older answer" },
  ]).find((entry) => entry.unit.content._tag === "Entry" && entry.unit.content.role === "assistant")
  expect(staleOlderEntry).toBeDefined()
  if (staleOlderEntry === undefined) return
  const prepended = InteractiveController.update(duplicate.state, {
    _tag: "TranscriptPagePrepended",
    threadId: thread.id,
    entries: [staleOlderEntry],
    hasOlder: false,
  })

  expect(patched.state.model.entries.at(-1)?.text).toBe("live answer")
  expect(duplicate.state).toBe(patched.state)
  expect(stale.state).toBe(patched.state)
  expect(prepended.state.model.entries[0]?.text).toBe("older answer")
  expect(prepended.state.revisions.get("new")).toBe(2)
})

it("reconciles a stale prepended tool call with its newer retained result", () => {
  const initial: InteractiveController.State = {
    model: ViewState.initial("/work", "medium"),
    replayTurns: new Map(),
    entries: [],
    revisions: new Map(),
  }
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
    _tag: "TranscriptPageReceived",
    thread,
    entries: resultPage,
    hasOlder: true,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    threadId: thread.id,
    entries: [staleCall],
    hasOlder: false,
  })

  expect(prepended.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "new:call-1", status: "complete", output: "ok" }),
  ])
  expect(prepended.state.revisions.get("new")).toBe(2)
})

it("owns transcript page, prepend, and patch reduction", () => {
  const initial: InteractiveController.State = {
    model: ViewState.initial("/work", "medium"),
    replayTurns: new Map(),
    entries: [],
    revisions: new Map(),
  }
  const page = InteractiveController.update(initial, {
    _tag: "TranscriptPageReceived",
    thread,
    entries: entries("new", 2),
    hasOlder: true,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
  })
  const patched = InteractiveController.update(prepended.state, {
    _tag: "TranscriptPatched",
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
