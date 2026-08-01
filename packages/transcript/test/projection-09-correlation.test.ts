import { describe, expect, it } from "@effect/vitest"
import { childParentMatch } from "../src/ordering/child-parent-correlation"

describe("Transcript projection", () => {
  it("matches a child to its scoped parent tool and rejects a same-callId tool in another scope", () => {
    const foreign = { id: "other:spawn", scope: "other", childId: undefined, family: "agent" as const, mark: "foreign" }
    const correct = {
      id: "parent:spawn",
      scope: "parent",
      childId: undefined,
      family: "agent" as const,
      mark: "correct",
    }
    const childId = "execution:parent:child:spawn"

    expect(childParentMatch([foreign, correct], childId)?.mark).toBe("correct")
    expect(childParentMatch([foreign], childId)).toBeUndefined()
  })

  it("prefers an exact childId match over a scoped fallback candidate", () => {
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
  })

  it("ignores a non-agent tool even when its scope and call id match the child key", () => {
    const nonAgent = { id: "parent:spawn", scope: "parent", childId: undefined, family: "shell" as const }

    expect(childParentMatch([nonAgent], "execution:parent:child:spawn")).toBeUndefined()
  })

  it("matches a scoped parent for the url-encoded child id encoding without a spawn correlation", () => {
    const parent = { id: "parent-turn:agent", scope: "parent-turn", childId: undefined, family: "agent" as const }

    expect(childParentMatch([parent], "child:execution%3Aparent-turn:agent")).toBe(parent)
  })

  it("resolves a nested fan-out child id to its correctly scoped orchestrator tool", () => {
    const orchestratorId = "child:execution%3Aturn:rika:execution%3Aturn:call-orchestrator"
    const nestedId = `child:${encodeURIComponent(orchestratorId)}:rika:${encodeURIComponent(orchestratorId)}:one`
    const nestedTool = {
      id: `${orchestratorId}:one`,
      scope: orchestratorId,
      childId: undefined,
      family: "agent" as const,
    }
    const foreign = {
      id: "other-turn:one",
      scope: "other-turn",
      childId: undefined,
      family: "agent" as const,
    }

    expect(childParentMatch([foreign, nestedTool], nestedId)).toBe(nestedTool)
  })

  it("rejects a same-callId tool in another scope for the url-encoded encoding", () => {
    const foreign = { id: "other-turn:agent", scope: "other-turn", childId: undefined, family: "agent" as const }

    expect(childParentMatch([foreign], "child:execution%3Aparent-turn:agent")).toBeUndefined()
  })
})
