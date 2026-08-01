import { expect, test } from "vitest"
import { applyQueueDelta, replaceQueue, resetQueue } from "../../src/state/model/terminal-queue-state"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { type TranscriptBlock } from "../../src/state/model/terminal-transcript-state"
import { canSubmit, update } from "../../src/state/reducer/terminal-state-reducer"

import { key, thread, readCall, editFile, busyQueueModel } from "./terminal-state-characterization-2-support"
test("a stale terminal event for another turn does not clear the active turn", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-b",
    submittedDrafts: [{ input: "second", attachments: [], cursor: 0, turnId: "turn-b" }],
  }
  const afterStale = update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(afterStale.busy).toBe(true)
  expect(afterStale.activeTurnId).toBe("turn-b")
  expect(afterStale.submittedDrafts).toHaveLength(1)
})
test("settles cancellation without adding a textual notice", () => {
  const running: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn",
    submittedDrafts: [{ input: "submitted", cursor: 9, attachments: [], turnId: "turn" }],
  }

  const cancelled = update(running, {
    _tag: "ExecutionCancelled",
    turnId: "turn",
    agentResponseArrived: true,
  })

  expect(cancelled.entries).toEqual([])
  expect(cancelled.items).toEqual([])
  expect(cancelled.input).toBe("")
})
test("does not add a fallback marker when the parent cancellation event arrived first", () => {
  const parent = {
    _tag: "ToolCall" as const,
    id: "parent",
    name: "task",
    input: "{}",
    status: "cancelled" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "Run the checks",
    files: [],
  }
  const child = readCall("child", "src/a.ts")
  const running: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn",
    blocks: [parent, child],
  }

  const cancelled = update(running, { _tag: "ExecutionCancelled", turnId: "turn" })

  expect(cancelled.blocks).toEqual([
    expect.objectContaining({ id: "parent", status: "cancelled" }),
    expect.objectContaining({ id: "child", status: "cancelled" }),
  ])
  expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
})
test("models structured transcript blocks without backend types", () => {
  let model = initial("/work")
  model = update(model, { _tag: "ReasoningStreamed", text: "checking " })
  model = update(model, { _tag: "ReasoningStreamed", text: "files" })
  model = update(model, {
    _tag: "BlockAdded",
    block: {
      _tag: "ToolCall",
      id: "1",
      name: "read",
      input: "a.ts",
      status: "running",
      presentation: {
        family: "explore",
        action: "read",
        activeLabel: "Exploring",
        completeLabel: "Explored",
        counter: "file",
      },
      detail: "a.ts",
      files: [],
    },
  })
  model = update(model, {
    _tag: "BlockAdded",
    block: { _tag: "ToolResult", id: "1", output: "ok", failed: false },
  })
  model = update(model, { _tag: "BlockAdded", block: { _tag: "Diff", path: "a.ts", patch: "+hello" } })
  expect(model.blocks).toHaveLength(4)
  expect(model.blocks[0]).toMatchObject({ _tag: "Reasoning", text: "checking files" })
})
test("executes every focused palette action", () => {
  let model = initial("/work")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "change mode")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.modePicker.open).toBe(true)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.mode).toBe("high")

  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "thread switch")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.threadSwitcher.open).toBe(true)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })

  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "fast")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.fastMode).toBe(true)

  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "quit")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "Quit" })
})
test("keeps overlays exclusive and types @ and ? into a non-empty composer", () => {
  let model = { ...initial("/work"), input: "draft", cursor: 5 }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  expect(model).toMatchObject({ paletteOpen: false, palette: { open: false }, filePicker: { open: true } })
  expect(model.input).toBe("draft@")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ shortcutsOpen: false, filePicker: { open: true, query: "?" } })
  expect(model.input).toBe("draft@?")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.filePicker.open).toBe(false)
  expect(model.input).toBe("draft@?")
  model = { ...model, input: "", cursor: 0 }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model.shortcutsOpen).toBe(true)
  expect(model.input).toBe("?")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.shortcutsOpen).toBe(false)
})
test("opens shortcuts only for the first question mark in an empty composer", () => {
  let sentence = { ...initial("/work"), input: "how was your day", cursor: 16 }
  sentence = update(sentence, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(sentence).toMatchObject({
    input: "how was your day?",
    cursor: 17,
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  })

  let model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model).toMatchObject({ input: "?", cursor: 1, shortcutsOpen: true, shortcutsTrigger: 0 })

  model = update(model, { _tag: "KeyPressed", key: key({ name: "a", sequence: "a" }) })
  expect(model).toMatchObject({ input: "?a", cursor: 2, shortcutsOpen: true, shortcutsTrigger: 0 })

  model = update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ input: "?a", cursor: 2, shortcutsOpen: false, shortcutsTrigger: undefined })

  model = update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ input: "?a?", cursor: 3, shortcutsOpen: false, shortcutsTrigger: undefined })

  model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model).toMatchObject({ input: "", cursor: 0, shortcutsOpen: false, shortcutsTrigger: undefined })
})
test("does not open shortcuts when question mark is typed in a dialog", () => {
  let model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ shortcutsOpen: false, palette: { open: true, query: "?" }, input: "" })
})
test("keeps an empty palette open with a valid selection and no action", () => {
  let model = update(initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  for (const character of "no such command")
    model = update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.palette.selected).toBe(0)
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model).toMatchObject({ paletteOpen: true, palette: { open: true, selected: 0 } })
  expect(model.pendingAction).toBeUndefined()
})
test("switches mutually exclusively between the workspace file tree and changed files", () => {
  let model = initial("/work")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "s", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: true })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: false })
})
test("toggles every transcript detail as one reducer action", () => {
  let model = {
    ...initial("/work"),
    blocks: [
      { _tag: "Reasoning", text: "why" },
      readCall("read", "src/a.ts", "complete"),
      { _tag: "Diff", path: "src/a.ts", patch: "+a" },
    ],
  } as Model
  model = update(model, { _tag: "AllDetailsToggled" })
  expect(model.expandedRowKeys).toEqual(["block:Reasoning:0", "tool:read", "block:Diff:2"])
  model = update(model, { _tag: "AllDetailsToggled" })
  expect(model.expandedRowKeys).toEqual([])
})
test("keeps an unchanged changed-files snapshot stable", () => {
  const files = [{ path: "src/a.ts", status: "M", added: 1, removed: 2 }]
  const model = update(initial("/work"), { _tag: "ChangedFilesReplaced", files })

  expect(update(model, { _tag: "ChangedFilesReplaced", files: [...files] })).toBe(model)
})
test("moves up into queued turns and down or Escape back to the composer", () => {
  let model = replaceQueue({ ...initial("/work"), busy: true }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("two")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("one")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.queueSelection).toBe("two")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.queueSelection).toBeUndefined()
  expect(model.pendingAction).toBeUndefined()
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("two")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.queueSelection).toBeUndefined()
  expect(model.pendingAction).toBeUndefined()
})
test("steers and dequeues only while a queued turn is selected", () => {
  let model = replaceQueue({ ...initial("/work"), busy: true }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "SteerQueued", id: "two", prompt: "two" })
  model = { ...model, pendingAction: undefined }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model.pendingAction).toEqual({ _tag: "Dequeue", id: "two" })
})
test("leaves the queue unchanged when Backspace is pressed from the composer", () => {
  const model = update(
    replaceQueue({ ...initial("/work"), busy: true }, [
      { id: "first", prompt: "first" },
      { id: "second", prompt: "second" },
    ]),
    { _tag: "KeyPressed", key: key({ name: "backspace" }) },
  )
  expect(model.queueSelection).toBeUndefined()
  expect(model.pendingAction).toBeUndefined()
})
test("keeps queue navigation inactive on reset and Added", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
  ])
  expect(model.queueSelection).toBeUndefined()
  const added = applyQueueDelta(model, "t", 2, { _tag: "Added", item: { id: "c", prompt: "c" } })
  expect(added.resync).toBe(false)
  expect(added.model.queueSelection).toBeUndefined()
})
test("keeps a still-valid selection across reset and Updated", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
  ])
  model = { ...model, queueSelection: "a" }
  model = resetQueue(model, "t", 2, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
  ])
  expect(model.queueSelection).toBe("a")
  const updated = applyQueueDelta(model, "t", 3, { _tag: "Updated", item: { id: "a", prompt: "a3" } })
  expect(updated.model.queueSelection).toBe("a")
  expect(updated.model.queue[0]).toEqual({ id: "a", prompt: "a3" })
})
test("reselects the neighbor at the same index when the selected queued turn is removed", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
    { id: "c", prompt: "c" },
  ])
  model = { ...model, queueSelection: "b" }
  const removed = applyQueueDelta(model, "t", 2, { _tag: "Removed", turnId: "b" })
  expect(removed.model.queue.map((item) => item.id)).toEqual(["a", "c"])
  expect(removed.model.queueSelection).toBe("c")
})
test("reconciles a mismatched durable queued count by requesting a resync", () => {
  const model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [{ id: "a", prompt: "a" }])
  const applied = applyQueueDelta(model, "t", 2, { _tag: "Added", item: { id: "b", prompt: "b" } }, 5)
  expect(applied.resync).toBe(true)
})
test("edits a queued turn: Ctrl+E loads it, Enter saves EditQueued, Escape restores", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [
    { id: "a", prompt: "alpha" },
    { id: "b", prompt: "beta" },
  ])
  expect(model.queueSelection).toBeUndefined()
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("b")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(model.editingTurnId).toBe("b")
  expect(model.input).toBe("beta")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "!", sequence: "!" }) })
  expect(model.input).toBe("beta!")
  const saved = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(saved.pendingAction).toEqual({ _tag: "EditQueued", id: "b", prompt: "beta!" })
  expect(saved.editingTurnId).toBeUndefined()
  expect(saved.input).toBe("")
  const cancelled = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(cancelled.editingTurnId).toBeUndefined()
  expect(cancelled.queueSelection).toBeUndefined()
  expect(cancelled.input).toBe("")
  expect(cancelled.pendingAction).toBeUndefined()
})
test("Enter on a selected queued row without edit mode still steers", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "SteerQueued", id: "a", prompt: "alpha" })
  expect(model.editingTurnId).toBeUndefined()
})
test("does not allow submit while editing a queued turn", () => {
  expect(canSubmit({ ...initial("/work"), editingTurnId: "b", input: "edited" })).toBe(false)
  expect(canSubmit({ ...initial("/work"), input: "normal" })).toBe(true)
})
test("exits edit mode and restores the composer when the edited queued turn is removed", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [
    { id: "a", prompt: "alpha" },
    { id: "b", prompt: "beta" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(model.editingTurnId).toBe("b")
  expect(model.input).toBe("beta")
  const removed = applyQueueDelta(model, "t", 2, { _tag: "Removed", turnId: "b" }).model
  expect(removed.editingTurnId).toBeUndefined()
  expect(removed.editReturn).toBeUndefined()
  expect(removed.input).toBe("")
})
test("blocks image attachment while editing a queued turn", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(model.editingTurnId).toBe("a")
  const after = update(model, { _tag: "ImageInserted", path: "/tmp/x.png" })
  expect(after.input).toBe(model.input)
  expect(after.pastedText).toEqual([])
})
test("ignores queue dequeue and edit re-entry keys while editing with a cleared composer", () => {
  let model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  model = { ...model, input: "", cursor: 0 }
  const backspaced = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(backspaced.pendingAction).toBeUndefined()
  expect(backspaced.editingTurnId).toBe("a")
  const reentry = update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(reentry.input).toBe("")
})
test("navigates transcript detail units with Tab and toggles the selected unit", () => {
  let model = {
    ...initial("/work"),
    blocks: [
      { _tag: "Reasoning", text: "why" },
      readCall("1", "a", "complete"),
      { _tag: "Diff", path: "a", patch: "+a" },
    ],
  } as Model
  model = update({ ...model, detailSelection: "block:Diff:2" }, { _tag: "DetailToggled", id: "block:Diff:2" })
  expect(model).toMatchObject({
    detailSelection: "block:Diff:2",
    expandedRowKeys: ["block:Diff:2"],
  })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "tab", shift: true }) })
  expect(model.detailSelection).toBe("tool:1")
  model = update(model, { _tag: "DetailToggled", id: "tool:1" })
  expect(model).toMatchObject({
    detailSelection: "tool:1",
    expandedRowKeys: ["block:Diff:2", "tool:1"],
  })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
  expect(model.detailSelection).toBe("block:Diff:2")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
  expect(model.detailSelection).toBe("block:Reasoning:0")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.expandedRowKeys).toEqual(["block:Diff:2", "tool:1", "block:Reasoning:0"])
})
test("keeps an expanded streamed tool group open as new children arrive", () => {
  let model = update(initial("/work"), { _tag: "BlockAdded", block: readCall("1", "a") })
  model = update(model, { _tag: "DetailToggled", id: "tool:1" })
  for (let index = 2; index <= 5; index += 1)
    model = update(model, {
      _tag: "BlockAdded",
      block: readCall(String(index), String.fromCharCode(96 + index)),
    })

  expect(model.expandedRowKeys).toContain("tool:1")
  const collapsed = update(model, { _tag: "DetailToggled", id: "tool:1" })
  expect(collapsed.expandedRowKeys).not.toContain("tool:1")
})
test("click toggles do not move the Tab detail selection", () => {
  const base = { ...initial("/work"), blocks: [readCall("1", "a", "complete")] }
  const clicked = update(base, { _tag: "DetailToggled", id: "tool:1" })
  expect(clicked).toMatchObject({ detailSelection: undefined, expandedRowKeys: ["tool:1"] })

  const tabbed = update(clicked, { _tag: "KeyPressed", key: key({ name: "tab" }) })
  expect(tabbed.detailSelection).toBe("tool:1")
})
test("toggles an expanded edit group's file rows independently", () => {
  const call: Extract<TranscriptBlock, { _tag: "ToolCall" }> = {
    _tag: "ToolCall",
    id: "patch",
    name: "edit",
    input: "{}",
    status: "complete",
    presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
    detail: "",
    files: [editFile("patch:0", "src/a.ts"), editFile("patch:1", "src/b.ts")],
  }
  const parent = "tool:patch"
  const child = "file:patch:0"
  const model = update(
    { ...initial("/work"), blocks: [call], expandedRowKeys: [parent] },
    { _tag: "DetailToggled", id: child },
  )

  expect(model).toMatchObject({ detailSelection: undefined, expandedRowKeys: [parent, child] })
})
test("navigates threads and deduplicates replay", () => {
  let model = update(initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second", unread: true })],
  })
  model = update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 1 })
  model = update(model, { _tag: "ThreadSidebarSelectionConfirmed" })
  expect(model.pendingAction).toEqual({ _tag: "SelectThread", id: "b" })
  const event = {
    id: "stable",
    cursor: "42",
    block: { _tag: "ChildAgent", id: "review", name: "review", summary: "checking", status: "running", activity: [] },
  } as const
  model = update(model, { _tag: "EventReplayed", event })
  const replayed = update(model, { _tag: "EventReplayed", event })
  expect(replayed).toBe(model)
  expect(model).toMatchObject({ eventCursor: "42", seenEventIds: ["stable"] })
})
