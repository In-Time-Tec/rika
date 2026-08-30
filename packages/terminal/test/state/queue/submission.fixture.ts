import { expect, test } from "vitest"

import { overlayPendingSubmissions } from "../../../src/state/submission"
import { initial } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"

import { _thread, _editFile, _busyQueueModel } from "./model.fixture"
test("blocks a duplicate submission while admission is pending", () => {
  const submitted = update({ ...initial("/work"), input: "first prompt" }, { _tag: "Submitted", submissionId: "sub-a" })
  const duplicate = update({ ...submitted, input: "edited prompt" }, { _tag: "Submitted", submissionId: "sub-b" })
  expect(duplicate.submittedDrafts).toEqual([
    { input: "first prompt", attachments: [], cursor: 0, submissionId: "sub-a" },
  ])
})

test("snapshot overlay restores a pending optimistic prompt onto an empty projection", () => {
  const submitted = update(
    { ...initial("/work"), input: "optimistic prompt", cursor: 17 },
    { _tag: "Submitted", submissionId: "sub-optimistic" },
  )
  const empty = {
    ...submitted,
    entries: [],
    items: [],
    busy: false,
    activity: undefined,
    activeTurnId: undefined,
  }
  const overlaid = overlayPendingSubmissions(empty, submitted)
  expect(overlaid.entries).toEqual([{ role: "user", text: "optimistic prompt" }])
  expect(overlaid.busy).toBe(true)
  expect(overlaid.activity).toEqual({ _tag: "Sending" })
})

test("snapshot overlay keeps a pending optimistic prompt without duplicating an authoritative copy", () => {
  const submitted = update(
    { ...initial("/work"), input: "hello", cursor: 5 },
    { _tag: "Submitted", submissionId: "sub-1" },
  )
  const authoritative = {
    ...submitted,
    entries: [{ role: "user" as const, text: "hello", turnId: "turn-1" }],
    items: [{ _tag: "Entry" as const, index: 0, id: "turn:turn-1:user", turnId: "turn-1" }],
    busy: true,
    activeTurnId: "turn-1",
    activity: { _tag: "Waiting" as const },
  }
  const overlaid = overlayPendingSubmissions(authoritative, submitted)
  expect(overlaid.entries).toEqual([{ role: "user", text: "hello", turnId: "turn-1" }])
  expect(overlaid.items).toHaveLength(1)
})

test("renders a submitted prompt immediately and reconciles it on active admission", () => {
  const submitted = update(
    { ...initial("/work"), input: "optimistic prompt", cursor: 17 },
    { _tag: "Submitted", submissionId: "sub-optimistic" },
  )
  expect(submitted.input).toBe("")
  expect(submitted.cursor).toBe(0)
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
  expect(submitted.busy).toBe(true)
  expect(submitted.activity).toEqual({ _tag: "Sending" })

  const admitted = update(submitted, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-optimistic",
    status: "active",
    submissionId: "sub-optimistic",
  })
  expect(admitted.input).toBe("")
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

test("preserves composer edits made before queued admission", () => {
  const submitted = update(
    { ...initial("/work"), busy: true, activeTurnId: "active", input: "captured", cursor: 8 },
    { _tag: "Submitted", submissionId: "sub-queued" },
  )
  const admitted = update(
    { ...submitted, input: "captured edited", cursor: 15 },
    {
      _tag: "SubmissionAdmitted",
      turnId: "queued",
      status: "queued",
      submissionId: "sub-queued",
    },
  )
  expect(admitted.input).toBe("captured edited")
  expect(admitted.queue).toEqual([{ id: "queued", prompt: "captured", provisional: true }])
  expect(admitted.entries).toEqual([])
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
  expect(occupied.entries).toEqual([])
  expect(occupied.items.at(-1)).toMatchObject({ _tag: "Block" })
})

test("ignores a late or duplicate rejection after a submission is admitted", () => {
  const submitted = update(
    { ...initial("/work"), input: "accepted", cursor: 8 },
    { _tag: "Submitted", submissionId: "sub-accepted" },
  )
  const admitted = update(submitted, {
    _tag: "SubmissionAdmitted",
    turnId: "turn-accepted",
    status: "active",
    submissionId: "sub-accepted",
  })
  const rejected = update(admitted, {
    _tag: "SubmissionRejected",
    message: "late failure",
    submissionId: "sub-accepted",
  })

  expect(rejected).toBe(admitted)
  expect(rejected.entries).toEqual([{ role: "user", text: "accepted", turnId: "turn-accepted" }])
  expect(rejected.blocks).toEqual([])
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
