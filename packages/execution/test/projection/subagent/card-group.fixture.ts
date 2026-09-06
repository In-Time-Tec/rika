import { describe, expect, it } from "@effect/vitest"
import { Prompt, Response } from "effect/unstable/ai"
import { TreeProjector } from "../../../src/projection/tree/projector"
import {
  block,
  modelResponse,
  resetEventPosition,
  toolResultPart,
  treeEvent,
} from "../../support/projector-event.fixture"

describe("blocking child-group projection", () => {
  it("keeps a started group active while the parent progresses, then correlates its explicit await", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-background-group", "start independent work")
    const members = [{ key: "research", selection: "Oracle", prompt: "Research independently" }]
    const startCall = {
      type: "tool-call" as const,
      id: "start-background",
      name: "start_child_group",
      params: { members, concurrency: 1 },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(modelResponse("raw-root-run", startCall))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionStarted",
        turn: 0,
        call: Response.toolCallPart(startCall),
      }),
    )
    projector.apply(
      modelResponse(
        "background-child",
        { type: "text", text: "Early child progress", metadata: {} },
        { parentRunId: "raw-root-run", invocationId: "background-invocation" },
      ),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart(startCall),
        result: toolResultPart({
          id: startCall.id,
          name: startCall.name,
          isFailure: false,
          result: {
            groupId: "durable-background-group",
            children: [
              {
                key: "research",
                selection: "Oracle",
                childRunId: "background-child",
                depth: 1,
                readiness: "ready",
              },
            ],
          },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ChildLinked",
        childRunId: "background-child",
        invocationId: "background-invocation",
        selection: "Oracle",
        prompt: Prompt.make(members[0]!.prompt),
        key: "research",
        origin: { parentToolCallId: startCall.id },
        childDepth: 1,
        readiness: "ready",
      }),
    )
    const earlyChild = projector
      .snapshot()
      .units.find((unit) => unit.content._tag === "Entry" && unit.content.text.includes("Early child progress"))
    const childCard = projector
      .snapshot()
      .units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")
    expect(earlyChild?.parentId).toBeDefined()
    expect(earlyChild?.parentId).toBe(
      childCard?.content._tag === "Block" && childCard.content.block._tag === "SubagentCard"
        ? childCard.content.block.id
        : undefined,
    )

    const parentProgress = projector.apply(
      modelResponse("raw-root-run", { type: "text", text: "Parent continued independently", metadata: {} }),
    )
    expect(parentProgress.upsert.some((unit) => unit.content._tag === "Entry")).toBe(true)
    expect(block(parentProgress, "SubagentGroup")).toBeUndefined()
    expect(
      projector
        .snapshot()
        .units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentGroup")?.content,
    ).toMatchObject({ _tag: "Block", block: { status: "queued", settled: false } })

    const awaitCall = {
      type: "tool-call" as const,
      id: "await-background",
      name: "await_child_group",
      params: { groupId: "durable-background-group" },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(modelResponse("raw-root-run", awaitCall))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionStarted",
        turn: 1,
        call: Response.toolCallPart(awaitCall),
      }),
    )
    const awaited = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 1,
        call: Response.toolCallPart(awaitCall),
        result: toolResultPart({
          id: awaitCall.id,
          name: awaitCall.name,
          isFailure: false,
          result: {
            groupId: "durable-background-group",
            status: "succeeded",
            children: [
              {
                key: "research",
                selection: "Oracle",
                childRunId: "background-child",
                depth: 1,
                readiness: "settled",
                status: "succeeded",
                text: "Research result",
              },
            ],
          },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    expect(block(awaited, "SubagentGroup")).toMatchObject({
      _tag: "Block",
      block: { status: "complete", settled: true, counts: { total: 1, complete: 1 } },
    })
    const card = projector
      .snapshot()
      .units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")
    expect(card?.content).toMatchObject({
      _tag: "Block",
      block: { status: "complete", summary: "Research result" },
    })
    expect(JSON.stringify(projector.snapshot().units)).not.toContain("await_child_group")
  })

  it("settles blocking group answers from the durable ordered mixed result", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-mixed-group", "fan out")
    const call = {
      type: "tool-call" as const,
      id: "mixed-group-call",
      name: "run_child_group",
      params: {
        members: [
          { key: "one", selection: "Task", prompt: "one" },
          { key: "two", selection: "Oracle", prompt: "two" },
          { key: "three", selection: "Surgeon", prompt: "three" },
        ],
      },
      providerExecuted: false,
      metadata: {},
    }
    projector.apply(modelResponse("raw-root-run", call))
    const settled = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ToolExecutionCompleted",
        turn: 0,
        call: Response.toolCallPart(call),
        result: toolResultPart({
          id: call.id,
          name: call.name,
          isFailure: false,
          result: {
            groupId: "durable-group",
            status: "failed",
            children: [
              {
                key: "one",
                selection: "Task",
                childRunId: "child-one",
                depth: 1,
                readiness: "ready",
                status: "succeeded",
                text: "one answer",
              },
              {
                key: "two",
                selection: "Oracle",
                childRunId: "child-two",
                depth: 1,
                readiness: "ready",
                status: "failed",
                message: "two failed",
              },
              {
                key: "three",
                selection: "Surgeon",
                childRunId: "child-three",
                depth: 1,
                readiness: "ready",
                status: "cancelled",
                reason: "three cancelled",
              },
            ],
          },
          encodedResult: {},
          providerExecuted: false,
          preliminary: false,
          metadata: {},
        }),
      }),
    )
    expect(block(settled, "SubagentGroup")).toMatchObject({
      _tag: "Block",
      block: {
        name: "3 agents",
        status: "failed",
        settled: true,
        counts: { total: 3, complete: 1, failed: 1, cancelled: 1 },
      },
    })
    const cards = projector
      .snapshot()
      .units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard")
    expect(
      cards.map((unit) =>
        unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard"
          ? [unit.content.block.status, unit.content.block.summary]
          : [],
      ),
    ).toEqual([
      ["complete", "one answer"],
      ["failed", "two failed"],
      ["cancelled", "three cancelled"],
    ])
  })

  it("keeps aggregate identity, order, counts, and settlement equal after durable replay", () => {
    resetEventPosition()
    const live = TreeProjector.make("turn-group-replay", "fan out")
    const call = {
      type: "tool-call" as const,
      id: "group-replay-call",
      name: "run_child_group",
      params: {
        members: [
          { key: "first", selection: "Task", prompt: "first" },
          { key: "second", selection: "Oracle", prompt: "second" },
        ],
      },
      providerExecuted: false,
      metadata: {},
    }
    const declaration = modelResponse("raw-root-run", call)
    live.apply(declaration)
    const resumed = TreeProjector.make("turn-group-replay", "fan out")
    resumed.apply(declaration)
    const completion = treeEvent("raw-root-run", {
      _tag: "ToolExecutionCompleted",
      turn: 0,
      call: Response.toolCallPart(call),
      result: toolResultPart({
        id: call.id,
        name: call.name,
        isFailure: false,
        result: {
          groupId: "group-replay",
          status: "succeeded",
          children: [
            {
              key: "first",
              selection: "Task",
              childRunId: "first-child",
              depth: 1,
              readiness: "ready",
              status: "succeeded",
              text: "first answer",
            },
            {
              key: "second",
              selection: "Oracle",
              childRunId: "second-child",
              depth: 1,
              readiness: "ready",
              status: "succeeded",
              text: "second answer",
            },
          ],
        },
        encodedResult: {},
        providerExecuted: false,
        preliminary: false,
        metadata: {},
      }),
    })
    live.apply(completion)
    resumed.apply(completion)
    expect(resumed.snapshot().units).toEqual(live.snapshot().units)
    expect(
      resumed
        .snapshot()
        .units.find((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentGroup")?.content,
    ).toMatchObject({
      _tag: "Block",
      block: { status: "complete", settled: true, counts: { total: 2, complete: 2 } },
    })
  })
})
