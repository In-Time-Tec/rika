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
  expect(active.items[0]).toMatchObject({ _tag: "Entry", turnId: "turn-active", provisional: true })
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
test("steering a selected queued message keeps the request local until authoritative acceptance", () => {
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
  expect(steered.steeringRequests).toEqual([])
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
  expect(failed.blocks).toContainEqual(
    expect.objectContaining({ _tag: "Notification", title: "Steering not delivered" }),
  )
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

test("echoes an idle submission immediately and reconciles admission and start in place", () => {
  const submitted = update(
    { ...initial("/work"), input: "optimistic prompt", cursor: 17 },
    { _tag: "Submitted", submissionId: "sub-optimistic" },
  )
  expect(submitted.entries).toEqual([{ role: "user", text: "optimistic prompt" }])
  expect(submitted.items).toEqual([
    {
      _tag: "Entry",
      index: 0,
      id: "submission:sub-optimistic:user",
      submissionId: "sub-optimistic",
      provisional: true,
    },
  ])

  const admitted = update(submitted, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-optimistic",
    status: "active",
    submissionId: "sub-optimistic",
  })
  expect(admitted.entries).toEqual([{ role: "user", text: "optimistic prompt", turnId: "turn-optimistic" }])
  expect(admitted.items).toEqual([
    {
      _tag: "Entry",
      index: 0,
      id: "turn:turn-optimistic:user",
      turnId: "turn-optimistic",
      submissionId: "sub-optimistic",
      provisional: true,
    },
  ])

  const started = update(admitted, {
    _tag: "TurnStarted",
    turnId: "turn-optimistic",
    prompt: "optimistic prompt",
    submissionId: "sub-optimistic",
  })
  const repeated = update(started, {
    _tag: "TurnStarted",
    turnId: "turn-optimistic",
    prompt: "optimistic prompt",
    submissionId: "sub-optimistic",
  })
  expect(repeated.entries).toEqual([{ role: "user", text: "optimistic prompt", turnId: "turn-optimistic" }])
  expect(repeated.items).toEqual([
    {
      _tag: "Entry",
      index: 0,
      id: "turn:turn-optimistic:user",
      turnId: "turn-optimistic",
      submissionId: "sub-optimistic",
    },
  ])
})

test("reconciles a start that arrives before admission without duplicating the optimistic row", () => {
  const submitted = update(
    { ...initial("/work"), input: "start first" },
    { _tag: "Submitted", submissionId: "sub-start-first" },
  )
  const started = update(submitted, {
    _tag: "TurnStarted",
    turnId: "turn-start-first",
    prompt: "start first",
    submissionId: "sub-start-first",
  })
  const admitted = update(started, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-start-first",
    status: "active",
    submissionId: "sub-start-first",
  })

  expect(admitted.entries).toEqual([{ role: "user", text: "start first", turnId: "turn-start-first" }])
  expect(admitted.items).toHaveLength(1)
  expect(admitted.items[0]).not.toMatchObject({ provisional: true })
})

test("restores a rejected optimistic submission only when the composer is empty", () => {
  const submit = (input: string, submissionId: string) =>
    update({ ...initial("/work"), input, cursor: input.length }, { _tag: "Submitted", submissionId })

  const restored = update(submit("retry me", "sub-retry"), {
    _tag: "SubmissionRejected",
    message: "Queue full",
    submissionId: "sub-retry",
  })
  expect(restored.input).toBe("retry me")
  expect(restored.entries).toEqual([])
  expect(restored.submittedDrafts).toEqual([])
  expect(restored.blocks.at(-1)).toMatchObject({ _tag: "Error", detail: "Queue full" })

  const occupied = update(
    { ...submit("do not lose me", "sub-occupied"), input: "new composer text", cursor: 17 },
    { _tag: "SubmissionRejected", message: "Queue full", submissionId: "sub-occupied" },
  )
  expect(occupied.input).toBe("new composer text")
  expect(occupied.entries).toEqual([{ role: "user", text: "do not lose me" }])
  expect(occupied.items[0]).not.toMatchObject({ provisional: true })
})

test("cancelling before turn start restores or settles the optimistic row without clobbering typing", () => {
  const submitted = update(
    { ...initial("/work"), input: "cancel before start", cursor: 19 },
    { _tag: "Submitted", submissionId: "sub-cancel" },
  )
  const admitted = update(submitted, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-cancel",
    status: "active",
    submissionId: "sub-cancel",
  })
  const occupied = update(
    { ...admitted, input: "keep this draft", cursor: 15 },
    { _tag: "ExecutionCancelled", turnId: "turn-cancel", agentResponseArrived: false },
  )

  expect(occupied.input).toBe("keep this draft")
  expect(occupied.entries).toEqual([{ role: "user", text: "cancel before start", turnId: "turn-cancel" }])
  expect(occupied.items[0]).not.toMatchObject({ provisional: true })
  expect(occupied.submittedDrafts).toEqual([])
})
