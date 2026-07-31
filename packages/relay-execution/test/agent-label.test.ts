import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import { describe, expect, it } from "vitest"
import { names } from "../src/agent-profiles"

const expected: Readonly<Record<string, string>> = {
  Oracle: "Oracle exploring",
  Librarian: "Librarian researching",
  Painter: "Painter working",
  Review: "Reviewing code",
  ReadThread: "Reading Thread",
  Surgeon: "Surgeon operating",
  Task: "Subagent working",
}

const spellings = (profile: string, depth: number): ReadonlyArray<string> => [
  profile,
  `${profile}:${depth}`,
  `rika-${profile}`,
  `rika-${profile}:${depth}`,
  profile.toLowerCase(),
  `${profile.toLowerCase()}:${depth}`,
]

describe("agent labels", () => {
  it("never leaks a depth suffix into a label", () => {
    for (const profile of names)
      for (const depth of [1, 2])
        for (const spelling of spellings(profile, depth)) {
          const presentation = Catalog.resolveAgentPresentation(spelling)
          expect(presentation.activeLabel, spelling).not.toMatch(/:\d/)
          expect(presentation.completeLabel, spelling).not.toMatch(/:\d/)
          expect(Catalog.agentDisplay(spelling), spelling).not.toMatch(/:\d/)
          for (const status of ["running", "complete", "failed", "cancelled"] as const)
            expect(Catalog.agentPhrase({ name: spelling, status }), `${spelling} ${status}`).not.toMatch(/:\d/)
        }
  })

  it("resolves every profile to its registered label at every depth", () => {
    for (const profile of names)
      for (const depth of [1, 2])
        for (const spelling of spellings(profile, depth))
          expect(Catalog.resolveAgentPresentation(spelling).activeLabel, spelling).toBe(expected[profile])
  })

  it("resolves generic child names to the subagent label", () => {
    for (const name of ["", "child", "task", "subagent", "Task:1", "Task:2", "rika-task:1"])
      expect(Catalog.resolveAgentPresentation(name).activeLabel, name).toBe("Subagent working")
  })

  it("routes delegation tool names through the same labels", () => {
    for (const profile of names)
      for (const depth of [1, 2])
        expect(Catalog.resolvePresentation(`transfer_to_${profile.toLowerCase()}:${depth}`).activeLabel).toBe(
          expected[profile],
        )
  })

  it("phrases terminal states from the profile display name", () => {
    expect(Catalog.agentPhrase({ name: "Task:1", status: "cancelled" })).toBe("Subagent cancelled")
    expect(Catalog.agentPhrase({ name: "Task:1", status: "failed" })).toBe("Subagent failed")
    expect(Catalog.agentPhrase({ name: "Task:1", status: "complete" })).toBe("Subagent finished")
    expect(Catalog.agentPhrase({ name: "Oracle:2", status: "complete" })).toBe("Oracle has spoken")
    expect(Catalog.agentPhrase({ name: "ReadThread:1", status: "cancelled" })).toBe("ReadThread cancelled")
  })
})
