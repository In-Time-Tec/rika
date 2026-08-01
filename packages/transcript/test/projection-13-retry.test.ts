import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("shows a notice when a model attempt is retried after the stream was cut off", () => {
    const truncated: SourceEvent = {
      cursor: "truncated",
      sequence: 4,
      type: "model.attempt.failed",
      createdAt: 4,
      data: { category: "truncated-stream", classification: "transient" },
    }
    const projection = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
      truncated,
    )
    expect(projection.units.map((unit) => unit.content)).toContainEqual({
      _tag: "Block",
      block: {
        _tag: "Notification",
        title: "Model response was cut off",
        detail: "The provider ended the response before it finished. Rika is retrying that step.",
      },
    })
  })

  it("stays silent for model failures that are not a cut-off stream", () => {
    const failed: SourceEvent = {
      cursor: "rate-limit",
      sequence: 4,
      type: "model.attempt.failed",
      createdAt: 4,
      data: { category: "rate-limit", classification: "transient" },
    }
    const projection = TranscriptProjection.Projection.applyEvent(
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
      failed,
    )
    expect(
      projection.units.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Notification"),
    ).toBe(false)
  })

  it("does not rewrite a cut-off execution failure into a complete turn", () => {
    const events: ReadonlyArray<SourceEvent> = [
      { cursor: "text", sequence: 1, type: "model.output.completed", createdAt: 1, text: "partial answer" },
      {
        cursor: "failed",
        sequence: 2,
        type: "execution.failed",
        createdAt: 2,
        text: "The model stream ended before it finished.",
        data: { details: { failure_classification: "truncated-stream" } },
      },
    ]
    const projection = events.reduce(
      (current, event) => TranscriptProjection.Projection.applyEvent(current, event),
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
    )
    const outcome = projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome
    expect(outcome).toMatchObject({ status: "failed" })
  })
})
