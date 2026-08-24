import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { modelResponse, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"
import { Prompt } from "effect/unstable/ai"

describe("TenetKit tree projector parent attribution", () => {
  it("attributes a child unit to its subagent card when the child streams before ChildLinked", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-early", "delegate this")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "provider-call-1",
        name: "run_child",
        params: { selection: "Surgeon", prompt: "Fix the projection defect" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    projector.apply(
      treeEvent(
        "raw-child-run",
        { _tag: "TurnStarted", turn: 0 },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    projector.apply(
      modelResponse(
        "raw-child-run",
        { type: "text", text: "child report", metadata: {} },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const card = projector
      .snapshot()
      .units.find((value) => value.content._tag === "Block" && value.content.block._tag === "SubagentCard")
    const before = projector
      .snapshot()
      .units.find((value) => value.content._tag === "Entry" && value.content.text.includes("child report"))
    expect(before?.parentId).toBeUndefined()
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-child-run",
        invocationId: "provider-call-1",
        selection: "Surgeon",
        prompt: Prompt.make("Fix the projection defect"),
        childDepth: 1,
        readiness: "ready",
      }),
    )
    const repaired = projector
      .snapshot()
      .units.find((value) => value.content._tag === "Entry" && value.content.text.includes("child report"))
    const blockId =
      card?.content._tag === "Block" && "id" in card.content.block ? String(card.content.block.id) : undefined
    expect(blockId).toBeDefined()
    expect(repaired?.parentId).toBe(blockId)
  })

  it("keeps the child-to-card link across a checkpoint taken after the subagent settled", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-resume", "delegate this")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "provider-call-1",
        name: "run_child",
        params: { selection: "Surgeon", prompt: "Fix the projection defect" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-child-run",
        invocationId: "provider-call-1",
        selection: "Surgeon",
        prompt: Prompt.make("Fix the projection defect"),
        childDepth: 1,
        readiness: "ready",
      }),
    )
    projector.apply(
      treeEvent(
        "raw-child-run",
        { _tag: "TurnStarted", turn: 0 },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    projector.apply(
      treeEvent(
        "raw-child-run",
        {
          _tag: "RunCompleted",
          result: { text: "", turns: 1, session: { sessionId: "raw-child-run:session", leafId: null } },
        },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const settled = projector.snapshot()
    const resumed = TreeProjector.make("turn-resume", "delegate this", settled.checkpoint, settled.units)
    resumed.apply(
      modelResponse(
        "raw-child-run",
        { type: "text", text: "late child report", metadata: {} },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const late = resumed
      .snapshot()
      .units.find((value) => value.content._tag === "Entry" && value.content.text.includes("late child report"))
    expect(late?.parentId).toBeDefined()
  })
})
