import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../src/baton-tree-projector"
import { modelPart, resetEventPosition, treeEvent } from "./baton-projector-event-fixtures"

describe("Baton tree projector parent attribution", () => {
  it("attributes a child unit to its subagent card when the child streams before ChildLinked", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-early", "delegate this")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.apply(
      modelPart("raw-root-run", {
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
      modelPart(
        "raw-child-run",
        { type: "text-delta", id: "child-text", delta: "child report" },
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
      } as never),
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
      modelPart("raw-root-run", {
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
      } as never),
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
        { _tag: "RunCompleted", status: "succeeded", terminalEventId: "terminal-1" } as never,
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const settled = projector.snapshot()
    const resumed = TreeProjector.make("turn-resume", "delegate this", settled.checkpoint, settled.units)
    resumed.apply(
      modelPart(
        "raw-child-run",
        { type: "text-delta", id: "late-text", delta: "late child report" },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const late = resumed
      .snapshot()
      .units.find((value) => value.content._tag === "Entry" && value.content.text.includes("late child report"))
    expect(late?.parentId).toBeDefined()
  })
})
