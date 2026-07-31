import * as TranscriptIdentity from "@rika/transcript/transcript-unit-identity"

import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"

import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"

import * as TranscriptProjection from "@rika/transcript/transcript-projection"

import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"

import { expect, it } from "vitest"

import { ExecutionEvents, ViewState } from "../../src/state/model/terminal-state"

import { renderTranscriptStyled } from "../../src/adapter"

const event = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<TranscriptSourceEvent.SourceEvent> = {},
): TranscriptSourceEvent.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

it("projects cancelled root and child tools as terminal without a duplicate notice", () => {
  const childId = "turn:child:task"
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "task",
        input: { prompt: "Run the checks" },
      },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
    }),
  ])
  const child = TranscriptProjection.Projection.project(childId, "", [
    event("shell", 0, "tool.call.requested", {
      data: { tool_call_id: "shell", tool_name: "bash", input: { command: "sleep 60" } },
    }),
    event("child-cancelled", 1, "execution.cancelled"),
  ])
  const root = TranscriptProjection.Projection.applyEvent(parent, event("root-cancelled", 2, "execution.cancelled"))

  let live = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  live = ExecutionEvents.projectChildUnits(live, "turn:agent", child.units)
  live = ExecutionEvents.projectUnits(live, root.units)
  const durable = TranscriptNestedProjection.withNestedProjections(root, [
    { parentId: "turn:agent", projection: child },
  ])
  const reloaded = ExecutionEvents.projectUnits(ViewState.initial("/work"), durable.units)

  for (const model of [live, reloaded]) {
    expect(model.blocks).toEqual([
      expect.objectContaining({ _tag: "ToolCall", id: "turn:agent", status: "cancelled" }),
      expect.objectContaining({
        _tag: "ToolCall",
        id: TranscriptIdentity.scopedIdentity(childId, "shell"),
        status: "cancelled",
      }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
  }
})

it("lets a reasoned nested cancellation override a stale failed parent in live and flattened replay", () => {
  const parent = TranscriptProjection.Projection.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
    }),
    event("stale-failure", 1, "tool.result.received", {
      data: { tool_call_id: "agent", error: "stale parent failure" },
    }),
  ])
  const child = TranscriptProjection.Projection.project("child", "", [
    event("shell", 2, "tool.call.requested", {
      data: { tool_call_id: "shell", tool_name: "bash", input: { command: "sleep 60" } },
    }),
    event("child-cancelled", 3, "execution.cancelled", { data: { reason: "parent stopped this child" } }),
  ])
  let live = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  live = ExecutionEvents.projectChildUnits(live, "turn:agent", child.units)
  const replay = ExecutionEvents.projectUnits(
    ViewState.initial("/work"),
    TranscriptNestedProjection.withNestedProjections(parent, [{ parentId: "turn:agent", projection: child }]).units,
  )

  for (const projected of [live, replay]) {
    const model = { ...projected, expandedRowKeys: ["tool:turn:agent"] }
    const rendered = renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(model.blocks).toEqual([
      expect.objectContaining({
        _tag: "ToolCall",
        id: "turn:agent",
        status: "cancelled",
        output: "parent stopped this child",
      }),
      expect.objectContaining({ _tag: "ToolCall", id: "child:shell", status: "cancelled" }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(rendered).toContain("parent stopped this child")
    expect(rendered).not.toContain("stale parent failure")
  }
})

it("keeps an early durable cancellation as an invisible execution outcome", () => {
  const projection = TranscriptProjection.Projection.project("turn", "wait", [
    event("cancelled", 0, "execution.cancelled"),
  ])
  const once = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  const twice = ExecutionEvents.projectUnits(once, projection.units)

  expect(projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
    status: "cancelled",
  })
  expect(twice.entries.filter((entry) => entry.role === "notice")).toEqual([])
  expect(twice.items).not.toContainEqual(expect.objectContaining({ id: "execution:turn:cancelled", turnId: "turn" }))
})

it("keeps a recovered Report verdict when the child execution fails after its final answer", () => {
  const { model, tool } = delegation(recoveredReport, [
    event("answer", 0, "model.output.completed", { text: "The finding" }),
    failedChildEvent(1),
  ])
  expect(tool.status).toBe("complete")
  expect(tool.output).toContain("Report")
  const rendered = renderExpanded(model)
  expect(rendered).toContain("The finding")
  expect(rendered).not.toContain("Subagent failed")
  expect(rendered).not.toContain("stream cut")
})

it("restores a recovered Report verdict when the child failure arrives before the tool result", () => {
  let parent = TranscriptProjection.Projection.empty("turn", "delegate")
  parent = TranscriptProjection.Projection.applyEvent(
    parent,
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Inspect the child" } },
    }),
  )
  parent = TranscriptProjection.Projection.applyEvent(
    parent,
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "execution:child" },
    }),
  )
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  const child = TranscriptProjection.Projection.project("child", "", [
    event("answer", 0, "model.output.completed", { text: "The finding" }),
    failedChildEvent(1),
  ])
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", child.units)
  const interim = (model.blocks as ReadonlyArray<TranscriptPresentationModel.Block>).find(
    (block) => block._tag === "ToolCall" && block.id === "turn:agent",
  ) as Extract<TranscriptPresentationModel.Block, { _tag: "ToolCall" }>
  expect(interim.status).toBe("failed")
  parent = TranscriptProjection.Projection.applyEvent(
    parent,
    event("parent-result", 2, "tool.result.received", { data: { tool_call_id: "agent", output: recoveredReport } }),
  )
  model = ExecutionEvents.projectUnits(model, parent.units)
  const settled = (model.blocks as ReadonlyArray<TranscriptPresentationModel.Block>).find(
    (block) => block._tag === "ToolCall" && block.id === "turn:agent",
  ) as Extract<TranscriptPresentationModel.Block, { _tag: "ToolCall" }>
  expect(settled.status).toBe("complete")
  expect(settled.output).toContain("Report")
})

it("keeps a NoReport verdict failed when the child execution fails", () => {
  const { tool } = delegation(
    {
      _tag: "NoReport",
      childExecutionId: "execution:child",
      status: "failed",
      reason: "The subagent finished its run without writing a final report.",
    },
    [failedChildEvent(0)],
  )
  expect(tool.status).toBe("failed")
})

it("keeps a plain-text tool error failed when the child execution fails", () => {
  const { tool } = delegation("provider exploded", [failedChildEvent(0)])
  expect(tool.status).toBe("failed")
})

it("prefers the Report text over the child failure detail when no answer entry survives", () => {
  const { model, tool } = delegation(recoveredReport, [failedChildEvent(0)])
  expect(tool.status).toBe("complete")
  const rendered = renderExpanded(model)
  expect(rendered).toContain("The finding")
  expect(rendered).not.toContain("stream cut")
  expect(rendered).not.toContain("The execution failed unexpectedly.")
})

it("keeps a NoReport verdict when the child execution completes", () => {
  const { tool } = delegation({
    _tag: "NoReport",
    childExecutionId: "execution:child",
    status: "failed",
    reason: "The subagent finished its run without writing a final report.",
    recovery: "Re-run this delegation once with the same prompt.",
  })
  expect(tool.status).toBe("failed")
  expect(tool.output).toContain("NoReport")
})

it("keeps a truncated Failed verdict and its partial work when the child execution completes", () => {
  const { tool } = delegation({
    _tag: "Failed",
    childExecutionId: "execution:child",
    status: "failed",
    reason: "The subagent's final model turn ended before the provider reported why it stopped.",
    output: [{ type: "text", text: "Partial finding" }],
  })
  expect(tool.status).toBe("failed")
  expect(tool.output).toContain("Partial finding")
})

it("lets a completed child execution override a stale plain-text tool error", () => {
  const { tool } = delegation("stale parent failure")
  expect(tool.status).toBe("complete")
  expect(tool.output ?? "").not.toContain("stale parent failure")
})

it("lets a completed child execution override a Report verdict without losing the answer", () => {
  const { model, tool } = delegation({
    _tag: "Report",
    childExecutionId: "execution:child",
    status: "completed",
    output: [{ type: "text", text: "The finding" }],
  })
  expect(tool.status).toBe("complete")
  expect(tool.output).toContain("The finding")
  expect(renderExpanded(model)).toContain("The finding")
})

it("keeps a completed NoReport explanation when the child execution completes", () => {
  const { model, tool } = delegation({
    _tag: "NoReport",
    childExecutionId: "execution:child",
    status: "completed",
    reason: "The subagent finished its run without writing a final report.",
    recovery: "Re-run this delegation once with the same prompt.",
  })
  expect(tool.status).toBe("complete")
  expect(tool.output).toContain("without writing a final report")
  expect(renderExpanded(model)).toContain("Re-run this delegation once with the same prompt.")
})
