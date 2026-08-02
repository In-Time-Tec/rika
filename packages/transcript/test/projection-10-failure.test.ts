import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"

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
})
