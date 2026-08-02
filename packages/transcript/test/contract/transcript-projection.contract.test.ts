import { describe, expect, it } from "vitest"
import { Presentation as directPresentation } from "../../src/schema/transcript-presentation-model"
import { Projection as directProjection } from "../../src/schema/transcript-projection-model"
import { Unit as directUnit } from "../../src/schema/transcript-unit"
import * as DirectTranscriptProjection from "../../src/projection/transcript-projection"
import { Projection as exportedProjection } from "@rika/transcript/transcript-projection-model"
import { Presentation as exportedPresentation } from "@rika/transcript/transcript-presentation-model"
import { Unit as exportedUnit } from "@rika/transcript/transcript-unit"
import * as ExportedTranscriptProjection from "@rika/transcript/transcript-projection"

describe("transcript export contracts", () => {
  it("uses one schema identity for each frozen schema path", () => {
    expect(exportedPresentation).toBe(directPresentation)
    expect(exportedProjection).toBe(directProjection)
    expect(exportedUnit).toBe(directUnit)
  })

  it("uses one projection function identity for the public and source paths", () => {
    expect(ExportedTranscriptProjection.Projection.applyEvent).toBe(DirectTranscriptProjection.Projection.applyEvent)
  })
})
