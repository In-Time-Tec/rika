import { describe, expect, it } from "@effect/vitest"
import * as TranscriptProjection from "../src/projection/transcript-projection"
import { identityKey } from "../src/ordering/transcript-unit-identity"

describe("Transcript projection", () => {
  it("keeps the ToolError message as the output of a failed tool result", () => {
    const guidance =
      "File not found: a. The call did not change state. Next action: Search for the file or call read with a corrected path."
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "read", input: "a" },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "call",
          output: {
            _tag: "ToolError",
            tool: "read",
            message: guidance,
            kind: "operation",
            category: "not_found",
            outcome: "known",
            recovery: "after_change",
            nextAction: "Search for the file or call read with a corrected path",
          },
        },
      },
    ])
    expect(projection.units[1]).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "failed", output: guidance } },
    })
  })

  it("preserves a failed await_subagents continuation as an actionable AgentToolError", () => {
    const failure = "AgentToolError: Child reports could not be collected"
    const projection = TranscriptProjection.Projection.project("turn-a", "prompt", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "join", tool_name: "await_subagents", input: {} },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "join", error: failure },
      },
    ])

    expect(projection.units[1]).toMatchObject({
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          name: "await_subagents",
          status: "failed",
          output: failure,
          presentation: {
            rowDisplay: "continuation",
            failedLabel: "Subagent wait failed",
          },
        },
      },
    })
  })

  it("links a Relay handoff spawn to its encoded tool call and keeps the supplied prompt", () => {
    const callId = "rika:execution%3Aparent:spawn-oracle"
    const childId = `execution:parent:child:${callId}`
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: callId,
          tool_name: "transfer_to_oracle",
          input: {
            input: [{ type: "text", text: "Inspect AGENTS.md and report the evidence." }],
          },
        },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { child_execution_id: childId, preset_name: "Oracle" },
      },
    ])

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: identityKey("tool", "turn-a", callId),
      revision: 2,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          childId,
          detail: "Inspect AGENTS.md and report the evidence.",
          presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
        },
      },
    })
  })

  it("strips the relay depth suffix from a linked child spawn", () => {
    const callId = "rika:execution%3Aparent:spawn-task"
    const childId = `execution:parent:child:${callId}`
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: callId,
          tool_name: "task",
          input: { input: [{ type: "text", text: "Investigate the failure." }] },
        },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { child_execution_id: childId, preset_name: "Task:1" },
      },
    ])

    expect(projection.units[1]).toMatchObject({
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          childId,
          presentation: { activeLabel: "Subagent working", completeLabel: "Subagent finished" },
        },
      },
    })
  })

  it("strips the relay depth suffix from an unlinked child block name", () => {
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "spawned",
        sequence: 1,
        type: "child_run.spawned",
        createdAt: 1,
        data: { child_execution_id: "execution:parent:child:orphan", preset_name: "Task:2" },
      },
    ])

    expect(projection.units[1]).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ChildAgent", name: "Task" } },
    })
  })

  it("links a child spawn with a percent-encoded parent execution id to the requesting tool", () => {
    const childId = "child:execution%3Aturn-a:call_1"
    const projection = TranscriptProjection.Projection.project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "call_1",
          tool_name: "oracle",
          input: { prompt: "Review the plan." },
        },
      },
      {
        cursor: `execution:turn-a:child:${childId}`,
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { child_execution_id: childId, preset_name: "Oracle" },
      },
      {
        cursor: `execution:turn-a:child:${childId}:completed`,
        sequence: 3,
        type: "child_run.event",
        createdAt: 3,
        data: { child_execution_id: childId, status: "completed" },
      },
    ])

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:call_1",
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          childId,
          status: "complete",
          presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
        },
      },
    })
    expect(
      projection.units.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ChildAgent"),
    ).toBe(false)
  })
})
