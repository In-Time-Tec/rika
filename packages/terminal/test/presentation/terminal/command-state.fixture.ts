import { expect, test } from "vitest"
import { replaceQueue, resetQueue } from "../../../src/state/queue/model"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"

import { key, _thread, readCall, _editFile, _busyQueueModel } from "../../state/queue/model.fixture"
test("keeps queue state outside the transcript and tracks scroll follow", () => {
  let model = replaceQueue(initial("/work"), [{ id: "queued", prompt: "old" }])
  model = update(model, { _tag: "ReasoningStreamed", text: "details" })
  expect(model.blocks).toEqual([{ _tag: "Reasoning", text: "details" }])
  expect(model.queue).toEqual([{ id: "queued", prompt: "old" }])
  model = update(model, { _tag: "ScrollMoved", offset: 4 })
  expect(model.scrollFollow).toBe(false)
  model = update(model, { _tag: "ScrollFollowed" })
  expect(model).toMatchObject({ scrollFollow: true, scrollOffset: 0 })
})
test("leaves transcript navigation keys to the viewport owner", () => {
  let model: Model = {
    ...initial("/work"),
    height: 24,
    entries: Array.from({ length: 80 }, (_, index) => ({
      role: "assistant" as const,
      text: `line ${index}`,
    })),
    scrollOffset: 120,
  }
  model = update(model, { _tag: "KeyPressed", key: key({ name: "pageup" }) })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
  model = update(model, { _tag: "AssistantStreamed", text: "more" })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "pagedown" }) })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
  model = update(model, { _tag: "KeyPressed", key: key({ name: "end" }) })
  expect(model).toMatchObject({ scrollOffset: 120, scrollFollow: true })
})
test("streams, completes, and reports failures", () => {
  let model = initial("/work")
  model = update(model, { _tag: "AssistantStreamed", text: "hel" })
  model = update(model, { _tag: "AssistantStreamed", text: "lo" })
  expect(model.entries).toEqual([{ role: "assistant", text: "hello" }])
  model = update(model, { _tag: "AssistantCompleted", text: "final" })
  expect(model.entries).toEqual([{ role: "assistant", text: "final" }])
  model = update(model, { _tag: "AssistantStreamed", text: "next" })
  model = update(model, { _tag: "AssistantCompleted", text: "next final" })
  expect(model.entries).toEqual([
    { role: "assistant", text: "final" },
    { role: "assistant", text: "next final" },
  ])
  model = update(model, { _tag: "AssistantCompleted", text: "completion only" })
  expect(model.entries.at(-1)).toEqual({ role: "assistant", text: "completion only" })
  expect(model.entries).toHaveLength(3)
  model = update(model, {
    _tag: "ExecutionFailed",
    failure: {
      tag: "TestFailure",
      message: "failed",
      category: "operation",
      retryable: false,
      retry: "none",
      actor: "environment",
    },
  })
  expect(model.blocks.at(-1)).toEqual({
    _tag: "Error",
    title: "TestFailure",
    detail: "failed",
    category: "operation",
    retryable: false,
  })
  expect(model.items.at(-1)).toEqual({ _tag: "Block", index: 0 })
  expect(model.busy).toBe(false)
  model = { ...model, input: "try again", cursor: 9 }
  model = update(model, { _tag: "Submitted", submissionId: "retry-submission" })
  expect(model.entries.at(-1)).toEqual({ role: "user", text: "try again" })
  model = update(model, {
    _tag: "SubmissionAdmitted",
    turnId: "retry",
    submissionId: "retry-submission",
    status: "active",
  })
  expect(model.entries.at(-1)).toEqual({ role: "user", text: "try again", turnId: "retry" })
  model = update(model, { _tag: "TurnStarted", turnId: "retry", prompt: "try again" })
  expect(model.entries.at(-1)).toEqual({ role: "user", text: "try again", turnId: "retry" })
  expect(model.items.at(-1)).toEqual({
    _tag: "Entry",
    index: 3,
    id: "turn:retry:user",
    turnId: "retry",
    submissionId: "retry-submission",
  })
  expect(model).toMatchObject({ input: "", busy: true })
  model = update(initial("/work"), { _tag: "AssistantCompleted", text: "standalone" })
  expect(model.entries).toEqual([{ role: "assistant", text: "standalone" }])
})
test("cancels every running transcript unit once and leaves no global notice", () => {
  const parent = {
    _tag: "ToolCall" as const,
    id: "parent",
    name: "task",
    input: "{}",
    status: "running" as const,
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
    items: [
      { _tag: "Block", index: 0, id: "tool:parent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child", turnId: "turn:child", parentId: "parent" },
    ],
  }

  const cancelled = update(running, { _tag: "ExecutionCancelled", turnId: "turn" })
  const repeated = update(cancelled, { _tag: "ExecutionCancelled", turnId: "turn" })

  expect(cancelled.blocks).toEqual([
    expect.objectContaining({ id: "parent", status: "cancelled" }),
    expect.objectContaining({ id: "child", status: "cancelled" }),
  ])
  expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
  expect(repeated).toBe(cancelled)
})
test("restores a submitted draft when cancellation arrives before an agent response", () => {
  let running = update({ ...initial("/work"), input: "cancel this prompt", cursor: 6 }, { _tag: "Submitted" })
  const attachment = {
    type: "text" as const,
    token: "token",
    value: "attachment",
    label: "Pasted text #1",
  }
  running = update(
    { ...running, pastedText: [attachment] },
    { _tag: "TurnStarted", turnId: "turn", prompt: "cancel this prompt" },
  )
  running = {
    ...running,
    submittedDrafts: [{ input: "cancel this prompt", cursor: 6, attachments: [attachment], turnId: "turn" }],
  }

  const cancelled = update(running, {
    _tag: "ExecutionCancelled",
    turnId: "turn",
    agentResponseArrived: false,
  })
  const repeated = update(cancelled, {
    _tag: "ExecutionCancelled",
    turnId: "turn",
    agentResponseArrived: false,
  })

  expect(cancelled).toMatchObject({
    input: "cancel this prompt",
    cursor: 6,
    pastedText: [attachment],
    busy: false,
    activeTurnId: undefined,
  })
  expect(cancelled.entries.filter((entry) => entry.role === "notice")).toEqual([])
  expect(repeated).toBe(cancelled)
})
test("submitting while a turn is active stays an ordinary submission", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    input: "queued follow-up",
  }
  const submitted = update(busy, { _tag: "Submitted", submissionId: "sub-q" })
  expect(submitted.input).toBe("")
  expect(submitted.busy).toBe(true)
  expect(submitted.pendingSteering).toEqual([])
  expect(submitted.pendingAction).toBeUndefined()
  expect(submitted.submittedDrafts).toEqual([
    { input: "queued follow-up", attachments: [], cursor: 0, submissionId: "sub-q" },
  ])
})
test("submitting while busy adds a provisional queue row before admission", () => {
  const busy: Model = resetQueue(
    {
      ...initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      currentThreadId: "thread",
      input: "queued prompt",
    },
    "thread",
    3,
    [],
  )
  const submitted = update(busy, { _tag: "Submitted", submissionId: "sub-1" })
  expect(submitted.queue).toEqual([{ id: "sub-1", prompt: "queued prompt", provisional: true }])
  expect(submitted.queueRevision).toBe(3)
  expect(submitted.input).toBe("")
  const admitted = update(submitted, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-1",
    submissionId: "sub-1",
    status: "queued",
  })
  expect(admitted.queue).toEqual([{ id: "turn-1", prompt: "queued prompt", provisional: true }])
  expect(admitted.input).toBe("")
})
