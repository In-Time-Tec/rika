import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../src/projection/tree"
import { block, modelResponse, resetEventPosition, treeEvent } from "./baton-projector-event-fixtures"

describe("Baton subagent card projection", () => {
  it("shows a run_child prompt immediately, nests child output, and treats completion as settlement only", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-one", "delegate this")
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    const requested = projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "provider-call-1",
        name: "run_child",
        params: { selection: "Surgeon", prompt: "Fix the projection defect" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    const cardUnit = requested.upsert.find(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
    )
    expect(cardUnit?.content).toEqual({
      _tag: "Block",
      block: expect.objectContaining({
        _tag: "SubagentCard",
        name: "Surgeon",
        prompt: "Fix the projection defect",
        status: "running",
      }),
    })
    expect(JSON.stringify(cardUnit)).not.toContain("raw-root-run")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-child-run",
        invocationId: "provider-call-1",
      }),
    )
    projector.apply(
      treeEvent(
        "raw-child-run",
        { _tag: "TurnStarted", turn: 0 },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const childText = projector.apply(
      modelResponse(
        "raw-child-run",
        { type: "text", text: "Child result", metadata: {} },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const assistant = childText.upsert.find(
      (unit) => unit.content._tag === "Entry" && unit.content.role === "assistant",
    )
    expect(assistant?.parentId).toBe(
      cardUnit?.content._tag === "Block" && cardUnit.content.block._tag === "SubagentCard"
        ? cardUnit.content.block.id
        : undefined,
    )
    const completed = projector.apply(
      treeEvent(
        "raw-child-run",
        { _tag: "RunCompleted", result: { text: "aggregate child output", turns: 1, transcript: [] as never } },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    expect(
      completed.upsert.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant"),
    ).toHaveLength(0)
    expect(block(completed, "SubagentCard")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ status: "complete", summary: "" }),
    })
    const snapshot = projector.snapshot()
    expect(
      snapshot.units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant"),
    ).toHaveLength(1)
    expect(JSON.stringify(snapshot.units)).not.toContain("raw-child-run")
  })

  it("creates initial child cards from canonical linked selection and prompt", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-initial", "review")
    const linked = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-review-run",
        invocationId: "review:correctness",
        selection: "Review",
        prompt: [{ role: "user", content: [{ type: "text", text: "Review correctness" }] }],
      } as never),
    )
    expect(block(linked, "SubagentCard")).toEqual({
      _tag: "Block",
      block: expect.objectContaining({ name: "Review", prompt: "Review correctness", status: "running" }),
    })
  })

  it("materializes every child-group member without exposing group plumbing", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-group", "fan out")
    const members = Array.from({ length: 64 }, (_, index) => ({
      key: `lane-${index}`,
      selection: index % 2 === 0 ? "Oracle" : "Surgeon",
      prompt: `Inspect lane ${index}`,
    }))
    const patch = projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "group-call",
        name: "start_child_group",
        params: { members, concurrency: 8 },
        providerExecuted: false,
        metadata: {},
      }),
    )
    const cards = patch.upsert.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
    )
    expect(cards).toHaveLength(64)
    expect(patch.upsert).toHaveLength(64)
    expect(JSON.stringify(patch.upsert)).not.toContain("start_child_group")
    expect(patch.upsert.length).toBeLessThanOrEqual(128)
    const ordered = projector
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")
    expect(
      ordered
        .slice(0, 3)
        .map((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block.prompt : "",
        ),
    ).toEqual(["Inspect lane 0", "Inspect lane 1", "Inspect lane 2"])
  })

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
