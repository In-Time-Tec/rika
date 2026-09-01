import { describe, expect, it } from "vitest"
import {
  agentDisplay,
  agentPhrase,
  agentProfile,
  resolveAgentPresentation,
  subagentPhrase,
} from "@rika/transcript/subagent-presentation"

describe("subagent presentation", () => {
  it("normalizes durable agent identities for display", () => {
    expect(agentProfile(" rika-oracle:12 ")).toBe("oracle")
    expect(agentDisplay("rika-task:4")).toBe("Subagent")
    expect(agentDisplay("rika-librarian:2")).toBe("Librarian")
  })

  it("preserves the specialist presentation phrases", () => {
    expect(resolveAgentPresentation("Oracle")).toMatchObject({
      family: "agent",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    })
    expect(agentPhrase({ name: "rika-surgeon:1", status: "complete" })).toBe("Surgeon closed up")
    expect(subagentPhrase("rika-task:1", "queued")).toBe("Subagent queued")
  })
})
