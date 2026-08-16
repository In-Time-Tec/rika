import { Prompt } from "effect/unstable/ai"
import * as Projection from "@rika/product/execution-projection"
import { beforeEach, expect, it } from "@effect/vitest"
import { TreeProjector } from "../src/projection/tree"
import { resetEventPosition, treeEvent } from "./baton-projector-event-fixtures"

const runId = "raw-root-run"

const accepted = (entryId: string, requestId: string, sequence: number, text: string) =>
  treeEvent(runId, {
    _tag: "SteeringAccepted",
    entryId,
    steeringSequence: sequence,
    idempotencyKey: requestId,
    digest: `digest-${entryId}`,
    prompt: Prompt.make(text),
  })

const consumed = (...entryIds: ReadonlyArray<string>) =>
  treeEvent(runId, {
    _tag: "SteeringConsumed",
    entryIds,
    operationId: "model-operation",
  })

const discarded = (reason: "completed" | "failed" | "cancelled", ...entryIds: ReadonlyArray<string>) =>
  treeEvent(runId, { _tag: "SteeringDiscarded", entryIds, reason })

beforeEach(resetEventPosition)

it("persists accepted steering and emits its exact request-keyed user unit only when consumed", () => {
  const projector = TreeProjector.make("turn-steering", "initial")
  const admission = projector.apply(accepted("entry-a", "request-a", 0, "redirect the answer"))
  expect(admission.state.steering.pending).toEqual([
    {
      runId,
      entryId: "entry-a",
      requestId: "request-a",
      sequence: 0,
      text: "redirect the answer",
    },
  ])
  expect(admission.upsert).toEqual([])

  const resumed = TreeProjector.make("turn-steering", "initial", admission.checkpoint, projector.snapshot().units)
  expect(resumed.snapshot().state.steering.pending).toEqual(admission.state.steering.pending)
  const consumption = resumed.apply(consumed("entry-a"))
  expect(consumption.state.steering.pending).toEqual([])
  expect(consumption.state.steering.settled).toEqual([
    { runId, entryId: "entry-a", requestId: "request-a", sequence: 0, outcome: "consumed" },
  ])
  expect(consumption.upsert).toContainEqual(
    expect.objectContaining({
      key: Projection.steeringUnitKey("turn-steering", runId, "request-a", "entry-a", 0),
      content: { _tag: "Entry", role: "user", text: "redirect the answer" },
    }),
  )
  const resumedConsumption = TreeProjector.make(
    "turn-steering",
    "initial",
    consumption.checkpoint,
    resumed.snapshot().units,
  )
  expect(resumedConsumption.snapshot().state.steering.settled).toEqual(consumption.state.steering.settled)
})

it("keeps identical text distinct by durable request identity and consumes in event order", () => {
  const projector = TreeProjector.make("turn-duplicate-steering", "initial")
  projector.applyAll([
    accepted("entry-a", "request-a", 0, "same text"),
    accepted("entry-b", "request-b", 1, "same text"),
  ])
  const consumption = projector.apply(consumed("entry-a", "entry-b"))
  expect(consumption.state.steering.pending).toEqual([])
  expect(
    consumption.upsert
      .filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user")
      .map((unit) => unit.key),
  ).toEqual([
    Projection.steeringUnitKey("turn-duplicate-steering", runId, "request-a", "entry-a", 0),
    Projection.steeringUnitKey("turn-duplicate-steering", runId, "request-b", "entry-b", 1),
  ])
})

it("removes discarded steering without synthesizing a transcript unit", () => {
  const projector = TreeProjector.make("turn-discarded-steering", "initial")
  projector.apply(accepted("entry-a", "request-a", 0, "never consumed"))
  const disposition = projector.apply(discarded("cancelled", "entry-a"))
  expect(disposition.state.steering.pending).toEqual([])
  expect(disposition.state.steering.settled).toEqual([
    { runId, entryId: "entry-a", requestId: "request-a", sequence: 0, outcome: "discarded" },
  ])
  expect(disposition.upsert).toEqual([])
  expect(projector.snapshot().units).not.toContainEqual(
    expect.objectContaining({
      key: Projection.steeringUnitKey("turn-discarded-steering", runId, "request-a", "entry-a", 0),
    }),
  )
})

it("rejects accepted steering that cannot fit the bounded projection checkpoint", () => {
  const oversized = TreeProjector.make("turn-oversized-steering", "initial")
  expect(() =>
    oversized.apply(
      accepted("entry-oversized", "request-oversized", 0, "x".repeat(Projection.SteeringTextMaxCharacters + 1)),
    ),
  ).toThrow(`steering text exceeds ${Projection.SteeringTextMaxCharacters}`)
  expect(oversized.snapshot().state.steering.pending).toEqual([])

  const full = TreeProjector.make("turn-full-steering", "initial")
  const filled = full.applyAll(
    Array.from({ length: Projection.PendingSteeringMaxEntries }, (_, index) =>
      accepted(`entry-${index}`, `request-${index}`, index, `steering ${index}`),
    ),
  )
  expect(filled.state.steering.pending).toHaveLength(Projection.PendingSteeringMaxEntries)
  const resumed = TreeProjector.make("turn-full-steering", "initial", filled.checkpoint, full.snapshot().units)
  expect(resumed.snapshot().state.steering.pending).toHaveLength(Projection.PendingSteeringMaxEntries)
  expect(() =>
    resumed.apply(accepted("entry-overflow", "request-overflow", Projection.PendingSteeringMaxEntries, "one too many")),
  ).toThrow(`pending steering entries exceeds ${Projection.PendingSteeringMaxEntries}`)
  expect(resumed.snapshot().state.steering.pending).toHaveLength(Projection.PendingSteeringMaxEntries)
})


it("projects oversized steering text without applying the user input limit", () => {
  const projector = TreeProjector.make("turn-oversized-accepted", "initial")
  const oversized = "x".repeat(Projection.SteeringTextMaxCharacters + 5_000)
  const admission = projector.apply(accepted("entry-oversized", "request-oversized", 0, oversized))
  expect(admission.state.steering.pending).toEqual([
    { runId, entryId: "entry-oversized", requestId: "request-oversized", sequence: 0, text: oversized },
  ])
  expect(admission.upsert).toEqual([])

  const resumed = TreeProjector.make("turn-oversized-accepted", "initial", admission.checkpoint, projector.snapshot().units)
  expect(resumed.snapshot().state.steering.pending).toEqual(admission.state.steering.pending)
  const consumption = resumed.apply(consumed("entry-oversized"))
  expect(consumption.state.steering.pending).toEqual([])
  expect(consumption.upsert).toContainEqual(
    expect.objectContaining({
      key: Projection.steeringUnitKey("turn-oversized-accepted", runId, "request-oversized", "entry-oversized", 0),
      content: { _tag: "Entry", role: "user", text: oversized },
    }),
  )
})

it("projects oversized message-backed steering delivered by the runtime", () => {
  const projector = TreeProjector.make("turn-message-backed", "initial")
  const body = "y".repeat(Projection.SteeringTextMaxCharacters + 5_000)
  const messageBacked = treeEvent(runId, {
    _tag: "SteeringAccepted",
    entryId: "entry-message",
    steeringSequence: 0,
    idempotencyKey: "message:child-settled:run-child",
    digest: "digest-message",
    prompt: {
      content: [
        {
          options: { baton: { message: { from: "run:run-child", messageId: "child-settled:run-child" } } },
          role: "user",
          content: [{ type: "text", text: body }],
        },
      ],
    } as never,
  })
  const admission = projector.apply(messageBacked)
  expect(admission.state.steering.pending).toEqual([
    { runId, entryId: "entry-message", requestId: "message:child-settled:run-child", sequence: 0, text: body },
  ])
  const consumption = projector.apply(consumed("entry-message"))
  expect(consumption.upsert).toContainEqual(
    expect.objectContaining({
      key: Projection.steeringUnitKey("turn-message-backed", runId, "message:child-settled:run-child", "entry-message", 0),
      content: { _tag: "Entry", role: "user", text: body },
    }),
  )
})
