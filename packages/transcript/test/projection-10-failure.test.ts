import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import type { SourceEvent } from "../src/schema/transcript-source-event"

describe("Transcript projection", () => {
  it("records one error unit with a failed outcome and a non-empty reason when the execution fails", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      { cursor: "failed", sequence: 1, type: "execution.failed", createdAt: 1, text: "internal tool failed" },
    ])
    const errors = projection.units.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error",
    )

    expect(errors).toHaveLength(1)
    const error = errors[0]!
    expect(
      error.content._tag === "Block" && error.content.block._tag === "Error" ? error.content.block.detail : "",
    ).toBe("internal tool failed")
    expect(error.executionOutcome).toMatchObject({ status: "failed", reason: "internal tool failed" })
  })

  it("preserves a terminal model failure across a checkpoint and presents an actionable cause", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "attempt-failed",
        sequence: 1,
        type: "model.attempt.failed",
        createdAt: 1,
        data: {
          model_call_id: "call-1",
          category: "authentication",
          classification: "terminal",
          provider: "openai",
          model: "gpt-test",
        },
      },
      {
        cursor: "call-failed",
        sequence: 2,
        type: "model.call.failed",
        createdAt: 2,
        data: {
          model_call_id: "call-1",
          category: "authentication",
          classification: "terminal",
          purpose: "conversation",
          attempts: 3,
        },
      },
    ]
    const checkpoint = events.reduce(
      (projection, event) => TranscriptProjection.Projection.applyEvent(projection, event),
      TranscriptProjection.Projection.empty("turn-a", "prompt"),
    )

    expect(checkpoint.modelFailure).toEqual({
      modelCallId: "call-1",
      category: "authentication",
      classification: "terminal",
      purpose: "conversation",
      attempts: 3,
      provider: "openai",
      model: "gpt-test",
    })

    const projection = TranscriptProjection.Projection.applyEvent(checkpoint, {
      cursor: "execution-failed",
      sequence: 3,
      type: "execution.failed",
      createdAt: 3,
      text: "The provider rejected the credential.",
    })
    const error = projection.units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error")
    expect(error?.content).toEqual({
      _tag: "Block",
      block: {
        _tag: "Error",
        title: "Model authentication failed",
        detail: "The provider rejected the credential.\nProvider: openai\nModel: gpt-test\nAttempts: 3",
        turnId: "turn-a",
        recovery: "Check the provider credential, restart Rika, then press Enter to retry.",
      },
    })
    expect(projection.modelFailure).toBeUndefined()
  })
})
