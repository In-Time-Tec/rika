import { describe, expect, it } from "@effect/vitest"
import { Response } from "generalist"
import { TreeProjector } from "../../../src/projection/tree/projector"
import { block, modelResponse, resetEventPosition, treeEvent } from "../../support/projector-event.fixture"

describe("blocking child-group projection", () => {
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
        result: Response.toolResultPart({
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
      result: Response.toolResultPart({
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
