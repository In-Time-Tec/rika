import { describe, expect, it } from "vitest"
import { nativeToolInstructions } from "../src/agent-instructions"
import { agentInstructionsWith } from "../src/routing/route"

const surface = nativeToolInstructions("/workspace")

describe("agent instructions", () => {
  it("gives every conversational agent the exact native workspace surface", () => {
    const oracle = "Analyze the supplied problem deeply."
    expect(agentInstructionsWith(surface, oracle)).toContain(surface)
    expect(agentInstructionsWith(surface, oracle)).toContain(oracle)
  })

  it("advertises exactly the four registered workspace tools", () => {
    expect(surface.split("\n")[0]).toBe(
      "You have exactly four native workspace tools: read, edit, bash, and shell_command_status.",
    )
    expect(surface).not.toContain("typescript")
    expect(surface).not.toContain("kernel")
  })

  it("keeps logical remote workspace identities out of filesystem guidance", () => {
    const remote = nativeToolInstructions()
    expect(remote).toContain("Omit workdir to use that root")
    expect(remote).not.toContain("runner:")
  })

  it("leaves the title agent that has no tools with its own instruction", () => {
    const title = "Return a concise title for the supplied request and nothing else."
    expect(agentInstructionsWith(surface, title)).toBe(title)
  })
})
