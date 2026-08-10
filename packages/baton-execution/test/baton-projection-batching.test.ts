import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { batchProjectionEvents } from "../src/baton-projection-batching"
import { TreeProjector } from "../src/baton-tree-projector"
import { modelPart, resetEventPosition, treeEvent } from "./baton-projector-event-fixtures"

const cellCall = (id: string) => ({
  type: "tool-call" as const,
  id,
  name: "typescript",
  params: { code: "1 + 1" },
  providerExecuted: false,
  metadata: {},
})

const textParts = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    modelPart("raw-root-run", { type: "text-delta", id: "text", delta: String(index) }),
  )

describe("Baton projection batching", () => {
  it("matches sequential projection state and revisions while serializing one checkpoint", () => {
    resetEventPosition()
    const events = [
      treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 } as never),
      ...textParts(12),
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionStarted",
        turn: 0,
        call: cellCall("cell-1"),
      } as never),
      treeEvent("raw-root-run", { _tag: "RunCancelled", reason: "stopped" } as never),
    ]
    const sequential = TreeProjector.make("turn-batched", "batch this")
    for (const event of events) sequential.apply(event)

    const batched = TreeProjector.make("turn-batched", "batch this")
    const stringify = vi.spyOn(JSON, "stringify")
    const patch = batched.applyAll(events)
    const serializations = stringify.mock.calls.length
    stringify.mockRestore()

    expect(serializations).toBe(1)
    expect(patch).toMatchObject({ baseRevision: 0, revision: events.length })
    expect(batched.snapshot()).toEqual(sequential.snapshot())
  })

  it.effect("coalesces token parts at the 25ms window", () =>
    Effect.gen(function* () {
      resetEventPosition()
      const events = textParts(12)
      const fiber = yield* Stream.fromIterable(events).pipe(
        Stream.concat(Stream.never),
        batchProjectionEvents,
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("25 millis")
      const batches = yield* Fiber.join(fiber)
      expect(batches).toHaveLength(1)
      expect(batches[0]).toEqual(events)
    }),
  )

  it.effect("flushes cell, authorization, run, and cancellation boundaries without waiting for the window", () =>
    Effect.gen(function* () {
      resetEventPosition()
      const events = [
        ...textParts(10),
        treeEvent("raw-root-run", {
          _tag: "ToolExecutionStarted",
          turn: 0,
          call: cellCall("cell-boundary"),
        } as never),
        ...textParts(10),
        treeEvent("raw-root-run", { _tag: "ApprovalRequested" } as never),
        ...textParts(10),
        treeEvent("raw-root-run", { _tag: "RunCompleted" } as never),
        ...textParts(10),
        treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "stop" } as never),
      ]
      const batches = yield* batchProjectionEvents(Stream.fromIterable(events)).pipe(Stream.runCollect)
      expect(batches.map((batch) => batch.length)).toEqual([11, 11, 11, 11])
      expect(batches.map((batch) => batch.at(-1)!.event._tag)).toEqual([
        "ToolExecutionStarted",
        "ApprovalRequested",
        "RunCompleted",
        "RunCancellationRequested",
      ])
    }),
  )

  it("keeps patch revisions monotone across batches", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-monotone", "batch this")
    const firstEvents = textParts(10)
    const first = projector.applyAll(firstEvents)
    const second = projector.applyAll([
      treeEvent("raw-root-run", { _tag: "RunCancellationRequested", reason: "stop" } as never),
    ])
    expect([first.baseRevision, first.revision, second.baseRevision, second.revision]).toEqual([0, 10, 10, 11])
    expect(Math.max(...second.upsert.map((unit) => unit.revision))).toBe(11)
  })
})
