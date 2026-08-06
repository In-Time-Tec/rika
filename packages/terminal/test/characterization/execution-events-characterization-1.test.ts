import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { expect, it } from "vitest"
import { projectChildUnits, projectUnits } from "../../src/presentation/transcript/terminal-transcript-projection"
import { type Entry } from "../../src/state/model/terminal-message"
import { initial } from "../../src/state/model/terminal-state"
import { type TranscriptBlock, type TranscriptItem } from "../../src/state/model/terminal-transcript-state"

import { renderTranscriptStyled } from "../../src/opentui/rendering/opentui-renderer"
import { transcriptUnitId, transcriptUnits } from "../../src/presentation/transcript/transcript-row"
import { event } from "./execution-events-characterization-1-support"
it("updates one stable tool row as input and output arrive", () => {
  let projection = TranscriptProjection.Projection.empty("turn", "prompt")
  let model = projectUnits(initial("/work"), projection.units)
  projection = TranscriptProjection.Projection.applyEvent(
    projection,
    event("call", 0, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "src/a.ts" } },
    }),
  )
  model = projectUnits(model, projection.units)
  projection = TranscriptProjection.Projection.applyEvent(
    projection,
    event("result", 1, "tool.result.received", {
      data: { tool_call_id: "call", output: "contents" },
    }),
  )
  model = projectUnits(model, projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "turn:call", status: "complete", output: "contents" }),
  ])
  expect(model.items).toHaveLength(2)
})
it("keeps user, assistant, tool, and final assistant order", () => {
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    event("input-0", 0, "model.input.prepared"),
    event("assistant-0", 1, "model.output.completed", { text: "I will inspect it." }),
    event("call", 2, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "src/a.ts" } },
    }),
    event("result", 3, "tool.result.received", { data: { tool_call_id: "call", output: "contents" } }),
    event("input-1", 4, "model.input.prepared"),
    event("assistant-1", 5, "model.output.completed", { text: "Done." }),
  ])
  const model = projectUnits(initial("/work"), projection.units)

  expect(model.items.map((item) => (item as TranscriptItem).id)).toEqual([
    "turn:turn:user",
    TranscriptIdentity.identityKey("assistant", "turn", 0),
    "tool:turn:call",
    TranscriptIdentity.identityKey("assistant", "turn", 1),
  ])
})
it("keeps overlapping tool ids separate across turns", () => {
  const first = TranscriptProjection.Projection.project("turn-1", "first", [
    event("call", 0, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "a.ts" } },
    }),
  ])
  const second = TranscriptProjection.Projection.project("turn-2", "second", [
    event("call", 0, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "b.ts" } },
    }),
  ])
  const model = projectUnits(initial("/work"), [...first.units, ...second.units])

  expect(model.blocks).toEqual([
    expect.objectContaining({ id: "turn-1:call", detail: "a.ts" }),
    expect.objectContaining({ id: "turn-2:call", detail: "b.ts" }),
  ])
})
it("renders a subagent answer while streaming and keeps it once after settlement", () => {
  const childId = "run-agent-01"
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Investigate" } },
    }),
    event("spawn", 1, "child_run.spawned", {
      data: { invocation_id: "agent", child_execution_id: childId },
    }),
  ])
  let child = TranscriptProjection.Projection.project(childId, "", [
    event("hel", 0, "model.output.delta", { text: "hel" }),
  ])
  let model = projectUnits(initial("/work"), parent.units)
  model = projectChildUnits(model, "turn:agent", child.units)
  model = { ...model, expandedRowKeys: ["tool:turn:agent"] }

  expect(
    renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join(""),
  ).toContain("hel")

  child = TranscriptProjection.Projection.applyEvent(child, event("lo", 1, "model.output.delta", { text: "lo" }))
  model = projectChildUnits(model, "turn:agent", child.units)
  const streaming = renderTranscriptStyled(model)
    .chunks.map((chunk) => chunk.text)
    .join("")
  expect(streaming).toContain("hello")

  child = TranscriptProjection.Projection.applyEvent(child, event("done", 2, "execution.completed"))
  model = projectChildUnits(model, "turn:agent", child.units)
  const settled = renderTranscriptStyled(model)
    .chunks.map((chunk) => chunk.text)
    .join("")
  expect(settled.split("hello")).toHaveLength(2)
})
it("projects child execution tools beneath their subagent with stable nested keys", () => {
  const childId = "run-oracle-01"
  const parent = TranscriptProjection.Projection.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { invocation_id: "agent", child_execution_id: childId },
    }),
  ])
  const child = TranscriptProjection.Projection.project(childId, "", [
    event("read", 0, "tool.call.requested", {
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts", offset: 3, limit: 4 } },
    }),
    event("read-result", 1, "tool.result.received", {
      data: { tool_call_id: "read", output: "contents" },
    }),
    event("shell", 2, "tool.call.requested", {
      data: { tool_call_id: "shell", tool_name: "bash", input: { command: "bun test" } },
    }),
    event("shell-result", 3, "tool.result.received", {
      data: { tool_call_id: "shell", output: { text: "passed", exitCode: 0 } },
    }),
  ])
  let model = projectUnits(initial("/work"), parent.units)
  model = projectChildUnits(model, "turn:agent", child.units)
  model = { ...model, expandedRowKeys: ["tool:turn:agent"] }

  const units = transcriptUnits(model)
  expect(units).toMatchObject([
    { kind: "entry" },
    {
      kind: "tool",
      blocks: [0],
      children: [
        { kind: "tool", blocks: [1] },
        { kind: "tool", blocks: [2] },
      ],
    },
  ])
  const parentUnit = units[1]!
  expect(transcriptUnitId(model, parentUnit)).toBe("tool:turn:agent")
  if (parentUnit.kind !== "tool") throw new Error("Expected tool unit")
  expect(parentUnit.children?.map((unit) => transcriptUnitId(model, unit))).toEqual([
    TranscriptIdentity.identityKey("tool", childId, "read"),
    TranscriptIdentity.identityKey("tool", childId, "shell"),
  ])
})
it("reconciles parallel subagents spawned by a child execution", () => {
  const orchestratorId = "run-orchestrator-01"
  const nestedIds = ["run-parallel-01", "run-parallel-02", "run-parallel-03", "run-parallel-04"]
  const parent = TranscriptProjection.Projection.project("turn", "prompt", [
    event("orchestrator", 0, "tool.call.requested", {
      data: { tool_call_id: "call-orchestrator", tool_name: "task", input: { prompt: "Explore in parallel" } },
    }),
    event("orchestrator-spawned", 1, "child_run.spawned", {
      data: { invocation_id: "call-orchestrator", child_execution_id: orchestratorId },
    }),
  ])
  const orchestrator = TranscriptProjection.Projection.project(
    orchestratorId,
    "",
    nestedIds.flatMap((childId, index) => [
      event(`task-${index}`, index * 2, "tool.call.requested", {
        data: {
          tool_call_id: ["one", "two", "three", "four"][index],
          tool_name: "task",
          input: { prompt: `Explore area ${index + 1}` },
        },
      }),
      event(`spawn-${index}`, index * 2 + 1, "child_run.spawned", {
        data: { invocation_id: ["one", "two", "three", "four"][index], child_execution_id: childId, profile: "task" },
      }),
    ]),
  )

  let model = projectUnits(initial("/work"), parent.units)
  model = projectChildUnits(model, "turn:call-orchestrator", orchestrator.units)
  for (const [index, childId] of nestedIds.entries()) {
    const child = TranscriptProjection.Projection.project(childId, "", [
      event(`read-${index}`, 0, "tool.call.requested", {
        data: { tool_call_id: "read", tool_name: "read", input: { path: `src/${index}.ts` } },
      }),
      event(`answer-${index}`, 1, "model.output.completed", {
        text: `## Area ${index + 1}\n\n**Complete.**`,
      }),
    ])
    model = projectChildUnits(
      model,
      TranscriptIdentity.scopedIdentity(orchestratorId, ["one", "two", "three", "four"][index]!),
      child.units,
    )
  }

  const orchestratorUnit = transcriptUnits(model)[1]
  if (orchestratorUnit?.kind !== "tool") throw new Error("Expected orchestrator tool")
  expect(orchestratorUnit.children).toHaveLength(4)
  expect(orchestratorUnit.children?.map((unit) => unit.children?.length)).toEqual([1, 1, 1, 1])
  const nestedToolIds = orchestratorUnit.children?.map(
    (unit) => (unit.kind === "tool" ? model.blocks[unit.blocks[0]!] : undefined) as TranscriptBlock | undefined,
  )
  const answerParentIds = (model.items as ReadonlyArray<TranscriptItem>)
    .filter((item) => item._tag === "Entry" && (model.entries[item.index] as Entry | undefined)?.role === "assistant")
    .map((item) => item.parentId)
  expect(
    nestedToolIds?.map(
      (block) => answerParentIds.filter((parentId) => parentId === (block as { id?: string })?.id).length,
    ),
  ).toEqual([1, 1, 1, 1])
  expect(model.blocks.filter((block) => (block as TranscriptBlock)._tag === "ChildAgent")).toHaveLength(0)
})
it("renders a failed linked child as failed instead of finished", () => {
  const childId = "run-failed-01"
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Attempt the work" } },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { invocation_id: "agent", child_execution_id: childId },
    }),
    event("agent-failed", 2, "child_run.failed", {
      data: { invocation_id: "agent", child_execution_id: childId, profile: "task", error: "Child model failed" },
    }),
    event("agent-result", 3, "tool.result.received", {
      data: {
        tool_call_id: "agent",
        output: { childExecutionId: childId, status: "failed", output: [] },
      },
    }),
  ])
  const model = projectUnits(initial("/work"), projection.units)
  const rendered = renderTranscriptStyled(model)
    .chunks.map((chunk) => chunk.text)
    .join("")

  expect(rendered).toContain("Subagent failed")
  expect(rendered).not.toContain("Subagent finished")
})
it("shows the durable execution failure on a nested subagent instead of a failed child tool", () => {
  const childId = "run-agent-02"
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Coordinate the work" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { invocation_id: "agent", child_execution_id: childId },
    }),
  ])
  const child = TranscriptProjection.Projection.project(childId, "", [
    event("nested", 0, "tool.call.requested", {
      data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "Run the nested check" } },
    }),
    event("nested-result", 1, "tool.result.received", {
      data: { tool_call_id: "nested", error: "AgentToolError: unrelated wrapper failure" },
    }),
    event("failed", 2, "execution.failed", {
      data: { message: "Model route luna-low was not registered" },
    }),
  ])
  let live = projectUnits(initial("/work"), parent.units)
  live = projectChildUnits(live, "turn:agent", child.units)
  const durable = projectUnits(
    initial("/work"),
    TranscriptNestedProjection.withNestedProjections(parent, [{ parentId: "turn:agent", projection: child }]).units,
  )

  for (const projected of [live, durable]) {
    const model = { ...projected, expandedRowKeys: ["tool:turn:agent"] }
    const rendered = renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(model.blocks[0]).toMatchObject({
      _tag: "ToolCall",
      id: "turn:agent",
      status: "failed",
      output: "Model route luna-low was not registered",
    })
    expect(model.blocks).toContainEqual(
      expect.objectContaining({ _tag: "Error", detail: "Model route luna-low was not registered" }),
    )
    expect(model.items).toContainEqual(
      expect.objectContaining({
        _tag: "Block",
        id: TranscriptIdentity.identityKey("execution", childId, "failed"),
        parentId: "turn:agent",
      }),
    )
    expect(rendered).toContain("Subagent failed")
    expect(rendered).toContain("Model route luna-low was not registered")
    expect(rendered).not.toContain("AgentToolError: unrelated wrapper failure")
  }
})
it("keeps nested reasoning and non-assistant entries out of a subagent projection", () => {
  const childId = "run-agent-03"
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Coordinate the work" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { invocation_id: "agent", child_execution_id: childId },
    }),
  ])
  const child = TranscriptProjection.Projection.project(childId, "hidden prompt", [
    event("thinking", 0, "model.reasoning.delta", { text: "internal reasoning" }),
    event("nested", 1, "tool.call.requested", {
      data: { tool_call_id: "nested", tool_name: "read", input: { path: "src/a.ts" } },
    }),
  ])
  let model = projectUnits(initial("/work"), parent.units)
  model = projectChildUnits(model, "turn:agent", child.units)

  expect(model.blocks.some((block) => (block as TranscriptBlock)._tag === "Reasoning")).toBe(false)
  expect(model.items.some((item) => (item as TranscriptItem).id === `turn:${childId}:user`)).toBe(false)
  expect(model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Block",
      id: TranscriptIdentity.identityKey("tool", childId, "nested"),
      parentId: "turn:agent",
    }),
  )
})
