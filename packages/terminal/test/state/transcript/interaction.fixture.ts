import { expect, test } from "vitest"
import { applyQueueDelta, replaceQueue, resetQueue } from "../../../src/state/queue/model"
import { initial, type Model } from "../../../src/state/model"
import type { TranscriptBlock } from "../../../src/state/transcript/model"
import { canSubmit, update } from "../../../src/state/reducer/model"
import { isTranscriptUnitExpanded, transcriptUnits, transcriptUnitId } from "../../../src/presentation/transcript/row"

import { key, thread, readCall, editFile, busyQueueModel } from "./model.fixture"
test("navigates and controls the queue while idle after the active turn failed", () => {
  let model = replaceQueue({ ...initial("/work"), busy: false, activeTurnId: undefined }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("two")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("one")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.queueSelection).toBe("two")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model.pendingAction).toEqual({ _tag: "Dequeue", id: "two" })
  model = { ...model, pendingAction: undefined }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(model.editingTurnId).toBe("two")
  expect(model.input).toBe("two")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.editingTurnId).toBeUndefined()
})
test("does not steer a queued row when no turn is active", () => {
  let model = replaceQueue({ ...initial("/work"), busy: false, activeTurnId: undefined }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toBeUndefined()
  expect(model.queueSelection).toBe("two")
})
test("steers a queued row into the active turn while idle with a queue", () => {
  let model = replaceQueue({ ...initial("/work"), busy: false, activeTurnId: "active" }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "return" }),
    steeringRequestId: "request-idle",
  })
  expect(model.pendingAction).toEqual({
    _tag: "SteerQueued",
    id: "two",
    prompt: "two",
    requestId: "request-idle",
  })
  expect(model.pendingSteering).toEqual([])
  expect(model.steeringRequests).toEqual([
    {
      requestId: "request-idle",
      turnId: "active",
      text: "two",
      origin: "queue",
      queuedTurnId: "two",
    },
  ])
  expect(model.queueSelection).toBeUndefined()
})
test("recalls composer history only when the queue is empty", () => {
  let model: Model = {
    ...initial("/work"),
    history: ["earlier prompt"],
    historyComposers: [],
  }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.input).toBe("earlier prompt")
  const queued = replaceQueue({ ...model, input: "", cursor: 0, historyIndex: undefined }, [
    { id: "one", prompt: "one" },
  ])
  const afterUp = update(queued, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(afterUp.input).toBe("")
  expect(afterUp.queueSelection).toBe("one")
})
test("moves up into queued turns and down or Escape back to the composer", () => {
  let model = replaceQueue({ ...initial("/work"), busy: true, activeTurnId: "active" }, [
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
test("steers a selected row and removes it from queue controls during handoff", () => {
  let model = replaceQueue({ ...initial("/work"), busy: true, activeTurnId: "active" }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "return" }),
    steeringRequestId: "request-selected",
  })
  expect(model.pendingAction).toEqual({
    _tag: "SteerQueued",
    id: "two",
    prompt: "two",
    requestId: "request-selected",
  })
  expect(model.queueSelection).toBeUndefined()
  model = { ...model, pendingAction: undefined }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model.pendingAction).toBeUndefined()
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("one")
  model = update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model.pendingAction).toEqual({ _tag: "Dequeue", id: "one" })
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
  const model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
  ])
  expect(model.queueSelection).toBeUndefined()
  const added = applyQueueDelta(model, "t", 2, { _tag: "Added", item: { id: "c", prompt: "c" } })
  expect(added.resync).toBe(false)
  expect(added.model.queueSelection).toBeUndefined()
})
test("restores an Added queue row at its durable position", () => {
  const model = resetQueue(busyQueueModel(initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "c", prompt: "c" },
  ])
  const restored = applyQueueDelta(model, "t", 2, {
    _tag: "Added",
    item: { id: "b", prompt: "b" },
    position: 1,
  })
  expect(restored.resync).toBe(false)
  expect(restored.model.queue.map((item) => item.id)).toEqual(["a", "b", "c"])
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
  const updated = applyQueueDelta(model, "t", 3, {
    _tag: "Updated",
    item: { id: "a", prompt: "a3" },
  })
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
  expect(model.queue.map((item) => item.prompt)).toEqual(["alpha", "beta"])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "!", sequence: "!" }) })
  expect(model.input).toBe("beta!")
  const saved = update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(saved.pendingAction).toEqual({ _tag: "EditQueued", id: "b", prompt: "beta!" })
  expect(saved.editingTurnId).toBeUndefined()
  expect(saved.queue.map((item) => item.prompt)).toEqual(["alpha", "beta!"])
  expect(saved.queueSelection).toBe("b")
  expect(saved.input).toBe("")
  const cancelled = update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(cancelled.editingTurnId).toBeUndefined()
  expect(cancelled.queue.map((item) => item.prompt)).toEqual(["alpha", "beta"])
  expect(cancelled.queueSelection).toBe("b")
  expect(cancelled.input).toBe("")
  expect(cancelled.pendingAction).toBeUndefined()
})
test("Enter on a selected queued row without edit mode still steers", () => {
  let model = resetQueue({ ...busyQueueModel(initial("/work")), activeTurnId: "active" }, "t", 1, [
    { id: "a", prompt: "alpha" },
  ])
  model = update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = update(model, {
    _tag: "KeyPressed",
    key: key({ name: "return" }),
    steeringRequestId: "request-edit",
  })
  expect(model.pendingAction).toEqual({
    _tag: "SteerQueued",
    id: "a",
    prompt: "alpha",
    requestId: "request-edit",
  })
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
  let model: Model = {
    ...initial("/work"),
    blocks: [
      { _tag: "Reasoning", text: "why" },
      { ...readCall("1", "a", "complete"), result: { text: "a" } },
      { _tag: "Diff", path: "a", patch: "+a" },
    ],
  }
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
  expect(model.detailSelection).toBe("tool:1")
})
test("keeps an expanded streamed tool group open as new children arrive", () => {
  let model = update(initial("/work"), { _tag: "BlockAdded", block: readCall("1", "a") })
  model = update(model, { _tag: "BlockAdded", block: readCall("2", "b") })
  model = update(model, { _tag: "DetailToggled", id: "tool:1" })
  for (let index = 3; index <= 5; index += 1)
    model = update(model, {
      _tag: "BlockAdded",
      block: readCall(String(index), String.fromCharCode(96 + index)),
    })

  expect(model.expandedRowKeys).toContain("tool:1")
  const collapsed = update(model, { _tag: "DetailToggled", id: "tool:1" })
  expect(collapsed.expandedRowKeys).not.toContain("tool:1")
})
test("click toggles do not move the Tab detail selection", () => {
  const base = {
    ...initial("/work"),
    blocks: [{ ...readCall("1", "a", "complete"), result: { text: "a" } }],
  }
  const clicked = update(base, { _tag: "DetailToggled", id: "tool:1" })
  expect(clicked).toMatchObject({ detailSelection: undefined, expandedRowKeys: ["tool:1"] })

  const tabbed = update(clicked, { _tag: "KeyPressed", key: key({ name: "tab" }) })
  expect(tabbed.detailSelection).toBe("tool:1")
})
test("keeps an explicit collapse sticky while a running edit revises in place", () => {
  const block: Extract<TranscriptBlock, { _tag: "ToolCall" }> = {
    _tag: "ToolCall",
    id: "running-edit",
    name: "edit",
    input: JSON.stringify({ path: "src/a.ts" }),
    status: "running",
    presentation: {
      family: "edit",
      action: "edit",
      activeLabel: "Editing",
      completeLabel: "Edited",
    },
    detail: "src/a.ts",
    files: [editFile("running-edit:0", "src/a.ts")],
  }
  let model: Model = { ...initial("/work"), blocks: [block] }
  let unit = transcriptUnits(model)[0]!
  const id = transcriptUnitId(model, unit)
  expect(isTranscriptUnitExpanded(model, unit)).toBe(true)
  model = update(model, { _tag: "DetailToggled", id })
  expect(model.explicitlyCollapsedRowKeys).toContain(id)
  unit = transcriptUnits(model)[0]!
  expect(isTranscriptUnitExpanded(model, unit)).toBe(false)

  model = { ...model, blocks: [{ ...block, detail: "src/a.ts L1-2" }] }
  unit = transcriptUnits(model)[0]!
  expect(isTranscriptUnitExpanded(model, unit)).toBe(false)
})

test("keeps an explicit collapse sticky while a running SubagentCard reports activity", () => {
  const card: Extract<TranscriptBlock, { _tag: "SubagentCard" }> = {
    _tag: "SubagentCard",
    id: "child",
    name: "Task",
    prompt: "Inspect the terminal",
    promptTruncated: false,
    summary: "",
    status: "running",
    activity: ["Reading packages/terminal"],
  }
  let model: Model = { ...initial("/work"), blocks: [card] }
  let unit = transcriptUnits(model)[0]!
  const id = transcriptUnitId(model, unit)
  expect(isTranscriptUnitExpanded(model, unit)).toBe(true)
  model = update(model, { _tag: "DetailToggled", id })
  model = { ...model, blocks: [{ ...card, activity: [...card.activity, "Running tests"] }] }
  unit = transcriptUnits(model)[0]!
  expect(isTranscriptUnitExpanded(model, unit)).toBe(false)
  expect(model.explicitlyCollapsedRowKeys).toContain(id)
})

test("toggles an expanded edit group's file rows independently", () => {
  const call: Extract<TranscriptBlock, { _tag: "ToolCall" }> = {
    _tag: "ToolCall",
    id: "patch",
    name: "edit",
    input: "{}",
    status: "complete",
    presentation: {
      family: "edit",
      action: "edit",
      activeLabel: "Editing",
      completeLabel: "Edited",
    },
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
    block: {
      _tag: "SubagentCard",
      id: "review",
      name: "review",
      prompt: "",
      promptTruncated: false,
      summary: "checking",
      status: "running",
      activity: [],
    },
  } as const
  model = update(model, { _tag: "EventReplayed", event })
  const replayed = update(model, { _tag: "EventReplayed", event })
  expect(replayed).toBe(model)
  expect(model).toMatchObject({ eventCursor: "42", seenEventIds: ["stable"] })
})

test("shows the retry status with a countdown until the retry turn starts", () => {
  let model = update(initial("/work"), { _tag: "TurnStarted", turnId: "turn-a", prompt: "hi" })
  const nextAt = 1_000_004_000
  model = update(model, {
    _tag: "TurnRetryScheduled",
    turnId: "turn-a",
    attempt: 1,
    budget: 3,
    message: "The provider rate-limited the request.",
    nextAt,
    retryCountdown: 4,
  })
  expect(model.activity).toEqual({
    _tag: "Retrying",
    attempt: 1,
    budget: 3,
    message: "The provider rate-limited the request.",
    nextAt,
  })
  expect(model.retryCountdown).toBeGreaterThanOrEqual(3)
  expect(model.retryCountdown).toBeLessThanOrEqual(4)
  model = update(model, { _tag: "AnimationTicked" })
  expect(model.retryCountdown).toBeLessThanOrEqual(4)
  model = update(model, { _tag: "TurnStarted", turnId: "turn-b", prompt: "hi" })
  expect(model.activity?._tag).not.toBe("Retrying")
  expect(model.busy).toBe(true)
})
test("a terminal failure clears the retry status", () => {
  let model = update(initial("/work"), { _tag: "TurnStarted", turnId: "turn-a", prompt: "hi" })
  model = update(model, {
    _tag: "TurnRetryScheduled",
    turnId: "turn-a",
    attempt: 1,
    budget: 3,
    message: "The provider rate-limited the request.",
    nextAt: 1_000_004_000,
    retryCountdown: 4,
  })
  model = update(model, {
    _tag: "ExecutionFailed",
    turnId: "turn-a",
    failure: {
      tag: "TurnFailed",
      category: "rate-limit",
      message: "The provider limited how often requests are accepted.",
      retryable: false,
      retry: "none",
      actor: "environment",
    },
  })
  expect(model.activity).toBeUndefined()
  expect(model.busy).toBe(false)
})
