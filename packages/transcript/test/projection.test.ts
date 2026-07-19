import { describe, expect, it } from "@effect/vitest"
import { applyEvent, empty, project, withNestedProjections, type SourceEvent } from "../src"

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
    expect(projection.units.at(-1)).toMatchObject({ executionOutcome: { status: "complete" } })
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
        data: { tool_call_id: "read", tool_name: "read_file", input: { path: "a.ts" } },
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

  it("projects an apply_patch draft as evolving file diffs before the call completes", () => {
    let projection = empty("turn-a", "patch files")
    const fragments = [
      '{"patchText":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old',
      "\\n+new\\n*** Add File: src/b.ts\\n+hello",
      '\\n*** End Patch"}',
    ]
    for (const [index, delta] of fragments.entries())
      projection = applyEvent(projection, {
        cursor: `delta-${index}`,
        sequence: index,
        type: "model.toolcall.delta",
        createdAt: index,
        data: { tool_call_id: "patch-1", tool_name: "apply_patch", delta },
      })

    expect("drafts" in projection).toBe(false)
    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:patch-1",
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          name: "apply_patch",
          status: "running",
          presentation: { family: "edit" },
          files: [
            { key: "turn-a:patch-1:0", path: "src/a.ts", kind: "update", patch: expect.stringContaining("-old") },
            { key: "turn-a:patch-1:1", path: "src/b.ts", kind: "add", patch: expect.stringContaining("+hello") },
          ],
        },
      },
    })
  })

  it("replaces a patch preview with every completed unified diff on the same tool unit", () => {
    const projection = project("turn-a", "patch files", [
      {
        cursor: "1",
        sequence: 1,
        type: "model.toolcall.delta",
        createdAt: 1,
        data: {
          tool_call_id: "patch-1",
          tool_name: "apply_patch",
          delta: '{"patchText":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old\\n+new\\n*** End Patch"}',
        },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: {
          tool_call_id: "patch-1",
          tool_name: "apply_patch",
          input: {
            patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
          },
        },
      },
      {
        cursor: "3",
        sequence: 3,
        type: "tool.result.received",
        createdAt: 3,
        data: {
          tool_call_id: "patch-1",
          output: {
            text: "applied 2 operations",
            truncated: false,
            diff:
              "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n" +
              "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+hello",
          },
        },
      },
    ])
    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:patch-1",
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

  it("keeps a new-file result marked as a create when the events replay", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "patch",
          tool_name: "apply_patch",
          input: { patchText: "*** Begin Patch\n*** Add File: tmp-agent-test.txt\n+hello\n*** End Patch" },
        },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "patch",
          output: {
            text: "applied",
            diff: "diff --git a/tmp-agent-test.txt b/tmp-agent-test.txt\nnew file mode 100644\n--- /dev/null\n+++ b/tmp-agent-test.txt\n@@ -0,0 +1 @@\n+hello",
          },
        },
      },
    ]
    const live = project("turn-a", "create the file", events)
    const replayed = events.reduce((current, event) => applyEvent(current, event), empty("turn-a", "create the file"))
    for (const projection of [live, replayed])
      expect(projection.units[1]).toMatchObject({
        key: "tool:turn-a:patch",
        content: {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            status: "complete",
            files: [{ path: "tmp-agent-test.txt", kind: "add", preview: false }],
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
        cursor: "shell",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "shell-1", tool_name: "shell", input: { command: "bun", args: ["test"] } },
      },
      {
        cursor: "shell-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "shell-1", output: { text: "", processId: "process-1", running: true } },
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
          parentId: "turn-a:shell-1",
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
        data: { tool_call_id: "read", tool_name: "read_file", input: { path: "a.ts" } },
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
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "a.ts" } },
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
        data: { wait_id: "approval", tool_name: "shell" },
      },
      {
        cursor: "approval-resolved",
        sequence: 8,
        type: "tool.approval.resolved",
        createdAt: 8,
        data: { wait_id: "approval", tool_name: "shell", approved: true },
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
})
