import { describe, expect, it } from "vitest"
import { agentInstructionsWith } from "../src/baton-route"

const surface = "//   rika.workspace -> read({ path })"

describe("agent instructions", () => {
  it("gives an agent that runs cells the surface its cells reach", () => {
    // The root was told and the profiles beneath it were not, which is the same defect one level
    // down: every agent holding the cell tool needs the description, not just the one that spawns.
    const oracle = "Analyze the supplied problem deeply."
    expect(agentInstructionsWith(surface, oracle)).toContain(surface)
    expect(agentInstructionsWith(surface, oracle)).toContain(oracle)
  })

  it("leaves the agent that runs no cells with its own instruction", () => {
    const title = "Return a concise title for the supplied request and nothing else."
    expect(agentInstructionsWith(surface, title)).toBe(title)
  })
})
