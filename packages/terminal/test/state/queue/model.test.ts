import "./submission.fixture"
import { expect, test } from "vitest"

import { applyQueueDelta, resetQueue } from "../../../src/state/queue/model"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"

import { key, _thread, _editFile, _busyQueueModel } from "./model.fixture"
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
    {
      ...initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      currentThreadId: "thread",
      input: "prompt",
    },
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
test("admission corrects stale optimistic lane predictions in both directions", () => {
  const predictedDirect = update(
    { ...initial("/work"), input: "actually queued" },
    { _tag: "Submitted", submissionId: "sub-queued" },
  )
  const queued = update(predictedDirect, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-queued",
    status: "queued",
    submissionId: "sub-queued",
  })
  expect(queued.entries).toEqual([])
  expect(queued.items).toEqual([])
  expect(queued.queue).toEqual([{ id: "turn-queued", prompt: "actually queued", provisional: true }])

  const predictedQueued = update(
    { ...initial("/work"), busy: true, activeTurnId: "old", input: "actually active" },
    { _tag: "Submitted", submissionId: "sub-active" },
  )
  const active = update(predictedQueued, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-active",
    status: "active",
    submissionId: "sub-active",
  })
  expect(active.queue).toEqual([])
  expect(active.entries).toEqual([{ role: "user", text: "actually active", turnId: "turn-active" }])
  expect(active.items).toHaveLength(1)
  expect(active.items[0]).toMatchObject({
    _tag: "Entry",
    turnId: "turn-active",
    provisional: true,
  })
})
test("provisional queue rows ignore edit, steer, and dequeue keys", () => {
  const busy: Model = resetQueue(
    {
      ...initial("/work"),
      busy: true,
      activeTurnId: "turn-a",
      currentThreadId: "thread",
      input: "prompt",
    },
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
test("steering a selected queued message projects the handoff until authoritative acceptance", () => {
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
  const steered = update(busy, {
    _tag: "KeyPressed",
    key: key({ name: "return" }),
    steeringRequestId: "request-1",
  })
  expect(steered.pendingSteering).toEqual([])
  expect(steered.steeringRequests).toEqual([
    {
      requestId: "request-1",
      turnId: "turn-a",
      text: "steer me please",
      origin: "queue",
      queuedTurnId: "queued-1",
    },
  ])
  expect(steered.queueSelection).toBeUndefined()
  expect(steered.pendingAction).toEqual({
    _tag: "SteerQueued",
    id: "queued-1",
    prompt: "steer me please",
    requestId: "request-1",
  })
})
test("keeps the active turn running and restores text when steering fails", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    steeringRequests: [
      {
        requestId: "request-1",
        turnId: "turn-a",
        text: "focus on the fixture",
        origin: "composer",
      },
    ],
  }
  const failed = update(busy, {
    _tag: "SteeringFailed",
    requestId: "request-1",
    message: "Execution did not become available for steering",
  })
  expect(failed.busy).toBe(true)
  expect(failed.activeTurnId).toBe("turn-a")
  expect(failed.steeringRequests).toEqual([])
  expect(failed.input).toBe("focus on the fixture")
  expect(failed.blocks).toContainEqual(expect.objectContaining({ _tag: "Error", title: "Steering not delivered" }))
})
test("ignores steering failures for an unknown request identity", () => {
  const active: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-b",
    steeringRequests: [{ requestId: "request-b", turnId: "turn-b", text: "for b", origin: "composer" }],
  }
  const failed = update(active, {
    _tag: "SteeringFailed",
    requestId: "request-a",
    message: "late failure",
  })
  expect(failed).toEqual(active)
})
test("does not duplicate a restored queued steer in the composer", () => {
  const active: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    queue: [{ id: "queued-a", prompt: "queued text" }],
    steeringRequests: [
      {
        requestId: "request-a",
        turnId: "turn-a",
        text: "queued text",
        origin: "queue",
        queuedTurnId: "queued-a",
      },
    ],
  }
  const failed = update(active, {
    _tag: "SteeringFailed",
    requestId: "request-a",
    message: "turn settled",
  })
  expect(failed.steeringRequests).toEqual([])
  expect(failed.queue).toEqual(active.queue)
  expect(failed.input).toBe("")
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
test("settles cancellation after a queued turn promotes before the response arrives", () => {
  const promoted: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-b",
    cancelPending: true,
  }
  const cancelled = update(promoted, {
    _tag: "ExecutionCancelled",
    turnId: "turn-a",
    agentResponseArrived: false,
  })
  expect(cancelled).toMatchObject({ busy: true, activeTurnId: "turn-b", cancelPending: false })

  const failed = update(promoted, {
    _tag: "CancelFailed",
    turnId: "turn-a",
    message: "turn settled before cancellation",
  })
  expect(failed).toMatchObject({ busy: true, activeTurnId: "turn-b", cancelPending: false })
  expect(failed.blocks).toContainEqual(expect.objectContaining({ _tag: "Error", title: "Cancellation not completed" }))
})
test("targets an unresolved submission when Ctrl+C arrives before Turn admission", () => {
  const submitted = update(
    { ...initial("/work"), currentThreadId: "thread-a", input: "pending prompt" },
    { _tag: "Submitted", submissionId: "submission-pending" },
  )
  const cancelled = update(submitted, { _tag: "KeyPressed", key: key({ name: "c", ctrl: true }) })
  expect(cancelled.cancelPending).toBe(true)
  expect(cancelled.pendingAction).toEqual({
    _tag: "Cancel",
    submissionId: "submission-pending",
    threadId: "thread-a",
  })
  const started = update(cancelled, {
    _tag: "TurnStarted",
    turnId: "turn-pending",
    prompt: "pending prompt",
    submissionId: "submission-pending",
  })
  expect(started.cancelPending).toBe(true)
})
test("preserves steering rows across terminal events until authoritative disposition arrives", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    pendingSteering: [
      {
        runId: "run-a",
        entryId: "entry-a",
        requestId: "request-a",
        turnId: "turn-a",
        sequence: 0,
        text: "left behind",
      },
    ],
    steeringRequests: [{ requestId: "local-a", turnId: "turn-a", text: "local", origin: "composer" }],
  }
  const completed = update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(completed.pendingSteering).toEqual(busy.pendingSteering)
  expect(completed.steeringRequests).toEqual(busy.steeringRequests)
  expect(completed.input).toBe("")
  const occupied = update({ ...busy, input: "typing" }, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(occupied.pendingSteering).toEqual(busy.pendingSteering)
  expect(occupied.steeringRequests).toEqual(busy.steeringRequests)
  expect(occupied.input).toBe("typing")
})
test("does not infer steering disposition for any turn when one turn settles", () => {
  const busy: Model = {
    ...initial("/work"),
    busy: true,
    activeTurnId: "turn-a",
    pendingSteering: [
      {
        runId: "run-a",
        entryId: "entry-a",
        requestId: "request-a",
        turnId: "turn-a",
        sequence: 0,
        text: "for a",
      },
      {
        runId: "run-b",
        entryId: "entry-b",
        requestId: "request-b",
        turnId: "turn-b",
        sequence: 0,
        text: "for b",
      },
    ],
  }
  const completed = update(busy, { _tag: "ExecutionCompleted", turnId: "turn-a" })
  expect(completed.pendingSteering).toEqual(busy.pendingSteering)
})
