import * as Transcript from "@rika/transcript"
import { describe, expect, it } from "vitest"
import { ExecutionEvents, ViewState } from "../src"
import { renderTranscriptStyled } from "../src/adapter"
import { transcriptUnitId, transcriptUnits } from "../src/transcript-units"

const event = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<Transcript.SourceEvent> = {},
): Transcript.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

describe("ExecutionEvents.projectUnits", () => {
  it("updates one stable tool row as input and output arrive", () => {
    let projection = Transcript.empty("turn", "prompt")
    let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
    projection = Transcript.applyEvent(
      projection,
      event("call", 0, "tool.call.requested", {
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "src/a.ts" } },
      }),
    )
    model = ExecutionEvents.projectUnits(model, projection.units)
    projection = Transcript.applyEvent(
      projection,
      event("result", 1, "tool.result.received", {
        data: { tool_call_id: "call", output: "contents" },
      }),
    )
    model = ExecutionEvents.projectUnits(model, projection.units)

    expect(model.blocks).toEqual([
      expect.objectContaining({ _tag: "ToolCall", id: "turn:call", status: "complete", output: "contents" }),
    ])
    expect(model.items).toHaveLength(2)
  })

  it("keeps user, assistant, tool, and final assistant order", () => {
    const projection = Transcript.project("turn", "prompt", [
      event("input-0", 0, "model.input.prepared"),
      event("assistant-0", 1, "model.output.completed", { text: "I will inspect it." }),
      event("call", 2, "tool.call.requested", {
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "src/a.ts" } },
      }),
      event("result", 3, "tool.result.received", { data: { tool_call_id: "call", output: "contents" } }),
      event("input-1", 4, "model.input.prepared"),
      event("assistant-1", 5, "model.output.completed", { text: "Done." }),
    ])
    const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

    expect(model.items.map((item) => (item as ViewState.TranscriptItem).id)).toEqual([
      "turn:turn:user",
      "assistant:turn:0",
      "tool:turn:call",
      "assistant:turn:1",
    ])
  })

  it("keeps overlapping tool ids separate across turns", () => {
    const first = Transcript.project("turn-1", "first", [
      event("call", 0, "tool.call.requested", {
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "a.ts" } },
      }),
    ])
    const second = Transcript.project("turn-2", "second", [
      event("call", 0, "tool.call.requested", {
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "b.ts" } },
      }),
    ])
    const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), [...first.units, ...second.units])

    expect(model.blocks).toEqual([
      expect.objectContaining({ id: "turn-1:call", detail: "a.ts" }),
      expect.objectContaining({ id: "turn-2:call", detail: "b.ts" }),
    ])
  })

  it("updates one child row through its lifecycle", () => {
    let projection = Transcript.empty("turn", "prompt")
    projection = Transcript.applyEvent(
      projection,
      event("child-start", 0, "child_run.started", {
        data: { child_run_id: "child", profile: "oracle", summary: "Inspecting" },
      }),
    )
    let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
    projection = Transcript.applyEvent(
      projection,
      event("child-done", 1, "child_run.completed", {
        data: { child_run_id: "child", profile: "oracle", summary: "Finished" },
      }),
    )
    model = ExecutionEvents.projectUnits(model, projection.units)

    expect(model.blocks).toEqual([expect.objectContaining({ _tag: "ChildAgent", id: "child", status: "complete" })])
  })

  it("projects child execution tools beneath their subagent with stable nested keys", () => {
    const parent = Transcript.project("turn", "prompt", [
      event("agent", 0, "tool.call.requested", {
        data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
      }),
      event("agent-spawned", 1, "child_run.spawned", {
        data: { tool_call_id: "agent", child_execution_id: "child:turn:oracle" },
      }),
    ])
    const child = Transcript.project("child:turn:oracle", "", [
      event("read", 0, "tool.call.requested", {
        data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/a.ts", offset: 3, limit: 4 } },
      }),
      event("read-result", 1, "tool.result.received", {
        data: { tool_call_id: "read", output: "contents" },
      }),
      event("shell", 2, "tool.call.requested", {
        data: { tool_call_id: "shell", tool_name: "shell", input: { command: "bun test" } },
      }),
      event("shell-result", 3, "tool.result.received", {
        data: { tool_call_id: "shell", output: { text: "passed", exitCode: 0 } },
      }),
    ])
    let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
    model = ExecutionEvents.projectChildUnits(model, "turn:agent", child.units)
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
      "tool:child:turn:oracle:read",
      "tool:child:turn:oracle:shell",
    ])
  })

  it("reconciles parallel subagents spawned by a child execution", () => {
    const orchestratorId = "child:execution%3Aturn:rika:execution%3Aturn:call-orchestrator"
    const nestedIds = ["one", "two", "three", "four"].map(
      (callId) => `child:${encodeURIComponent(orchestratorId)}:rika:${encodeURIComponent(orchestratorId)}:${callId}`,
    )
    const parent = Transcript.project("turn", "prompt", [
      event("orchestrator", 0, "tool.call.requested", {
        data: { tool_call_id: "call-orchestrator", tool_name: "task", input: { prompt: "Explore in parallel" } },
      }),
      event("orchestrator-spawned", 1, "child_run.spawned", {
        data: { child_execution_id: orchestratorId },
      }),
    ])
    const orchestrator = Transcript.project(
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
          data: { child_execution_id: childId, profile: "task" },
        }),
      ]),
    )

    let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
    model = ExecutionEvents.projectChildUnits(model, "turn:call-orchestrator", orchestrator.units)
    for (const [index, childId] of nestedIds.entries()) {
      const child = Transcript.project(childId, "", [
        event(`read-${index}`, 0, "tool.call.requested", {
          data: { tool_call_id: "read", tool_name: "read_file", input: { path: `src/${index}.ts` } },
        }),
        event(`answer-${index}`, 1, "model.output.completed", {
          text: `## Area ${index + 1}\n\n**Complete.**`,
        }),
      ])
      model = ExecutionEvents.projectChildUnits(
        model,
        `${orchestratorId}:${["one", "two", "three", "four"][index]}`,
        child.units,
      )
    }

    const orchestratorUnit = transcriptUnits(model)[1]
    if (orchestratorUnit?.kind !== "tool") throw new Error("Expected orchestrator tool")
    expect(orchestratorUnit.children).toHaveLength(4)
    expect(orchestratorUnit.children?.map((unit) => unit.children?.length)).toEqual([1, 1, 1, 1])
    expect(orchestratorUnit.children?.map((unit) => unit.response)).toEqual([1, 2, 3, 4])
    expect(model.blocks.filter((block) => (block as ViewState.TranscriptBlock)._tag === "ChildAgent")).toHaveLength(0)
  })

  it("merges spawn and child lifecycle events into one named subagent with its prompt and tools", () => {
    const childId = "execution:child:turn:oracle"
    const parent = Transcript.project("turn", "prompt", [
      event("agent", 0, "tool.call.requested", {
        data: {
          tool_call_id: "agent",
          tool_name: "spawn_child_run",
          input: { profile: "oracle", prompt: "Find the projection defect" },
        },
      }),
      event("agent-spawned", 1, "child_run.spawned", {
        data: { tool_call_id: "agent", child_execution_id: childId },
      }),
      event("agent-started", 2, "child_run.started", {
        data: { child_execution_id: childId, profile: "oracle" },
      }),
      event("agent-completed", 3, "child_run.completed", {
        data: { child_execution_id: childId, profile: "oracle" },
      }),
    ])
    const child = Transcript.project("child:turn:oracle", "", [
      event("read", 0, "tool.call.requested", {
        data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/projection.ts" } },
      }),
      event("answer", 1, "model.output.completed", { text: "## Projection fixed\n\n**All checks pass.**" }),
    ])

    let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
    model = ExecutionEvents.projectChildUnits(model, "turn:agent", child.units)
    model = { ...model, expandedRowKeys: ["tool:turn:agent"] }

    const units = transcriptUnits(model)
    expect(units).toHaveLength(2)
    expect(model.blocks.filter((block) => (block as ViewState.TranscriptBlock)._tag === "ChildAgent")).toHaveLength(0)
    expect(model.blocks[0]).toMatchObject({
      _tag: "ToolCall",
      id: "turn:agent",
      detail: "Find the projection defect",
      childId,
      status: "complete",
      presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
    })
    expect(units[1]).toMatchObject({ kind: "tool", children: [{ kind: "tool" }], response: 1 })
    expect(model.entries[1]).toMatchObject({ role: "assistant", text: "## Projection fixed\n\n**All checks pass.**" })
    expect(model.items).toContainEqual(
      expect.objectContaining({
        _tag: "Entry",
        id: "assistant:child:turn:oracle:0",
        parentId: "turn:agent",
      }),
    )
  })

  it("renders a failed linked child as failed instead of finished", () => {
    const childId = "execution:child:turn:failed"
    const projection = Transcript.project("turn", "prompt", [
      event("agent", 0, "tool.call.requested", {
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Attempt the work" } },
      }),
      event("agent-spawned", 1, "child_run.spawned", {
        data: { tool_call_id: "agent", child_execution_id: childId },
      }),
      event("agent-failed", 2, "child_run.failed", {
        data: { child_execution_id: childId, profile: "task", error: "Child model failed" },
      }),
      event("agent-result", 3, "tool.result.received", {
        data: {
          tool_call_id: "agent",
          output: { childExecutionId: childId, status: "failed", output: [] },
        },
      }),
    ])
    const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
    const rendered = renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join("")

    expect(rendered).toContain("Subagent failed")
    expect(rendered).not.toContain("Subagent finished")
  })

  it("renders a completed child response from its parent result when child events are unavailable", () => {
    const childId = "execution:child:turn:complete"
    const projection = Transcript.project("turn", "prompt", [
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
    const projection = Transcript.project("turn", "prompt", [
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
    const projection = Transcript.project(turnId, "delegate", [
      event("agent", 0, "tool.call.requested", {
        data: { tool_call_id: toolCallId, tool_name: "task", input: { prompt: "Wait until cancelled." } },
      }),
      event("spawned", 1, "child_run.spawned", { data: { child_execution_id: childId } }),
    ])

    const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

    expect(model.blocks).toEqual([
      expect.objectContaining({
        _tag: "ToolCall",
        id: `${turnId}:${toolCallId}`,
        childId,
        status: "running",
      }),
    ])
  })

  it("uses Subagent as the fallback descriptor instead of Task", () => {
    const childId = "execution:child:turn:task"
    const projection = Transcript.project("turn", "prompt", [
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
    let projection = Transcript.project("turn", "prompt", [
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
    const childRow = "block:child:turn:execution:child:turn:task"
    model = { ...model, detailSelection: childRow, expandedRowKeys: [childRow] }
    projection = Transcript.applyEvent(
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
    const parent = Transcript.project("turn", "delegate", [
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
    const childProjection = Transcript.project(childId, "", [
      event("read", 0, "tool.call.requested", {
        data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/projection.ts" } },
      }),
      event("answer", 1, "model.output.completed", { text: "## Review complete\n\n**No defects found.**" }),
    ])
    const durable = Transcript.withNestedProjections(parent, [{ parentId: "turn:agent", projection: childProjection }])

    let liveModel = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
    liveModel = ExecutionEvents.projectChildUnits(liveModel, "turn:agent", childProjection.units)
    const reloadedModel = ExecutionEvents.projectUnits(ViewState.initial("/work"), durable.units)

    const shape = (model: ViewState.Model) =>
      transcriptUnits(model).map((unit) =>
        unit.kind === "tool"
          ? {
              kind: unit.kind,
              id: transcriptUnitId(model, unit),
              children: unit.children?.map((child) => transcriptUnitId(model, child)),
              response:
                unit.response === undefined
                  ? undefined
                  : (model.entries[unit.response]?.text ?? "").replaceAll("\n", "\\n"),
            }
          : { kind: unit.kind },
      )

    expect(shape(reloadedModel)).toEqual(shape(liveModel))
  })

  it("projects cancelled root and child tools as terminal without a duplicate notice", () => {
    const childId = "turn:child:task"
    const parent = Transcript.project("turn", "delegate", [
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
    const child = Transcript.project(childId, "", [
      event("shell", 0, "tool.call.requested", {
        data: { tool_call_id: "shell", tool_name: "shell", input: { command: "sleep 60" } },
      }),
      event("child-cancelled", 1, "execution.cancelled"),
    ])
    const root = Transcript.applyEvent(parent, event("root-cancelled", 2, "execution.cancelled"))

    let live = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
    live = ExecutionEvents.projectChildUnits(live, "turn:agent", child.units)
    live = ExecutionEvents.projectUnits(live, root.units)
    const durable = Transcript.withNestedProjections(root, [{ parentId: "turn:agent", projection: child }])
    const reloaded = ExecutionEvents.projectUnits(ViewState.initial("/work"), durable.units)

    for (const model of [live, reloaded]) {
      expect(model.blocks).toEqual([
        expect.objectContaining({ _tag: "ToolCall", id: "turn:agent", status: "cancelled" }),
        expect.objectContaining({ _tag: "ToolCall", id: `${childId}:shell`, status: "cancelled" }),
      ])
      expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
    }
  })

  it("projects one durable cancellation marker when no parent row can carry it", () => {
    const projection = Transcript.project("turn", "wait", [event("cancelled", 0, "execution.cancelled")])
    const once = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
    const twice = ExecutionEvents.projectUnits(once, projection.units)

    expect(twice.entries.filter((entry) => entry.role === "notice")).toEqual([
      { _tag: "Entry", role: "notice", text: "cancelled", turnId: "turn" },
    ])
    expect(twice.items).toContainEqual(
      expect.objectContaining({ _tag: "Entry", id: "execution:turn:cancelled", turnId: "turn" }),
    )
  })
})
