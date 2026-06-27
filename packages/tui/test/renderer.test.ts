import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Renderer, ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_tui_render")
const turnId = Ids.TurnId.make("turn_tui_render")

describe("TUI renderer", () => {
  test("renders Amp-like chrome, spinner activity, collapsed tool cards, and Pierre diff cards", () => {
    const state = ViewState.initial({
      thread_id: threadId,
      workspace_path: "/workspace/rika",
      mode: "smart",
      events: [
        threadCreated(1),
        turnStarted(2),
        messageAdded(3, "user", "write a file"),
        contextResolved(4),
        toolRequested(5),
        toolCompleted(6),
        modelChunk(7, "done"),
      ],
    })

    const text = Renderer.stripAnsi(Renderer.render(state, { width: 90, height: 80 }))

    expect(text).toContain("Rika")
    expect(text).toContain("$0.0000 · smart")
    expect(text).toContain("/workspace/rika")
    expect(text).toContain("Streaming")
    expect(text).toContain("Context resolved · 1 entries")
    expect(text).toContain("write · success · done · collapsed")
    expect(text).toContain("File diff · src/example.ts · collapsed · done · collapsed")
  })

  test("renders the command palette as an expandable terminal surface", () => {
    const state = ViewState.withPalette(
      ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep" }),
    )

    const text = Renderer.stripAnsi(Renderer.render(state, { width: 80 }))

    expect(text).toContain("Command Palette")
    expect(text).toContain("/mode rush|smart|deep")
    expect(text).toContain("$0.0000 · deep")
  })
})

const base = (sequence: number): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_tui_render_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  ...base(sequence),
  type: "thread.created",
  data: { workspace_id: Ids.WorkspaceId.make("workspace_tui") },
})

const turnStarted = (sequence: number): Event.TurnStarted => ({
  ...base(sequence),
  turn_id: turnId,
  type: "turn.started",
  data: {},
})

const messageAdded = (sequence: number, role: Message.Role, content: string): Event.MessageAdded => ({
  ...base(sequence),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_tui_render_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(content)],
      created_at: Common.TimestampMillis.make(sequence),
    },
  },
})

const contextResolved = (sequence: number): Event.ContextResolved => ({
  ...base(sequence),
  turn_id: turnId,
  type: "context.resolved",
  data: {
    entries: [{ kind: "guidance", source: "test", reason: "test", trusted: false, path: "AGENTS.md" }],
    rendered: "AGENTS",
    total_chars: 6,
  },
})

const toolRequested = (sequence: number): Event.ToolCallRequested => ({
  ...base(sequence),
  type: "tool.call.requested",
  data: { call: { id: Ids.ToolCallId.make("tool_call_tui_render"), name: "write", input: { path: "src/example.ts" } } },
})

const toolCompleted = (sequence: number): Event.ToolCallCompleted => ({
  ...base(sequence),
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make("tool_call_tui_render"),
      name: "write",
      status: "success",
      output: {
        type: "hashline.write",
        diff: {
          kind: "diff",
          renderer: "@pierre/diffs",
          file_diff: { name: "src/example.ts", isPartial: false },
        },
      },
    },
  },
})

const modelChunk = (sequence: number, text: string): Event.ModelStreamChunk => ({
  ...base(sequence),
  turn_id: turnId,
  type: "model.stream.chunk",
  data: { text, provider: "fake", model: "fake" },
})
