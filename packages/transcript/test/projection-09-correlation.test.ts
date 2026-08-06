import { describe, expect, it } from "@effect/vitest"
import { childParentMatch } from "../src/ordering/child-parent-correlation"

describe("Transcript projection", () => {
  it("matches only the tool carrying the explicit child execution id", () => {
    const fallback = {
      id: "parent:spawn",
      scope: "parent",
      childId: undefined,
      family: "agent" as const,
      mark: "fallback",
    }
    const exact = {
      id: "parent:other",
      scope: "parent",
      childId: "execution:parent:child:spawn",
      family: "agent" as const,
      mark: "exact",
    }

    expect(childParentMatch([fallback, exact], "execution:parent:child:spawn")?.mark).toBe("exact")
    expect(childParentMatch([fallback], "execution:parent:child:spawn")).toBeUndefined()
  })
})
