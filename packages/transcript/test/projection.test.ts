import { describe, expect, it } from "@effect/vitest"
import { providers } from "@opencode-ai/models/snapshot"
import {
  applyEvent,
  childParentMatch,
  empty,
  ensureChildTool,
  hasRunningBlocks,
  project,
  settleChild,
  settleRunning,
  withNestedProjections,
  type SourceEvent,
} from "../src"

const usage = (cursor: string, sequence: number): SourceEvent => ({
  cursor,
  sequence,
  type: "model.usage.reported",
  createdAt: sequence,
  data: { cost_usd: 1.25 },
})

describe("Transcript projection", () => {
  it("collapses a long output stream into stable semantic units", () => {
    const events = Array.from(
      { length: 600 },
      (_, index): SourceEvent => ({
        cursor: `cursor-${index}`,
        sequence: index,
        type: "model.output.delta",
        createdAt: index,
        text: `line ${index}\n`,
      }),
    )
    const projection = project("turn-a", "prompt", events)

    expect(projection.units).toHaveLength(2)
    expect(projection.units[0]).toMatchObject({ key: "turn:turn-a:user", content: { role: "user", text: "prompt" } })
    expect(projection.units[1]).toMatchObject({ content: { role: "assistant" } })
    expect(projection.units[1]?.content._tag).toBe("Entry")
    expect(projection.units[1]?.content._tag === "Entry" ? projection.units[1].content.text : "").toContain("line 599")
    expect(projection.checkpointCursor).toBe("cursor-599")
    expect(projection.revision).toBe(599)
  })

  it("preserves prose and activity order while reconciling tool results", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "0", sequence: 0, type: "model.input.prepared", createdAt: 0 },
      { cursor: "1", sequence: 1, type: "model.output.delta", createdAt: 1, text: "first" },
      { cursor: "1b", sequence: 2, type: "model.output.completed", createdAt: 2, text: "first" },
      {
        cursor: "2",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: { tool_call_id: "call", tool_name: "read", input: "a" },
      },
      {
        cursor: "3",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: { tool_call_id: "call", output: "ok" },
      },
      { cursor: "4", sequence: 5, type: "model.input.prepared", createdAt: 5 },
      { cursor: "5", sequence: 6, type: "model.output.delta", createdAt: 6, text: "final" },
      { cursor: "6", sequence: 7, type: "model.output.completed", createdAt: 7, text: "final" },
      { cursor: "7", sequence: 8, type: "execution.completed", createdAt: 8 },
    ])

    expect(projection.units.map((unit) => unit.content._tag)).toEqual(["Entry", "Entry", "Block", "Entry"])
    expect(projection.units.find((unit) => unit.key === "turn:turn-a:user")).toMatchObject({
      executionOutcome: { status: "complete" },
    })
    expect(projection.units[2]).toMatchObject({
      key: "tool:turn-a:call",
      revision: 4,
      content: { _tag: "Block", block: { _tag: "ToolCall", output: "ok", status: "complete" } },
    })
    expect(projection.units[3]).toMatchObject({ content: { _tag: "Entry", text: "final" } })
    expect(
      projection.units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user"),
    ).toHaveLength(1)
  })

  it("does not replay the execution-wide completion text into the final assistant phase", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "0", sequence: 0, type: "model.input.prepared", createdAt: 0 },
      { cursor: "1", sequence: 1, type: "model.output.delta", createdAt: 1, text: "first" },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: { tool_call_id: "read", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "3",
        sequence: 3,
        type: "tool.result.received",
        createdAt: 3,
        data: { tool_call_id: "read", output: { text: "contents" } },
      },
      { cursor: "4", sequence: 4, type: "model.output.delta", createdAt: 4, text: "final" },
      {
        cursor: "5",
        sequence: 5,
        type: "model.output.completed",
        createdAt: 5,
        text: "firstfinal",
        data: { model_output: "firstfinal" },
      },
    ])
    expect(
      projection.units.flatMap((unit) =>
        unit.content._tag === "Entry" && unit.content.role === "assistant" ? [unit.content.text] : [],
      ),
    ).toEqual(["first", "final"])
  })

  it("projects completed unified diffs from any tool result", () => {
    const projection = project("turn-a", "change files", [
      {
        cursor: "1",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "change-1", tool_name: "bash", input: { command: "make changes" } },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "change-1",
          output: {
            text: "changed 2 files",
            diff:
              "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n" +
              "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+hello",
          },
        },
      },
    ])
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:change-1",
      content: {
        _tag: "Block",
        block: {
          status: "complete",
          files: [
            { path: "src/a.ts", preview: false },
            { path: "src/b.ts", preview: false },
          ],
        },
      },
    })
  })

  it("uses child payload status and keeps one stable child row", () => {
    const projection = project("turn-a", "delegate", [
      {
        cursor: "1",
        sequence: 1,
        type: "child_run.spawned",
        createdAt: 1,
        data: { child_execution_id: "child-1", preset_name: "Oracle" },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "child_run.event",
        createdAt: 2,
        data: { child_execution_id: "child-1", preset_name: "Oracle", status: "failed", error: "no result" },
      },
    ])
    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "child:turn-a:child-1",
      content: { _tag: "Block", block: { _tag: "ChildAgent", id: "child-1", status: "failed" } },
    })
  })

  it("merges a correlated spawn and child lifecycle into one named tool unit", () => {
    const childId = "execution:turn-a:child:oracle"
    const projection = project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "agent",
          tool_name: "spawn_child_run",
          input: { profile: "oracle", prompt: "Find the projection defect" },
        },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { tool_call_id: "agent", child_execution_id: childId },
      },
      {
        cursor: "started",
        sequence: 3,
        type: "child_run.started",
        createdAt: 3,
        data: { child_execution_id: childId, profile: "oracle" },
      },
      {
        cursor: "completed",
        sequence: 4,
        type: "child_run.completed",
        createdAt: 4,
        data: { child_execution_id: childId, profile: "oracle" },
      },
    ])

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      revision: 4,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          childId,
          status: "complete",
          detail: "Find the projection defect",
          presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
        },
      },
    })
  })

  it("labels a spawn call Subagent working before any child metadata arrives", () => {
    const projection = project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "transfer_to_task", input: { prompt: "Inspect the projection" } },
      },
    ])
    const block =
      projection.units[1]?.content._tag === "Block" && projection.units[1].content.block._tag === "ToolCall"
        ? projection.units[1].content.block
        : undefined
    expect(block?.presentation).toMatchObject({
      family: "agent",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    })
    expect(block?.presentation.activeLabel).not.toContain("(task)")
  })

  it("uses a later durable child completion instead of an earlier subagent tool error", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "agent",
          tool_name: "spawn_child_run",
          input: { profile: "task", prompt: "Inspect the projection" },
        },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "agent", error: "AgentToolError: Model gpt-5.6-luna is not available" },
      },
      {
        cursor: "completed",
        sequence: 3,
        type: "child_run.completed",
        createdAt: 3,
        data: {
          tool_call_id: "agent",
          child_execution_id: "child:agent",
          profile: "task",
          summary: "The child recovered and returned an answer.",
        },
      },
    ]
    const live = project("turn-a", "delegate", events)
    const replayed = events.reduce((current, event) => applyEvent(current, event), empty("turn-a", "delegate"))
    for (const projection of [live, replayed])
      expect(projection.units[1]).toMatchObject({
        key: "tool:turn-a:agent",
        content: {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            status: "complete",
            detail: "Inspect the projection",
            output: "The child recovered and returned an answer.",
          },
        },
      })
  })

  it("keeps a terminal child result from presenting a failed or cancelled subagent as finished", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const projection = project("turn-a", "delegate", [
        {
          cursor: `call-${status}`,
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Inspect the projection" } },
        },
        {
          cursor: `result-${status}`,
          sequence: 2,
          type: "tool.result.received",
          createdAt: 2,
          data: { tool_call_id: "agent", output: { childExecutionId: "child:agent", status, output: [] } },
        },
      ])
      expect(projection.units[1]).toMatchObject({
        content: { _tag: "Block", block: { _tag: "ToolCall", status } },
      })
    }
  })

  it("treats a completed final assistant response as the child outcome despite a later execution failure", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "tool",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "read", tool_name: "read" },
      },
      {
        cursor: "tool-error",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "read", error: "file missing" },
      },
      { cursor: "answer", sequence: 3, type: "model.output.completed", createdAt: 3, text: "Usable final response" },
      { cursor: "failed", sequence: 4, type: "execution.failed", createdAt: 4, text: "internal tool failed" },
    ]

    for (const projection of [
      project("child", "delegate", events),
      events.reduce((current, event) => applyEvent(current, event), empty("child", "delegate")),
    ]) {
      expect(projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "complete",
      })
      expect(projection.units).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.objectContaining({ block: expect.objectContaining({ _tag: "Error" }) }),
          }),
        ]),
      )
      expect(projection.units).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.objectContaining({
              block: expect.objectContaining({ _tag: "ToolCall", status: "failed" }),
            }),
          }),
        ]),
      )
    }
  })

  it.each([
    [
      "partial output without completion",
      [{ cursor: "partial", sequence: 3, type: "model.output.delta", createdAt: 3, text: "Partial response" }],
    ],
    [
      "an empty completion after partial output",
      [
        { cursor: "partial", sequence: 3, type: "model.output.delta", createdAt: 3, text: "Partial response" },
        { cursor: "empty", sequence: 4, type: "model.output.completed", createdAt: 4, text: "" },
      ],
    ],
    [
      "a completed response before later tool activity",
      [
        { cursor: "answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "Stale response" },
        {
          cursor: "tool",
          sequence: 2,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "read", tool_name: "read" },
        },
        {
          cursor: "tool-error",
          sequence: 3,
          type: "tool.result.received",
          createdAt: 3,
          data: { tool_call_id: "read", error: "file missing" },
        },
      ],
    ],
  ] as const)("keeps execution failure after %s", (_name, precedingEvents) => {
    const events: ReadonlyArray<SourceEvent> = [
      ...precedingEvents,
      { cursor: "failed", sequence: 5, type: "execution.failed", createdAt: 5, text: "internal tool failed" },
    ]

    for (const projection of [
      project("child", "delegate", events),
      events.reduce((current, event) => applyEvent(current, event), empty("child", "delegate")),
    ]) {
      expect(projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "failed",
        reason: "internal tool failed",
      })
    }
  })

  it("keeps the ToolError message as the output of a failed tool result", () => {
    const projection = project("turn-a", "prompt", [
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
        data: { tool_call_id: "call", output: { _tag: "ToolError", tool: "read", message: "file missing" } },
      },
    ])
    expect(projection.units[1]).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "failed", output: "file missing" } },
    })
  })

  it("links a Relay handoff spawn to its encoded tool call and keeps the supplied prompt", () => {
    const callId = "rika:execution%3Aparent:spawn-oracle"
    const childId = `execution:parent:child:${callId}`
    const projection = project("turn-a", "delegate", [
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
      key: `tool:turn-a:${callId}`,
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

  it("keeps a process wait as its own row and names it from the parent command", () => {
    const projection = project("turn-a", "run tests", [
      {
        cursor: "bash",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "bash-1", tool_name: "bash", input: { command: "bun test" } },
      },
      {
        cursor: "shell-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "bash-1", output: { text: "", processId: "process-1", running: true } },
      },
      {
        cursor: "wait",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: {
          tool_call_id: "wait-1",
          tool_name: "shell_command_status",
          input: { processId: "process-1" },
        },
      },
      {
        cursor: "wait-result",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: {
          tool_call_id: "wait-1",
          output: { text: "failed", processId: "process-1", running: false, exitCode: 7 },
        },
      },
    ])
    expect(projection.units).toHaveLength(3)
    expect(projection.units[2]).toMatchObject({
      key: "tool:turn-a:wait-1",
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          parentId: "turn-a:bash-1",
          detail: "bun test",
          status: "failed",
          process: { exitCode: 7 },
          presentation: { activeLabel: "Waiting for", completeLabel: "Waited for" },
        },
      },
    })
  })

  it("applies duplicate and older source events idempotently", () => {
    const event: SourceEvent = {
      cursor: "cursor-1",
      sequence: 1,
      type: "model.output.delta",
      createdAt: 1,
      text: "answer",
    }
    const once = applyEvent(empty("turn-a", "prompt"), event)
    expect(applyEvent(once, event)).toEqual(once)
    expect(applyEvent(once, { ...event, cursor: "cursor-0", sequence: 0, text: "stale" })).toEqual(once)
  })

  it("projects every semantic block shape with stable keys across lifecycle revisions", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "reason", sequence: 0, type: "model.reasoning.delta", createdAt: 0, text: "thinking" },
      {
        cursor: "tool",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "read", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "orphan", output: "orphan result" },
      },
      { cursor: "diff-1", sequence: 3, type: "workspace.diff", createdAt: 3, data: { path: "a.ts", patch: "-a\n+b" } },
      { cursor: "diff-2", sequence: 4, type: "workspace.diff", createdAt: 4, data: { path: "a.ts", patch: "-a\n+c" } },
      {
        cursor: "usage",
        sequence: 5,
        type: "model.usage.reported",
        createdAt: 5,
        data: { input_tokens: 10, output_tokens: 20, model: "test" },
      },
      {
        cursor: "compaction-1",
        sequence: 6,
        type: "context.compacted",
        createdAt: 6,
        data: { summary: "Earlier work", checkpoint: "checkpoint-1" },
      },
      {
        cursor: "compaction-2",
        sequence: 7,
        type: "context.compacted",
        createdAt: 7,
        data: { summary: "Updated work", checkpoint: "checkpoint-2" },
      },
      {
        cursor: "notice",
        sequence: 8,
        type: "notification.created",
        createdAt: 8,
        data: { title: "Ready", detail: "Review the result" },
      },
      {
        cursor: "permission-1",
        sequence: 9,
        type: "permission.ask.requested",
        createdAt: 9,
        data: { wait_id: "permission", title: "Allow read", input: { path: "a.ts" } },
      },
      {
        cursor: "permission-2",
        sequence: 10,
        type: "permission.ask.resolved",
        createdAt: 10,
        data: { wait_id: "permission", title: "Allow read", approved: false },
      },
      {
        cursor: "child-1",
        sequence: 11,
        type: "child_run.spawned",
        createdAt: 11,
        data: { child_execution_id: "child", preset_name: "task" },
      },
      {
        cursor: "child-2",
        sequence: 12,
        type: "child_run.completed",
        createdAt: 12,
        data: { child_execution_id: "child", preset_name: "task", summary: "done" },
      },
      {
        cursor: "workflow-1",
        sequence: 13,
        type: "workflow.waiting",
        createdAt: 13,
        data: { run_id: "delivery-1", workflow: "delivery", step: "approval" },
      },
      {
        cursor: "workflow-2",
        sequence: 14,
        type: "workflow.completed",
        createdAt: 14,
        data: { run_id: "delivery-1", workflow: "delivery", step: "done" },
      },
      {
        cursor: "image",
        sequence: 15,
        type: "image.attachment.created",
        createdAt: 15,
        data: { id: "image-1", name: "shot.png", media_type: "image/png", width: 80, height: 40, bytes: 120 },
      },
      { cursor: "error", sequence: 16, type: "budget.exceeded", createdAt: 16, data: { message: "Budget exhausted" } },
    ])

    expect(
      projection.units.flatMap((item) => (item.content._tag === "Block" ? [item.content.block._tag] : [])),
    ).toEqual([
      "Reasoning",
      "ToolCall",
      "ToolResult",
      "Diff",
      "Compaction",
      "Notification",
      "Permission",
      "ChildAgent",
      "Workflow",
      "ImageAttachment",
      "Error",
    ])
    expect(projection.units.filter((item) => item.key.includes("a.ts") && item.key.startsWith("diff:"))).toHaveLength(1)
    expect(projection.units.filter((item) => item.key.startsWith("workflow:")).map((item) => item.revision)).toEqual([
      14,
    ])
    expect(projection.units.find((item) => item.key === "compaction:turn-a")).toMatchObject({ revision: 7 })
    expect(projection.units.find((item) => item.key === "permission:turn-a:permission")).toMatchObject({
      content: { _tag: "Block", block: { status: "denied" } },
    })
    expect(projection.revision).toBe(16)
    expect(projection.oldestCursor).toBe("reason")
    expect(projection.checkpointCursor).toBe("error")
  })

  it("checkpoints every observable Relay event shape without replay duplication", () => {
    const events: ReadonlyArray<SourceEvent> = [
      { cursor: "accepted", sequence: 0, type: "execution.accepted", createdAt: 0 },
      { cursor: "started", sequence: 1, type: "execution.started", createdAt: 1 },
      { cursor: "input", sequence: 2, type: "model.input.prepared", createdAt: 2 },
      { cursor: "output", sequence: 3, type: "model.output.completed", createdAt: 3, text: "answer" },
      { cursor: "usage", sequence: 4, type: "model.usage.reported", createdAt: 4, data: { cost_usd: 0.25 } },
      {
        cursor: "call",
        sequence: 5,
        type: "tool.call.requested",
        createdAt: 5,
        data: { tool_call_id: "call", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "result",
        sequence: 6,
        type: "tool.result.received",
        createdAt: 6,
        data: { tool_call_id: "call", output: "ok" },
      },
      {
        cursor: "approval-requested",
        sequence: 7,
        type: "tool.approval.requested",
        createdAt: 7,
        data: { wait_id: "approval", tool_name: "bash" },
      },
      {
        cursor: "approval-resolved",
        sequence: 8,
        type: "tool.approval.resolved",
        createdAt: 8,
        data: { wait_id: "approval", tool_name: "bash", approved: true },
      },
      {
        cursor: "permission-requested",
        sequence: 9,
        type: "permission.ask.requested",
        createdAt: 9,
        data: { wait_id: "permission" },
      },
      {
        cursor: "permission-resolved",
        sequence: 10,
        type: "permission.ask.resolved",
        createdAt: 10,
        data: { wait_id: "permission", approved: true },
      },
      { cursor: "wait-created", sequence: 11, type: "wait.created", createdAt: 11, data: { wait_id: "wait" } },
      { cursor: "wait-woken", sequence: 12, type: "wait.woken", createdAt: 12, data: { wait_id: "wait" } },
      { cursor: "wait-timeout", sequence: 13, type: "wait.timed_out", createdAt: 13, data: { wait_id: "wait" } },
      { cursor: "wait-cancel", sequence: 14, type: "wait.cancelled", createdAt: 14, data: { wait_id: "wait" } },
      {
        cursor: "child",
        sequence: 15,
        type: "child_run.spawned",
        createdAt: 15,
        data: { child_execution_id: "child" },
      },
      { cursor: "fan-out", sequence: 16, type: "child_fan_out.created", createdAt: 16, data: { fan_out_id: "fan" } },
      {
        cursor: "member",
        sequence: 17,
        type: "child_fan_out.member.terminal",
        createdAt: 17,
        data: { member: { child_execution_id: "member", status: "failed", error: "member failed" } },
      },
      {
        cursor: "fan-terminal",
        sequence: 18,
        type: "child_fan_out.terminal",
        createdAt: 18,
        data: { fan_out_id: "fan" },
      },
      { cursor: "budget", sequence: 19, type: "budget.exceeded", createdAt: 19, data: { message: "budget" } },
      { cursor: "completed", sequence: 20, type: "execution.completed", createdAt: 20 },
      { cursor: "failed", sequence: 21, type: "execution.failed", createdAt: 21, text: "failed" },
      { cursor: "cancelled", sequence: 22, type: "execution.cancelled", createdAt: 22 },
    ]
    let projection = empty("turn-a", "prompt")
    for (const event of events) {
      projection = applyEvent(projection, event)
      expect(projection.revision).toBe(event.sequence)
      expect(projection.checkpointCursor).toBe(event.cursor)
      expect(applyEvent(projection, event)).toEqual(projection)
    }

    expect(projection.units.find((item) => item.key === "permission:turn-a:approval")).toMatchObject({
      content: { _tag: "Block", block: { status: "approved" } },
    })
    expect(projection.units.find((item) => item.key === "child:turn-a:member")).toMatchObject({
      content: { _tag: "Block", block: { status: "failed", summary: "member failed" } },
    })
    expect(
      projection.units.filter((item) => item.content._tag === "Block" && item.content.block._tag === "Error"),
    ).toHaveLength(2)
  })

  it("keeps nested keys, revisions, parents, and deterministic source order without mutating inputs", () => {
    const root = project("root", "prompt", [
      {
        cursor: "tool",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: { tool_call_id: "child", tool_name: "task", input: { prompt: "work" } },
      },
    ])
    const child = project("child", "", [
      { cursor: "answer", sequence: 7, type: "model.output.completed", createdAt: 7, text: "done" },
    ])
    const rootBefore = structuredClone(root)
    const childBefore = structuredClone(child)
    const first = withNestedProjections(root, [{ parentId: "root:child", projection: child }])
    const second = withNestedProjections(root, [{ parentId: "root:child", projection: child }])

    expect(first).toEqual(second)
    expect(root).toEqual(rootBefore)
    expect(child).toEqual(childBefore)
    expect(first.units.map(({ key, revision, parentId, order }) => ({ key, revision, parentId, order }))).toEqual([
      { key: "turn:root:user", revision: 0, parentId: undefined, order: { sequence: 0, part: 0 } },
      { key: "tool:root:child", revision: 2, parentId: undefined, order: { sequence: 1, part: 0 } },
      { key: "turn:child:user", revision: 0, parentId: "root:child", order: { sequence: 2, part: 0 } },
      { key: "assistant:child:0", revision: 7, parentId: "root:child", order: { sequence: 3, part: 0 } },
    ])
  })

  it("keeps a recovered root completion on the root execution instead of its failed nested child", () => {
    const root = empty("root", "delegate")
    const failedChild = project("child", "", [
      { cursor: "failed", sequence: 0, type: "execution.failed", createdAt: 1, text: "child failed" },
    ])
    const flattened = withNestedProjections(root, [{ parentId: "root:agent", projection: failedChild }])
    const completed = applyEvent(flattened, {
      cursor: "root-done",
      sequence: 1,
      type: "execution.completed",
      createdAt: 2,
    })
    const reloaded = withNestedProjections(completed, [{ parentId: "root:agent", projection: failedChild }])

    expect(reloaded.units.find((unit) => unit.key === "turn:root:user")?.executionOutcome).toEqual({
      status: "complete",
    })
    expect(
      reloaded.units.find((unit) => unit.turnId === "child" && unit.executionOutcome !== undefined)?.executionOutcome,
    ).toEqual({
      status: "failed",
      reason: "child failed",
    })
  })

  it("persists a hidden execution outcome when an execution has no root user unit", () => {
    const root = project("root", "prompt", [
      { cursor: "answer", sequence: 0, type: "model.output.completed", createdAt: 1, text: "answer" },
    ])
    const projection = applyEvent(
      { ...root, units: root.units.filter((unit) => unit.content._tag !== "Entry" || unit.content.role !== "user") },
      { cursor: "done", sequence: 1, type: "execution.completed", createdAt: 2 },
    )

    expect(projection.units).toContainEqual(
      expect.objectContaining({
        key: "execution:root:outcome",
        revision: 1,
        executionOutcome: { status: "complete" },
      }),
    )
  })

  it("counts usage cost when the revision was poisoned by higher foreign sequences", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "foreign", sequence: 4526, type: "model.output.delta", createdAt: 0, text: "child text" },
      {
        cursor: "usage-9",
        sequence: 9,
        type: "model.usage.reported",
        createdAt: 1,
        data: { cost_usd: 1.25 },
      },
      {
        cursor: "usage-30",
        sequence: 30,
        type: "model.usage.reported",
        createdAt: 2,
        data: { cost_usd: 1.25 },
      },
    ])

    expect(projection.revision).toBe(4526)
    expect(projection.checkpointCursor).toBe("foreign")
    expect(projection.costUsd).toBeCloseTo(2.5, 10)
    expect(projection.usageCursors).toEqual(["usage-9", "usage-30"])
  })

  it("uses models.dev context tiers at their published threshold", () => {
    const model = providers.openai!.models["gpt-5.6-sol"]!
    const tier = model.cost!.tiers![0]!
    const event = (cursor: string, inputTokens: number): SourceEvent => ({
      cursor,
      sequence: 1,
      type: "model.usage.reported",
      createdAt: 1,
      data: {
        provider: "openai",
        model: model.id,
        input_tokens: inputTokens,
        input_tokens_uncached: inputTokens,
        output_tokens: 0,
      },
    })

    expect(project("below", "", [event("below", tier.tier.size - 1)]).costUsd).toBeCloseTo(
      ((tier.tier.size - 1) * model.cost!.input) / 1_000_000,
      10,
    )
    expect(project("at", "", [event("at", tier.tier.size)]).costUsd).toBeCloseTo(
      (tier.tier.size * tier.input) / 1_000_000,
      10,
    )
    expect(project("at", "", [event("at", tier.tier.size)]).pricingVersion).toBeDefined()
  })

  it("counts duplicate and out-of-order usage events exactly once", () => {
    const first = applyEvent(empty("turn-a", "prompt"), usage("usage-5", 5))
    const duplicated = applyEvent(applyEvent(first, usage("usage-5", 5)), usage("usage-5", 2))
    const reordered = applyEvent(duplicated, usage("usage-2", 2))

    expect(duplicated.costUsd).toBeCloseTo(1.25, 10)
    expect(reordered.costUsd).toBeCloseTo(2.5, 10)
    expect(reordered.revision).toBe(5)
    expect(reordered.checkpointCursor).toBe("usage-5")
    expect(reordered.usageCursors).toEqual(["usage-5", "usage-2"])
  })

  it("settles running tool and child blocks when the execution fails or is cancelled", () => {
    const base: ReadonlyArray<SourceEvent> = [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawn",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { child_execution_id: "orphan-child", preset_name: "task" },
      },
    ]
    const cancelled = project("turn-a", "prompt", [
      ...base,
      { cursor: "cancelled", sequence: 3, type: "execution.cancelled", createdAt: 3 },
    ])
    const failed = project("turn-a", "prompt", [
      ...base,
      { cursor: "failed", sequence: 3, type: "execution.failed", createdAt: 3, data: { message: "boom" } },
    ])

    expect(cancelled.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "cancelled" } },
    })
    expect(cancelled.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "cancelled" } },
    })
    expect(failed.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "failed" } },
    })
    expect(failed.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "failed" } },
    })
  })

  it("settles linked tools and standalone child agents through the settlement helpers", () => {
    const projection = project("turn-a", "prompt", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawn",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { tool_call_id: "call", child_execution_id: "child-1", preset_name: "task" },
      },
      {
        cursor: "orphan",
        sequence: 3,
        type: "child_run.spawned",
        createdAt: 3,
        data: { child_execution_id: "orphan-child", preset_name: "task" },
      },
    ])
    const settledLinked = settleChild(projection, "child-1", "complete", 99)
    const settledOrphan = settleChild(settledLinked, "orphan-child", "cancelled", 99)
    const swept = settleRunning(projection, "cancelled", 50)

    expect(settledLinked.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      revision: 99,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "complete", childId: "child-1" } },
    })
    expect(settledOrphan.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      revision: 99,
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "cancelled" } },
    })
    expect(hasRunningBlocks(projection)).toBe(true)
    expect(hasRunningBlocks(settledOrphan)).toBe(false)
    expect(hasRunningBlocks(swept)).toBe(false)
    expect(settleChild(settledOrphan, "child-1", "failed", 120)).toEqual(settledOrphan)
  })

  it("matches a child to its scoped parent tool and rejects a same-callId tool in another scope", () => {
    const foreign = { id: "other:spawn", scope: "other", childId: undefined, family: "agent" as const, mark: "foreign" }
    const correct = {
      id: "parent:spawn",
      scope: "parent",
      childId: undefined,
      family: "agent" as const,
      mark: "correct",
    }
    const childId = "execution:parent:child:spawn"

    expect(childParentMatch([foreign, correct], childId)?.mark).toBe("correct")
    expect(childParentMatch([foreign], childId)).toBeUndefined()
  })

  it("prefers an exact childId match over a scoped fallback candidate", () => {
    const fallback = {
      id: "parent:spawn",
      scope: "parent",
      childId: undefined,
      family: "agent" as const,
      mark: "fallback",
    }
    const exact = {
      id: "parent:other",
      scope: "parent",
      childId: "execution:parent:child:spawn",
      family: "agent" as const,
      mark: "exact",
    }

    expect(childParentMatch([fallback, exact], "execution:parent:child:spawn")?.mark).toBe("exact")
  })

  it("ignores a non-agent tool even when its scope and call id match the child key", () => {
    const nonAgent = { id: "parent:spawn", scope: "parent", childId: undefined, family: "shell" as const }

    expect(childParentMatch([nonAgent], "execution:parent:child:spawn")).toBeUndefined()
  })

  it("matches a scoped parent for the url-encoded child id encoding without a spawn correlation", () => {
    const parent = { id: "parent-turn:agent", scope: "parent-turn", childId: undefined, family: "agent" as const }

    expect(childParentMatch([parent], "child:execution%3Aparent-turn:agent")).toBe(parent)
  })

  it("resolves a nested fan-out child id to its correctly scoped orchestrator tool", () => {
    const orchestratorId = "child:execution%3Aturn:rika:execution%3Aturn:call-orchestrator"
    const nestedId = `child:${encodeURIComponent(orchestratorId)}:rika:${encodeURIComponent(orchestratorId)}:one`
    const nestedTool = {
      id: `${orchestratorId}:one`,
      scope: orchestratorId,
      childId: undefined,
      family: "agent" as const,
    }
    const foreign = {
      id: "other-turn:one",
      scope: "other-turn",
      childId: undefined,
      family: "agent" as const,
    }

    expect(childParentMatch([foreign, nestedTool], nestedId)).toBe(nestedTool)
  })

  it("rejects a same-callId tool in another scope for the url-encoded encoding", () => {
    const foreign = { id: "other-turn:agent", scope: "other-turn", childId: undefined, family: "agent" as const }

    expect(childParentMatch([foreign], "child:execution%3Aparent-turn:agent")).toBeUndefined()
  })

  it("ensures a scoped agent tool for a child and stays idempotent when it already exists", () => {
    const childId = "execution:parent:child:spawn"
    const created = ensureChildTool(empty("parent", "prompt"), childId, "oracle")

    expect(created.tool).toMatchObject({ _tag: "ToolCall", id: "parent:child:spawn", childId })
    expect(created.tool.presentation.family).toBe("agent")
    expect(created.projection.units.find((unit) => unit.key === "tool:parent:child:spawn")).toBeDefined()

    const again = ensureChildTool(created.projection, childId, "oracle")

    expect(again.projection).toBe(created.projection)
    expect(again.tool.id).toBe("parent:child:spawn")
    expect(
      again.projection.units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"),
    ).toHaveLength(1)
  })

  it("records one error unit with a failed outcome and a non-empty reason when the execution fails", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "failed", sequence: 1, type: "execution.failed", createdAt: 1, text: "internal tool failed" },
    ])
    const errors = projection.units.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error",
    )

    expect(errors).toHaveLength(1)
    const error = errors[0]!
    expect(
      error.content._tag === "Block" && error.content.block._tag === "Error" ? error.content.block.detail : "",
    ).toBe("internal tool failed")
    expect(error.executionOutcome).toMatchObject({ status: "failed", reason: "internal tool failed" })
  })
})
