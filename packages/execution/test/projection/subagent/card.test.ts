import "./card-lifecycle.fixture"
import "./card-group.fixture"
import { describe, expect, it } from "@effect/vitest"
import { Prompt, Response } from "generalist"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { TreeProjector } from "../../../src/projection/tree/projector"
import * as SubagentCardProjection from "../../../src/projection/subagent/card"
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

  it("rebuilds a long child final response as one complete semantic entry", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-long", "delegate this")
    const response = `BEGIN\n\n${"complete paragraph. ".repeat(700)}\n\nEND`
    expect(response.length).toBeGreaterThan(8_192)
    const events = [
      modelResponse("raw-root-run", {
        type: "tool-call",
        id: "provider-call-long",
        name: "run_child",
        params: { selection: "Task", prompt: "Return a detailed report" },
        providerExecuted: false,
        metadata: {},
      }),
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "raw-child-long",
        invocationId: "provider-call-long",
        selection: "Task",
        prompt: Prompt.make("Return a detailed report"),
        childDepth: 1,
        readiness: "ready",
      }),
      modelResponse(
        "raw-child-long",
        { type: "text", text: response, metadata: {} },
        { parentRunId: "raw-root-run", invocationId: "provider-call-long" },
      ),
    ]
    projector.applyAll(events)
    const snapshot = projector.snapshot()
    const answers = snapshot.units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant")
    expect(answers).toHaveLength(1)
    expect(answers[0]?.content).toEqual({ _tag: "Entry", role: "assistant", text: response })
    const resumed = TreeProjector.make("turn-long", "delegate this")
    resumed.applyAll(events)
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
describe("subagent group settlement coherence (defect #359)", () => {
  const members = Array.from({ length: 4 }, (_, index) => ({
    key: `lane-${index}`,
    selection: "Task",
    label: `Coherent lane ${index}`,
    prompt: `Inspect coherent lane ${index}`,
  }))
  const call = {
    type: "tool-call" as const,
    id: "coherent-group-call",
    name: "run_child_group",
    params: { members, concurrency: 4 },
    providerExecuted: false,
    metadata: {},
  }
  const groupOf = (unit: Unit | undefined) =>
    unit?.content._tag === "Block" && unit.content.block._tag === "SubagentGroup" ? unit.content.block : undefined
  const cardsOf = (units: ReadonlyArray<Unit>) =>
    units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")

  it("emits one coherent group patch with every declared member", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-coherent-group", "fan out")
    const declaration = projector.apply(modelResponse("raw-root-run", call))
    const started = projector.apply(
      treeEvent("raw-root-run", { _tag: "ToolExecutionStarted", turn: 0, call: Response.toolCallPart(call) }),
    )
    const patches = [declaration, started]
    const groupPatches = patches.filter((patch) =>
      patch.upsert.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentGroup"),
    )
    expect(groupPatches).toHaveLength(1)
    const patch = groupPatches[0]!
    const group = groupOf(patch.upsert.find((unit) => groupOf(unit) !== undefined))
    const cards = cardsOf(patch.upsert)
    expect(cards).toHaveLength(4)
    expect(group?.memberIds).toHaveLength(4)
    expect(
      cards.map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block.id : "",
      ),
    ).toEqual(group?.memberIds)
    expect(cards.map((unit) => unit.parentId)).toEqual(
      Array.from({ length: 4 }, () => group?.id),
    )
    expect(group?.counts).toMatchObject({ total: 4, queued: 4, running: 0, complete: 0 })
  })

  it("settles all group cards before it publishes final counts", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-settle-order", "fan out")
    projector.apply(modelResponse("raw-root-run", call))
    const settled = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart(call),
        result: Response.toolResultPart({
          id: call.id,
          name: call.name,
          isFailure: false,
          result: {
            groupId: "settle-order-group",
            status: "succeeded",
            children: [
              { key: "lane-0", selection: "Task", childRunId: "child-0", depth: 1, readiness: "ready", status: "succeeded", text: "lane zero done" },
              { key: "lane-1", selection: "Task", childRunId: "child-1", depth: 1, readiness: "ready", status: "failed", message: "lane one failed" },
              { key: "lane-2", selection: "Task", childRunId: "child-2", depth: 1, readiness: "ready", status: "succeeded", text: "lane two done" },
              { key: "lane-3", selection: "Task", childRunId: "child-3", depth: 1, readiness: "ready", status: "cancelled", reason: "lane three cancelled" },
            ],
          },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    const resolved = new Map<string, string>()
    for (const unit of settled.upsert) {
      if (unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard") {
        resolved.set(unit.content.block.id, unit.content.block.status)
        continue
      }
      const group = groupOf(unit)
      if (group === undefined) continue
      const seen = (status: string) => [...resolved.values()].filter((candidate) => candidate === status).length
      expect(group.counts.complete).toBeLessThanOrEqual(seen("complete"))
      expect(group.counts.failed).toBeLessThanOrEqual(seen("failed"))
      expect(group.counts.cancelled).toBeLessThanOrEqual(seen("cancelled"))
      expect(resolved.size).toBe(4)
    }
    expect(resolved.size).toBe(4)
  })

  it("keeps group member order stable across ChildLinked events", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-link-order", "fan out")
    for (const index of [3, 2, 1, 0]) {
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ChildLinked",
          childRunId: `raw-link-child-${index}`,
          invocationId: `coherent-group-call:lane-${index}`,
          selection: "Task",
          prompt: Prompt.make(`Inspect coherent lane ${index}`),
          childDepth: 1,
          key: `lane-${index}`,
          label: `Coherent lane ${index}`,
          origin: { parentToolCallId: "coherent-group-call" },
        }),
      )
    }
    projector.apply(modelResponse("raw-root-run", call))
    const snapshot = projector.snapshot()
    const group = snapshot.units
      .map((unit) => groupOf(unit))
      .find((candidate) => candidate !== undefined)
    const rendered = cardsOf(snapshot.units).map((unit) =>
      unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block.id : "",
    )
    expect(group?.memberIds).toEqual(rendered)
    expect(rendered).toHaveLength(4)
    expect(
      cardsOf(snapshot.units).map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block.name : "",
      ),
    ).toEqual(["Coherent lane 0", "Coherent lane 1", "Coherent lane 2", "Coherent lane 3"])
  })

  it("calculates group counts in one pass after batch settlement", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-one-pass", "fan out")
    projector.apply(modelResponse("raw-root-run", call))
    const settled = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart(call),
        result: Response.toolResultPart({
          id: call.id,
          name: call.name,
          isFailure: false,
          result: {
            groupId: "one-pass-group",
            status: "succeeded",
            children: members.map((member, index) => ({
              key: member.key,
              selection: "Task",
              childRunId: `child-one-pass-${index}`,
              depth: 1,
              readiness: "ready",
              status: "succeeded",
              text: `lane ${index} done`,
            })),
          },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    const groupEntries = settled.upsert.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentGroup",
    )
    expect(groupEntries).toHaveLength(1)
    expect(settled.upsert.at(-1)?.content).toEqual(groupEntries[0]?.content)
    expect(groupOf(settled.upsert.at(-1))?.counts).toMatchObject({ total: 4, complete: 4 })
  })

  it("reports a structured projection violation for a missing member card", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-violation", "fan out")
    projector.apply(modelResponse("raw-root-run", call))
    const snapshot = projector.snapshot()
    const group = snapshot.units.map((unit) => groupOf(unit)).find((candidate) => candidate !== undefined)
    expect(group?.memberIds).toHaveLength(4)
    const cardIds = new Set(
      cardsOf(snapshot.units).map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block.id : "",
      ),
    )
    expect(cardIds.size).toBe(4)
    const invalidMemberIds = [...(group?.memberIds ?? []), "subagent-missing-member"]
    expect(invalidMemberIds.filter((id) => !cardIds.has(id))).toEqual(["subagent-missing-member"])
    const validate = (SubagentCardProjection as unknown as Record<string, unknown>)[
      "validateSubagentGroupProjection"
    ]
    expect(typeof validate).toBe("function")
    const violations = (
      validate as (input: {
        memberIds: ReadonlyArray<string>
        cardIds: ReadonlyArray<string>
      }) => ReadonlyArray<{ missingId: string }>
    )({
      memberIds: invalidMemberIds,
      cardIds: [...cardIds],
    })
    expect(violations).toEqual([{ missingId: "subagent-missing-member" }])
  })
})
