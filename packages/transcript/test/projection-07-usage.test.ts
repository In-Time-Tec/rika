import { describe, expect, it } from "@effect/vitest"
import type { SourceEvent } from "../src/schema/transcript-source-event"
import * as TranscriptProjection from "../src/projection/transcript-projection"

const usage = (cursor: string, sequence: number): SourceEvent => ({
  cursor,
  sequence,
  type: "model.attempt.completed",
  createdAt: sequence,
  data: {
    provider: "openai",
    model: "gpt-5.6-sol",
    input_tokens: 250_000,
    input_tokens_uncached: 250_000,
    input_tokens_cache_read: 0,
    input_tokens_cache_write: 0,
    output_tokens: 0,
  },
})

describe("Transcript projection", () => {
  it("tracks usage cursors when the revision was poisoned by higher foreign sequences", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "foreign", sequence: 4526, type: "model.output.delta", createdAt: 0, text: "child text" },
      { ...usage("usage-9", 9), createdAt: 1 },
      { ...usage("usage-30", 30), createdAt: 2 },
    ])

    expect(projection.revision).toBe(4526)
    expect(projection.checkpointCursor).toBe("foreign")
    expect(projection.costUsd).toBeUndefined()
    expect(projection.usageCursors).toEqual(["usage-9", "usage-30"])
  })

  it("scopes durable usage identity to the opaque event cursor", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      usage("shared", 9),
      usage("shared", 30),
      usage("other", 31),
    ])

    expect(projection.costUsd).toBeUndefined()
    expect(projection.usageCursors).toEqual(["shared", "other"])
  })

  it("does not estimate transcript dollars from usage reports", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [usage("usage-1", 1)])
    expect(projection.costUsd).toBeUndefined()
    expect(projection.pricingVersion).toBeUndefined()
    expect(projection.usageCursors).toEqual(["usage-1"])
  })

  it("counts duplicate and out-of-order usage events exactly once", () => {
    const first = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
      usage("usage-5", 5),
    )
    const duplicated = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.applyEvent(first, usage("usage-5", 5)),
      usage("usage-5", 2),
    )
    const reordered = TranscriptProjection.Projection.applyEvent(duplicated, usage("usage-2", 2))

    expect(duplicated.costUsd).toBeUndefined()
    expect(reordered.costUsd).toBeUndefined()
    expect(reordered.revision).toBe(5)
    expect(reordered.checkpointCursor).toBe("usage-5")
    expect(reordered.usageCursors).toEqual(["usage-5", "usage-2"])
  })

  it("folds each usage cursor once whether the fold is batched, incremental, or branched", () => {
    const cursors = ["usage-1", "usage-2", "usage-3"]
    const events = cursors.flatMap((cursor, index) => [usage(cursor, index + 1), usage(cursor, index + 1)])
    const batched = TranscriptProjection.Projection.project("turn-a", "prompt", events)
    const incremental = events.reduce(
      (projection, event) => TranscriptProjection.Projection.applyEvent(projection, event),
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
    )
    const shared = TranscriptProjection.Projection.project("turn-a", "prompt", [usage("usage-1", 1)])
    const left = TranscriptProjection.Projection.applyEvent(shared, usage("usage-2", 2))
    const right = TranscriptProjection.Projection.applyEvent(shared, usage("usage-3", 3))
    const rejoined = TranscriptProjection.Projection.applyEvent(left, usage("usage-3", 3))
    const merged = TranscriptProjection.Projection.applyEvent(right, usage("usage-2", 2))
    const detached = TranscriptProjection.Projection.applyEvent(
      { ...shared, usageCursors: [...(shared.usageCursors ?? [])] },
      usage("usage-1", 1),
    )

    expect(batched.usageCursors).toEqual(cursors)
    expect(incremental.usageCursors).toEqual(cursors)
    expect(batched.costUsd).toBeUndefined()
    expect(incremental.costUsd).toBeUndefined()
    expect(shared.usageCursors).toEqual(["usage-1"])
    expect(left.usageCursors).toEqual(["usage-1", "usage-2"])
    expect(right.usageCursors).toEqual(["usage-1", "usage-3"])
    expect(right.costUsd).toBeUndefined()
    expect(rejoined.usageCursors).toEqual(["usage-1", "usage-2", "usage-3"])
    expect(rejoined.costUsd).toBeUndefined()
    expect(merged.usageCursors).toEqual(["usage-1", "usage-3", "usage-2"])
    expect(merged.costUsd).toBeUndefined()
    expect(detached.usageCursors).toEqual(["usage-1"])
    expect(detached.costUsd).toBeUndefined()
  })
})
