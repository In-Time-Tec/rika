import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { expect, it } from "vitest"
import { ExecutionEvents, ViewState, type Model, type TranscriptBlock } from "../support/terminal-state-access"
import { renderTranscriptStyled } from "../../src/opentui/rendering/opentui-renderer"
import { transcriptUnitId, transcriptUnits } from "../../src/presentation/transcript/transcript-row"
import { event } from "./execution-events-characterization-1-support"
it("dedupes a nested child agent into an existing matching agent tool across batches", () => {
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Coordinate the work" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "child:turn:agent" },
    }),
  ])
  const firstBatch = TranscriptProjection.Projection.project("child:turn:agent", "", [
    event("gc", 0, "tool.call.requested", {
      data: { tool_call_id: "gc", tool_name: "task", input: { prompt: "Run the nested work" } },
    }),
    event("gc-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "gc", child_execution_id: "grandchild" },
    }),
  ])
  const secondBatch = TranscriptProjection.Projection.project("child:turn:agent", "", [
    event("gc-done", 0, "child_run.completed", {
      data: { child_execution_id: "grandchild", profile: "task" },
    }),
  ])
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", firstBatch.units)
  const toolCount = model.blocks.filter((block) => (block as TranscriptBlock)._tag === "ToolCall").length
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", secondBatch.units)

  const grandchildTools = model.blocks.filter(
    (block) =>
      (block as TranscriptBlock)._tag === "ToolCall" && (block as { childId?: string }).childId === "grandchild",
  )
  expect(grandchildTools).toHaveLength(1)
  expect(grandchildTools[0]).toMatchObject({
    id: TranscriptIdentity.scopedIdentity("child:turn:agent", "gc"),
    status: "complete",
  })
  expect(model.blocks.some((block) => (block as TranscriptBlock)._tag === "ChildAgent")).toBe(false)
  expect(model.blocks.filter((block) => (block as TranscriptBlock)._tag === "ToolCall").length).toBe(toolCount)
})
it("renders a completed child response from its parent result when child events are unavailable", () => {
  const childId = "execution:child:turn:complete"
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Complete the work" } },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-result", 2, "tool.result.received", {
      data: {
        tool_call_id: "agent",
        output: {
          childExecutionId: childId,
          status: "completed",
          output: [{ _tag: "text", text: "Child completed the boundary." }],
        },
      },
    }),
  ])
  const projected = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  const model = { ...projected, expandedRowKeys: ["tool:turn:agent"] }
  const rendered = renderTranscriptStyled(model)
    .chunks.map((chunk) => chunk.text)
    .join("")

  expect(rendered).toContain("Subagent finished")
  expect(rendered).toContain("Child completed the boundary.")
})
it("presents a subagent as finished when its durable child lifecycle completes after a tool error", () => {
  const childId = "execution:child:turn:task"
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "task",
        input: { prompt: "Use an unavailable model", model: "gpt-5.6-luna" },
      },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-failed", 2, "tool.result.received", {
      data: { tool_call_id: "agent", error: "AgentToolError: Model gpt-5.6-luna is not available" },
    }),
    event("child-completed", 3, "child_run.completed", {
      data: { child_execution_id: childId, profile: "task" },
    }),
  ])

  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      status: "complete",
    }),
  ])
  expect(
    renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join(""),
  ).toContain("Subagent finished")
})
it("merges Relay child ids that encode the uncorrelated tool call", () => {
  const turnId = "turn"
  const toolCallId = "rika:execution%3Aturn:cancel-agent"
  const childId = "child:execution%3Aturn:rika:execution%3Aturn:cancel-agent"
  const projection = TranscriptProjection.Projection.project(turnId, "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: toolCallId, tool_name: "task", input: { prompt: "Wait until cancelled." } },
    }),
    event("spawned", 1, "child_run.spawned", { data: { child_execution_id: childId } }),
  ])

  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      id: TranscriptIdentity.scopedIdentity(turnId, toolCallId),
      childId,
      status: "running",
    }),
  ])
})
it("uses Subagent as the fallback descriptor instead of Task", () => {
  const childId = "execution:child:turn:task"
  const projection = TranscriptProjection.Projection.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "spawn_child_run",
        input: { profile: "task", prompt: "Run the checks" },
      },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-started", 2, "child_run.started", {
      data: { child_execution_id: childId, profile: "task" },
    }),
  ])

  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      presentation: expect.objectContaining({ activeLabel: "Subagent working" }),
    }),
  ])
  expect(JSON.stringify(model.blocks)).not.toContain("Task working")
})
it("moves a live child row expansion onto the stable subagent unit key", () => {
  const childId = "execution:child:turn:task"
  let projection = TranscriptProjection.Projection.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "spawn_child_run",
        input: { profile: "task", prompt: "Run the checks" },
      },
    }),
    event("agent-started", 1, "child_run.started", {
      data: { child_execution_id: childId, profile: "task" },
    }),
  ])
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  const childRow = transcriptUnitId(model, transcriptUnits(model)[1]!)
  model = { ...model, detailSelection: childRow, expandedRowKeys: [childRow] }
  projection = TranscriptProjection.Projection.applyEvent(
    projection,
    event("agent-spawned", 2, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
  )

  model = ExecutionEvents.projectUnits(model, projection.units)

  expect(transcriptUnits(model)).toHaveLength(2)
  expect(model.detailSelection).toBe("tool:turn:agent")
  expect(model.expandedRowKeys).toEqual(["tool:turn:agent"])
})
it("projects a durable nested projection to the same tree as live child events", () => {
  const childId = "turn:child:oracle"
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "transfer_to_oracle",
        input: { input: [{ type: "text", text: "Review the projection" }] },
      },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
    }),
  ])
  const childProjection = TranscriptProjection.Projection.project(childId, "", [
    event("read", 0, "tool.call.requested", {
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/projection.ts" } },
    }),
    event("answer", 1, "model.output.completed", { text: "## Review complete\n\n**No defects found.**" }),
  ])
  const durable = TranscriptNestedProjection.withNestedProjections(parent, [
    { parentId: "turn:agent", projection: childProjection },
  ])

  let liveModel = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  liveModel = ExecutionEvents.projectChildUnits(liveModel, "turn:agent", childProjection.units)
  const reloadedModel = ExecutionEvents.projectUnits(ViewState.initial("/work"), durable.units)

  const shape = (model: Model) =>
    transcriptUnits(model).map((unit) => {
      if (unit.kind === "tool") {
        const response = unit.agentResponse
        let answer: number | undefined
        if (response?._tag === "Streaming") answer = response.answer
        else if (response?._tag === "Settled" && response.outcome.kind === "answer") answer = response.outcome.entry
        return {
          kind: unit.kind,
          id: transcriptUnitId(model, unit),
          children: unit.children?.map((child) => transcriptUnitId(model, child)),
          response: answer === undefined ? undefined : (model.entries[answer]?.text ?? "").replaceAll("\n", "\\n"),
        }
      }
      return { kind: unit.kind }
    })

  expect(shape(reloadedModel)).toEqual(shape(liveModel))
})
it("replays a child with an internal tool error and completed final response as finished", () => {
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "execution:child", profile: "oracle" },
    }),
  ])
  const child = TranscriptProjection.Projection.project("child", "", [
    event("inner", 0, "tool.call.requested", {
      data: { tool_call_id: "inner", tool_name: "read", input: { path: "missing.ts" } },
    }),
    event("inner-error", 1, "tool.result.received", {
      data: { tool_call_id: "inner", error: "File not found" },
    }),
    event("answer", 2, "model.output.completed", { text: "Usable Oracle response" }),
    event("failed", 3, "execution.failed", { text: "internal tool failed" }),
  ])

  const projected = ExecutionEvents.projectUnits(
    ViewState.initial("/work"),
    TranscriptNestedProjection.withNestedProjections(parent, [{ parentId: "turn:agent", projection: child }]).units,
  )
  const rendered = renderTranscriptStyled({ ...projected, expandedRowKeys: ["tool:turn:agent"] })
    .chunks.map((chunk) => chunk.text)
    .join("")

  expect(projected.blocks[0]).toMatchObject({ _tag: "ToolCall", status: "complete" })
  expect(rendered).toContain("Oracle has spoken")
  expect(rendered).toContain("Usable Oracle response")
  expect(rendered).not.toContain("Oracle failed")
})
