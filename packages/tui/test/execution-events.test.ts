import { describe, expect, it } from "@effect/vitest"
import { ExecutionEvents, ViewState } from "../src"
import { renderTranscript } from "../src/adapter"

describe("ExecutionEvents", () => {
  it("deduplicates overlapping delivery and keeps late completion scoped to its turn", () => {
    let model = ViewState.initial("/work")
    model = ViewState.update(model, { _tag: "TurnStarted", turnId: "a", prompt: "A" })
    const delta = { turnId: "a", cursor: "a-1", sequence: 1, type: "model.output.delta", text: "draft" }
    model = ExecutionEvents.project(model, [delta, delta])
    model = ViewState.update(model, { _tag: "TurnStarted", turnId: "b", prompt: "B" })
    model = ExecutionEvents.project(model, [
      { turnId: "a", cursor: "a-2", sequence: 2, type: "model.output.completed", text: "answer A" },
      { turnId: "a", cursor: "a-3", sequence: 3, type: "execution.completed" },
      { turnId: "b", cursor: "b-1", sequence: 1, type: "model.output.completed", text: "answer B" },
    ])
    expect(model.entries).toEqual([
      { role: "user", text: "A", turnId: "a" },
      { role: "assistant", text: "answer A", turnId: "a" },
      { role: "user", text: "B", turnId: "b" },
      { role: "assistant", text: "answer B", turnId: "b" },
    ])
    expect(model.activeTurnId).toBe("b")
    expect(model.busy).toBe(true)
  })

  it("preserves prose and activity interleaving across live projection and reopen replay", () => {
    const events: ReadonlyArray<ExecutionEvents.Event> = [
      { cursor: "1", sequence: 1, type: "model.output.delta", text: "first" },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.call.requested",
        data: { tool_call_id: "call", tool_name: "read", input: "a" },
      },
      { cursor: "3", sequence: 3, type: "tool.result.received", data: { tool_call_id: "call", output: "ok" } },
      { cursor: "4", sequence: 4, type: "model.output.delta", text: "second" },
      { cursor: "5", sequence: 5, type: "diff.completed", data: { path: "a.ts", patch: "+change" } },
      { cursor: "6", sequence: 6, type: "model.output.completed", text: "final" },
    ]
    const live = ExecutionEvents.project(ViewState.initial("/work"), events)
    const reopened = ExecutionEvents.project(ViewState.initial("/work"), events)
    expect(renderTranscript(reopened)).toBe(renderTranscript(live))
    expect(renderTranscript(live)).toMatch(/first[\s\S]*read[\s\S]*second[\s\S]*a\.ts[\s\S]*final/)
  })
  it("reconciles live reasoning and tool event sequences", () => {
    const events: ReadonlyArray<ExecutionEvents.Event> = [
      { cursor: "1", sequence: 1, type: "model.reasoning.delta", text: "checking " },
      { cursor: "2", sequence: 2, type: "model.reasoning.delta", text: "files" },
      {
        cursor: "3",
        sequence: 3,
        type: "tool.call.requested",
        data: { tool_call_id: "call-1", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "4",
        sequence: 4,
        type: "tool.result.received",
        data: { tool_call_id: "call-1", tool_name: "read", output: "contents" },
      },
      {
        cursor: "5",
        sequence: 5,
        type: "tool.call.requested",
        data: { tool_call_id: "call-2", tool_name: "write", input: { path: "b.ts" } },
      },
      {
        cursor: "6",
        sequence: 6,
        type: "tool.result.received",
        data: { tool_call_id: "call-2", tool_name: "write", output: "denied", error: "denied" },
      },
    ]
    const model = ExecutionEvents.project(ViewState.initial("/work"), events)
    expect(model.blocks).toEqual([
      { _tag: "Reasoning", text: "checking files", expanded: false },
      expect.objectContaining({ _tag: "ToolCall", id: "call-1", status: "complete", output: "contents" }),
      expect.objectContaining({ _tag: "ToolCall", id: "call-2", status: "failed", output: "denied" }),
    ])
  })

  it("does not project generic or child waits as permissions", () => {
    const model = ExecutionEvents.project(ViewState.initial("/work"), [
      {
        cursor: "wait",
        sequence: 1,
        type: "wait.created",
        data: { wait_id: "wait-42", mode: "event", tool_name: "create_file", input: { path: "a.ts" } },
      },
    ])
    const child = ExecutionEvents.project(model, [
      { cursor: "child", sequence: 2, type: "wait.created", data: { wait_id: "child-1", mode: "child" } },
    ])
    expect(child.blocks).toEqual([])
  })

  it("projects and reconciles tool approval events as one permission card", () => {
    const model = ExecutionEvents.project(ViewState.initial("/work"), [
      {
        cursor: "wait",
        sequence: 1,
        type: "wait.created",
        data: { wait_id: "wait-42", mode: "event" },
      },
      {
        cursor: "requested",
        sequence: 2,
        type: "tool.approval.requested",
        data: { wait_id: "wait-42", tool_name: "create_file", input: { path: "a.ts" } },
      },
      {
        cursor: "resolved",
        sequence: 3,
        type: "tool.approval.resolved",
        data: { wait_id: "wait-42", tool_name: "create_file", input: { path: "a.ts" }, approved: false },
      },
    ])
    expect(model.blocks).toEqual([
      {
        _tag: "Permission",
        id: "wait-42",
        kind: "tool-approval",
        title: "create_file",
        detail: '{"path":"a.ts"}',
        status: "denied",
      },
    ])
  })

  it("projects two persisted Turns with overlapping event identities exactly once", () => {
    const events: ReadonlyArray<ExecutionEvents.Event> = [
      { cursor: "1", sequence: 1, type: "model.output.completed", text: "answer" },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.call.requested",
        data: { tool_call_id: "call", tool_name: "read", input: "file" },
      },
      {
        cursor: "3",
        sequence: 3,
        type: "tool.result.received",
        data: { tool_call_id: "call", output: "contents" },
      },
    ]
    let model = ExecutionEvents.projectTurn(ViewState.initial("/work"), "turn-1", "first prompt", events)
    model = ExecutionEvents.projectTurn(model, "turn-2", "second prompt", events)

    expect(model.entries).toEqual([
      { role: "user", text: "first prompt", turnId: "turn-1" },
      { role: "assistant", text: "answer", turnId: "turn-1" },
      { role: "user", text: "second prompt", turnId: "turn-2" },
      { role: "assistant", text: "answer", turnId: "turn-2" },
    ])
    expect(model.blocks).toEqual([
      expect.objectContaining({ _tag: "ToolCall", id: "turn-1:call", output: "contents", status: "complete" }),
      expect.objectContaining({ _tag: "ToolCall", id: "turn-2:call", output: "contents", status: "complete" }),
    ])
    expect(model.seenEventIds).toEqual([
      "turn-1:2:tool.call.requested",
      "turn-1:3:tool.result.received",
      "turn-2:2:tool.call.requested",
      "turn-2:3:tool.result.received",
    ])
  })

  it("clears Waiting and projects one opaque terminal failure", () => {
    const failed: ExecutionEvents.Event = {
      cursor: "failure-1",
      sequence: 1,
      type: "execution.failed",
      text: "opaque provider failure",
    }
    let model = ExecutionEvents.projectTurn(ViewState.initial("/work"), "turn-failed", "prompt", [])
    expect(model.busyStatus).toBe("Waiting")
    model = ExecutionEvents.project(model, [
      { ...failed, turnId: "turn-failed" },
      { ...failed, turnId: "turn-failed" },
    ])

    expect(model.busy).toBe(false)
    expect(model.busyStatus).toBeUndefined()
    expect(model.activeTurnId).toBeUndefined()
    expect(model.blocks).toEqual([expect.objectContaining({ _tag: "Error", detail: "opaque provider failure" })])
  })

  it("projects every execution event family and fallback", () => {
    const events: ReadonlyArray<ExecutionEvents.Event> = [
      { cursor: "1", sequence: 1, type: "model.output.delta", text: "a" },
      { cursor: "2", sequence: 2, type: "model.output.delta" },
      { cursor: "3", sequence: 3, type: "reasoning.delta", content: [{ text: "why" }] },
      {
        cursor: "4",
        sequence: 4,
        type: "tool.started",
        content: [{ call_id: "call", tool: "read", input: { path: "a" } }],
      },
      { cursor: "5", sequence: 5, type: "tool.result.failed", content: [{ id: "call", result: "bad", failed: true }] },
      { cursor: "6", sequence: 6, type: "permission.requested", content: [{ wait_id: "wait", input: "allow?" }] },
      { cursor: "7", sequence: 7, type: "permission.denied", content: [{ id: "wait" }] },
      { cursor: "8", sequence: 8, type: "permission.resolved", content: [{ id: "wait" }] },
      { cursor: "9", sequence: 9, type: "child.started", content: [{ childId: "child" }] },
      { cursor: "10", sequence: 10, type: "child.completed", content: [{ name: "child" }] },
      { cursor: "11", sequence: 11, type: "child.failed", content: [{ error: "bad" }] },
      { cursor: "12", sequence: 12, type: "workflow.started", content: [{ name: "flow" }] },
      { cursor: "13", sequence: 13, type: "workflow.waiting", content: [{ workflow: "flow", status: "wait" }] },
      { cursor: "14", sequence: 14, type: "workflow.completed", content: [{}] },
      { cursor: "15", sequence: 15, type: "workflow.failed", content: [{}] },
      { cursor: "16", sequence: 16, type: "model.output.completed" },
      { cursor: "17", sequence: 17, type: "execution.failed" },
      { cursor: "18", sequence: 18, type: "execution.cancelled", text: "stopped" },
      { cursor: "19", sequence: 19, type: "unknown", content: [null] },
      { cursor: "20", sequence: 20, type: "execution.cancelled" },
      { cursor: "21", sequence: 21, type: "reasoning.delta", text: "direct reasoning" },
      { cursor: "22", sequence: 22, type: "tool.result", text: "direct result", content: [{ callId: "call" }] },
      {
        cursor: "23",
        sequence: 23,
        type: "permission.approved",
        text: "approved detail",
        content: [{ waitId: "wait", title: "Approved" }],
      },
      {
        cursor: "24",
        sequence: 24,
        type: "tool.started",
        content: [{ callId: "direct", name: "write", input: "README.md" }],
      },
      { cursor: "25", sequence: 25, type: "tool.started", content: [{ id: "fallback" }] },
      { cursor: "26", sequence: 26, type: "tool.failed", content: [{ id: "failed" }] },
      { cursor: "27", sequence: 27, type: "tool.completed", content: [{ id: "completed" }] },
    ]
    const messages = events.flatMap(ExecutionEvents.messages)
    expect(messages.some((message) => message._tag === "AssistantStreamed")).toBe(true)
    expect(messages.some((message) => message._tag === "AssistantCompleted")).toBe(true)
    expect(messages.filter((message) => message._tag === "ExecutionFailed")).toHaveLength(1)
    expect(messages.some((message) => message._tag === "ExecutionCancelled")).toBe(true)
    const model = ExecutionEvents.project(ViewState.initial("/work"), events)
    expect(model.blocks.length).toBeGreaterThan(10)
  })
})
