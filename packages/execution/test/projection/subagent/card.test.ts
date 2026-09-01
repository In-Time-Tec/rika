import "./card-lifecycle.fixture"
import "./card-group.fixture"
import { describe, expect, it } from "@effect/vitest"
import { Prompt, Response } from "generalist"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { block, modelResponse, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

const subagentCard = (unit: Unit | undefined) =>
  unit?.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block : undefined

describe("Generalist subagent card projection", () => {
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
    expect(subagentCard(cardUnit)).toMatchObject({
      name: "Surgeon",
      prompt: "Fix the projection defect",
      status: "queued",
    })
    expect(JSON.stringify(cardUnit)).not.toContain("raw-root-run")
    const linked = projector.apply(
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
    expect(block(linked, "SubagentCard")).toBeUndefined()
    const queued = projector
      .snapshot()
      .units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")
    expect(subagentCard(queued)?.status).toBe("queued")
    const started = projector.apply(
      treeEvent(
        "raw-child-run",
        { _tag: "RunAttemptStarted", attempt: 1 },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    const startedCard = block(started, "SubagentCard")
    expect(
      startedCard?._tag === "Block" && startedCard.block._tag === "SubagentCard" ? startedCard.block.status : undefined,
    ).toBe("running")
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
        {
          _tag: "RunCompleted",
          result: {
            text: "aggregate child output",
            turns: 1,
            session: { sessionId: "session:raw-child-run", leafId: "entry:raw-child-run" },
          },
        },
        { parentRunId: "raw-root-run", invocationId: "provider-call-1" },
      ),
    )
    expect(
      completed.upsert.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant"),
    ).toHaveLength(0)
    const completedCard = block(completed, "SubagentCard")
    expect(
      completedCard?._tag === "Block" && completedCard.block._tag === "SubagentCard"
        ? [completedCard.block.status, completedCard.block.summary]
        : undefined,
    ).toEqual(["complete", ""])
    const snapshot = projector.snapshot()
    expect(
      snapshot.units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant"),
    ).toHaveLength(1)
    expect(JSON.stringify(snapshot.units)).not.toContain("raw-child-run")
  })

  it("preserves a long child final response as one complete semantic entry across resume", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-long", "delegate this")
    projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "provider-call-long",
        name: "run_child",
        params: { selection: "Task", prompt: "Return a detailed report" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-child-long",
        invocationId: "provider-call-long",
        selection: "Task",
        prompt: Prompt.make("Return a detailed report"),
        childDepth: 1,
        readiness: "ready",
      }),
    )
    const response = `BEGIN\n\n${"complete paragraph. ".repeat(700)}\n\nEND`
    expect(response.length).toBeGreaterThan(8_192)
    projector.apply(
      modelResponse(
        "raw-child-long",
        { type: "text", text: response, metadata: {} },
        { parentRunId: "raw-root-run", invocationId: "provider-call-long" },
      ),
    )
    const snapshot = projector.snapshot()
    const answers = snapshot.units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
    expect(answers).toHaveLength(1)
    expect(answers[0]?.content).toEqual({ _tag: "Entry", role: "assistant", text: response })
    const resumed = TreeProjector.make("turn-long", "delegate this", snapshot.checkpoint, snapshot.units)
    const restored = resumed
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
    expect(restored).toHaveLength(1)
    expect(restored[0]?.content).toEqual({ _tag: "Entry", role: "assistant", text: response })
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
        prompt: Prompt.make("Review correctness"),
        childDepth: 1,
        readiness: "ready",
      }),
    )
    const linkedCard = block(linked, "SubagentCard")
    expect(
      linkedCard?._tag === "Block" && linkedCard.block._tag === "SubagentCard"
        ? [linkedCard.block.name, linkedCard.block.prompt, linkedCard.block.status]
        : undefined,
    ).toEqual(["Review", "Review correctness", "queued"])
  })

  it("materializes a stable neutral aggregate with four ordered group members", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-group", "fan out")
    const members = Array.from({ length: 4 }, (_, index) => ({
      key: `lane-${index}`,
      selection: index % 2 === 0 ? "Oracle" : "Surgeon",
      label: `Explore subsystem ${index}`,
      prompt: `Inspect lane ${index}`,
    }))
    const patch = projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "group-call",
        name: "run_child_group",
        params: { members, concurrency: 4 },
        providerExecuted: false,
        metadata: {},
      }),
    )
    const cards = patch.upsert.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
    )
    expect(cards).toHaveLength(4)
    expect(patch.upsert).toHaveLength(5)
    expect(JSON.stringify(patch.upsert)).not.toContain("run_child_group")
    const group = patch.upsert.find(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentGroup",
    )
    expect(group?.content).toMatchObject({
      _tag: "Block",
      block: {
        name: "4 agents",
        status: "queued",
        settled: false,
        memberIds: cards.map((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block.id : "",
        ),
        counts: { total: 4, queued: 4 },
      },
    })
    expect(cards.map((unit) => unit.parentId)).toEqual(
      Array.from({ length: 4 }, () =>
        group?.content._tag === "Block" && group.content.block._tag === "SubagentGroup"
          ? group.content.block.id
          : undefined,
      ),
    )
    expect(
      cards.map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard"
          ? unit.content.block.status
          : undefined,
      ),
    ).toEqual(["queued", "queued", "queued", "queued"])
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
    expect(
      ordered.map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block.name : "",
      ),
    ).toEqual(["Explore subsystem 0", "Explore subsystem 1", "Explore subsystem 2", "Explore subsystem 3"])
  })

  it("fails every provisional card when an exact group is rejected before admission", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-rejected-group", "fan out")
    const call = {
      type: "tool-call" as const,
      id: "rejected-group-call",
      name: "run_child_group",
      params: {
        members: Array.from({ length: 4 }, (_, index) => ({
          key: `lane-${index}`,
          selection: "Task",
          label: `Rejected lane ${index}`,
          prompt: `Inspect rejected lane ${index}`,
        })),
        concurrency: 4,
      },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(modelResponse("raw-root-run", call))
    const failed = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart(call),
        result: Response.toolResultPart({
          id: call.id,
          name: call.name,
          isFailure: true,
          result: { message: "direct child limit exceeded" },
          encodedResult: { message: "direct child limit exceeded" },
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    const cards = projector
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")
    expect(cards).toHaveLength(4)
    expect(
      cards.map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard"
          ? { status: unit.content.block.status, summary: unit.content.block.summary }
          : undefined,
      ),
    ).toEqual(Array.from({ length: 4 }, () => ({ status: "failed", summary: "direct child limit exceeded" })))
    expect(failed.state.status).toBe("running")
    expect(
      projector
        .snapshot()
        .units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentGroup")?.content,
    ).toMatchObject({
      _tag: "Block",
      block: { status: "failed", settled: true, counts: { total: 4, failed: 4 } },
    })
  })

  it("keeps repeated group lifecycle events correlated to their own child cards", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-groups", "fan out twice")
    const members = (group: string) => [
      { key: "first", selection: "Oracle", label: `${group} first`, prompt: `${group} first prompt` },
      { key: "second", selection: "Task", label: `${group} second`, prompt: `${group} second prompt` },
    ]
    const declare = (id: string, group: string) => {
      const call = {
        type: "tool-call" as const,
        id,
        name: "run_child_group",
        params: { members: members(group), concurrency: 2 },
        providerExecuted: false,
        metadata: {},
      }
      projector.apply(modelResponse("raw-root-run", call))
      projector.apply(
        treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 0, call: Response.toolCallPart(call) }),
      )
    }
    const link = (group: string, toolCallId: string, key: string, childRunId: string) =>
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ChildLinked",
          childRunId,
          invocationId: `fan-${group}:${key}`,
          selection: key === "first" ? "Oracle" : "Task",
          prompt: Prompt.make(`${group} ${key} prompt`),
          childDepth: 1,
          key,
          label: `${group} ${key}`,
          origin: { parentToolCallId: toolCallId },
        }),
      )
    declare("group-one-call", "one")
    link("one", "group-one-call", "first", "raw-one-first")
    link("one", "group-one-call", "second", "raw-one-second")
    declare("group-two-call", "two")
    link("two", "group-two-call", "first", "raw-two-first")
    link("two", "group-two-call", "second", "raw-two-second")
    projector.apply(
      modelResponse(
        "raw-two-first",
        { type: "text", text: "second group result", metadata: {} },
        { parentRunId: "raw-root-run", invocationId: "fan-two:first" },
      ),
    )
    const snapshot = projector.snapshot()
    const secondGroupCard = snapshot.units.find(
      (unit) =>
        unit.content._tag === "Block" &&
        unit.content.block._tag === "SubagentCard" &&
        unit.content.block.name === "two first",
    )
    const result = snapshot.units.find(
      (unit) => unit.content._tag === "Entry" && unit.content.text === "second group result",
    )
    expect(
      snapshot.units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard"),
    ).toHaveLength(4)
    expect(result?.parentId).toBe(
      secondGroupCard?.content._tag === "Block" && secondGroupCard.content.block._tag === "SubagentCard"
        ? secondGroupCard.content.block.id
        : undefined,
    )
  })

  it("nests a descendant card under the direct child that actually spawned it", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-nested", "delegate recursively")
    projector.apply(
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "parent-call",
        name: "run_child",
        params: { selection: "Task", label: "Explore backend", prompt: "Inspect the backend" },
        providerExecuted: false,
        metadata: {},
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-parent-child",
        invocationId: "parent-call",
        selection: "Task",
        prompt: Prompt.make("Inspect the backend"),
        childDepth: 1,
        readiness: "ready",
      }),
    )
    projector.apply(
      modelResponse(
        "raw-parent-child",
        {
          type: "tool-call",
          id: "descendant-call",
          name: "run_child",
          params: { selection: "Oracle", label: "Map dependencies", prompt: "Map backend dependencies" },
          providerExecuted: false,
          metadata: {},
        },
        { parentRunId: "raw-root-run", invocationId: "parent-call" },
      ),
    )
    const cards = projector
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")
    expect(cards).toHaveLength(2)
    const direct = cards.find(
      (unit) =>
        unit.content._tag === "Block" &&
        unit.content.block._tag === "SubagentCard" &&
        unit.content.block.name === "Explore backend",
    )
    const descendant = cards.find(
      (unit) =>
        unit.content._tag === "Block" &&
        unit.content.block._tag === "SubagentCard" &&
        unit.content.block.name === "Map dependencies",
    )
    expect(descendant?.parentId).toBe(
      direct?.content._tag === "Block" && direct.content.block._tag === "SubagentCard"
        ? direct.content.block.id
        : undefined,
    )
  })
})
