import { expect, test } from "vitest"

import { applyQueueDelta, resetQueue } from "../../src/state/model/terminal-queue-state"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { update } from "../../src/state/reducer/terminal-state-reducer"

import { key, _thread, _editFile, _busyQueueModel } from "./terminal-state-characterization-1-support"
test("admission rebinds a queued provisional row and the real delta replaces it without resync", () => {
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
  const admitted = update(submitted, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-b",
    status: "queued",
    submissionId: "sub-1",
  })
  expect(admitted.queue).toEqual([{ id: "turn-b", prompt: "queued prompt", provisional: true }])
  const applied = applyQueueDelta(admitted, "thread", 4, {
    _tag: "Added",
    item: { id: "turn-b", prompt: "queued prompt" },
  })
  expect(applied.resync).toBe(false)
  expect(applied.model.queue).toEqual([{ id: "turn-b", prompt: "queued prompt" }])
  expect(applied.model.queueRevision).toBe(4)
})
test("admission that starts immediately removes the provisional row", () => {
  const busy: Model = resetQueue(
    { ...initial("/work"), busy: true, activeTurnId: "turn-a", currentThreadId: "thread", input: "prompt" },
    "thread",
    3,
    [],
  )
  const submitted = update(busy, { _tag: "Submitted", submissionId: "sub-1" })
  const admitted = update(submitted, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-b",
    status: "active",
    submissionId: "sub-1",
  })
  expect(admitted.queue).toEqual([])
})
test("provisional queue rows ignore edit, steer, and dequeue keys", () => {
  const busy: Model = resetQueue(
    { ...initial("/work"), busy: true, activeTurnId: "turn-a", currentThreadId: "thread", input: "prompt" },
    "thread",
    3,
    [],
  )
  const submitted = update(busy, { _tag: "Submitted", submissionId: "sub-1" })
  const selected = { ...submitted, queueSelection: "sub-1" }
  const dequeued = update(selected, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  const steered = update(selected, { _tag: "KeyPressed", key: key({ name: "return" }) })
  const edited = update(selected, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(dequeued.pendingAction).toBeUndefined()
  expect(steered.pendingAction).toBeUndefined()
  expect(edited.editingTurnId).toBeUndefined()
})
test("steering a selected queued message opens a pending steering row", () => {
  const busy: Model = resetQueue(
    {
      ...initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      currentThreadId: "thread",
      queueSelection: "queued-1",
    },
    "thread",
    1,
    [{ id: "queued-1", prompt: "steer me please" }],
  )
  const steered = update(busy, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(steered.pendingSteering).toEqual([{ turnId: "turn-a", text: "steer me please" }])
  expect(steered.pendingAction).toEqual({ _tag: "SteerQueued", id: "queued-1", prompt: "steer me please" })
})
test("binds an accepted steering sequence and removes it on delivery", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    pendingSteering: [{ turnId: "turn-a", text: "focus on the fixture" }],
  }
  const accepted = update(busy, {
    _tag: "SteeringAccepted",
    turnId: "turn-a",
    sequence: 0,
    text: "focus on the fixture",
  })
  expect(accepted.pendingSteering).toEqual([{ turnId: "turn-a", text: "focus on the fixture", sequence: 0 }])
  const delivered = update(accepted, { _tag: "SteeringDelivered", turnId: "turn-a", sequences: [0] })
  expect(delivered.pendingSteering).toEqual([])
  const foreign = update(accepted, { _tag: "SteeringDelivered", turnId: "turn-b", sequences: [0] })
  expect(foreign.pendingSteering).toHaveLength(1)
})
test("keeps the active turn running and restores text when steering fails", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    pendingSteering: [{ turnId: "turn-a", text: "focus on the fixture" }],
  }
  const failed = update(busy, {
    _tag: "SteeringFailed",
    turnId: "turn-a",
    text: "focus on the fixture",
    message: "Execution did not become available for steering",
  })
  expect(failed.busy).toBe(true)
  expect(failed.activeTurnId).toBe("turn-a")
  expect(failed.pendingSteering).toEqual([])
  expect(failed.input).toBe("focus on the fixture")
  expect(failed.blocks).toContainEqual(
    expect.objectContaining({ _tag: "Notification", title: "Steering not delivered" }),
  )
})
test("ignores steering receipts that arrive after another turn becomes active", () => {
  const active: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-b",
    pendingSteering: [{ turnId: "turn-b", text: "for b" }],
  }
  const accepted = update(active, {
    _tag: "SteeringAccepted",
    turnId: "turn-a",
    sequence: 1,
    text: "for a",
  })
  const failed = update(active, {
    _tag: "SteeringFailed",
    turnId: "turn-a",
    text: "for a",
    message: "late failure",
  })
  expect(accepted).toEqual(active)
  expect(failed).toEqual(active)
})
test("does not issue another cancel while cancellation is pending", () => {
  const pending: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    cancelPending: true,
  }
  expect(update(pending, { _tag: "KeyPressed", key: key({ name: "c", ctrl: true }) })).toEqual(pending)
})
test("restores undelivered steering text into an empty composer when the turn settles", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    pendingSteering: [{ turnId: "turn-a", text: "left behind", sequence: 0 }],
  }
  const completed = update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(completed.pendingSteering).toEqual([])
  expect(completed.input).toBe("left behind")
  const occupied = update({ ...busy, input: "typing" }, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(occupied.pendingSteering).toEqual([])
  expect(occupied.input).toBe("typing")
})
test("keeps steering rows for other turns when one turn settles", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    pendingSteering: [
      { turnId: "turn-a", text: "for a", sequence: 0 },
      { turnId: "turn-b", text: "for b", sequence: 1 },
    ],
  }
  const completed = update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(completed.pendingSteering).toEqual([{ turnId: "turn-b", text: "for b", sequence: 1 }])
})
test("binds keyed submission drafts and restores only the cancelled turn's draft", () => {
  let model = update({ ...initial("/work"), input: "first prompt" }, { _tag: "Submitted", submissionId: "sub-a" })
  model = { ...model, busy: false, activity: undefined }
  model = update({ ...model, input: "second prompt" }, { _tag: "Submitted", submissionId: "sub-b" })
  model = update(model, { _tag: "SubmissionAdmitted", turnId: "turn-a", submissionId: "sub-a" })
  model = update(model, { _tag: "SubmissionAdmitted", turnId: "turn-b", submissionId: "sub-b" })
  model = update(model, { _tag: "TurnStarted", turnId: "turn-a", prompt: "first prompt" })
  expect(model.submittedDrafts).toEqual([
    { input: "first prompt", attachments: [], cursor: 0, submissionId: "sub-a", turnId: "turn-a" },
    { input: "second prompt", attachments: [], cursor: 0, submissionId: "sub-b", turnId: "turn-b" },
  ])
  const cancelled = update(model, {
    _tag: "ExecutionCancelled",
    turnId: "turn-a",
    agentResponseArrived: false,
  })
  expect(cancelled.input).toBe("first prompt")
  expect(cancelled.submittedDrafts).toEqual([
    { input: "second prompt", attachments: [], cursor: 0, submissionId: "sub-b", turnId: "turn-b" },
  ])
})
