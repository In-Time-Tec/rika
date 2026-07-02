import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message, Tool } from "@rika/schema"
import { ModelContext } from "../src/index"

const threadId = Ids.ThreadId.make("thread_model_context")
const turnId = Ids.TurnId.make("turn_model_context")
const now = Common.TimestampMillis.make(1_970_000_000_001)

describe("ModelContext", () => {
  test("folds the latest compaction into a summary plus tail for both prompt paths", () => {
    const events: ReadonlyArray<Event.Event> = [
      threadCreated(1),
      messageAdded(2, "old user message"),
      toolCompleted(3, Ids.ToolCallId.make("tool_old"), "old_tool", { old: true }),
      compacted(4, "Superseded summary", 5),
      messageAdded(5, "superseded tail"),
      compacted(6, "Goal\n- Keep this summary", 8),
      messageAdded(7, "skip before tail"),
      messageAdded(8, "tail user message"),
      toolRequested(9, Ids.ToolCallId.make("tool_tail"), "read", { path: "README.md" }),
      toolCompleted(10, Ids.ToolCallId.make("tool_tail"), "read", { content: "tail result" }),
    ]

    const messages = ModelContext.messagesFromEvents(events)
    const prompt = ModelContext.promptMessagesFromEvents(events)

    expect(messages.map((message) => message.role)).toEqual(["user", "user", "tool"])
    expect(messages[0]?.content).toBe(
      "[Conversation summary — earlier context was compacted]\nGoal\n- Keep this summary",
    )
    expect(messages[1]?.content).toBe("tail user message")
    expect(messages[2]?.content).toContain("tail result")
    expect(JSON.stringify(messages)).not.toContain("old user message")
    expect(JSON.stringify(messages)).not.toContain("superseded tail")
    expect(JSON.stringify(messages)).not.toContain("skip before tail")

    expect(prompt.map((message) => message.role)).toEqual(["user", "user", "assistant", "tool"])
    expect(prompt[0]).toMatchObject({
      role: "user",
      content: "[Conversation summary — earlier context was compacted]\nGoal\n- Keep this summary",
    })
    expect(JSON.stringify(prompt)).toContain("tail result")
    expect(JSON.stringify(prompt)).not.toContain("old user message")
    expect(JSON.stringify(prompt)).not.toContain("skip before tail")
  })

  test("folds pruned tool outputs after the latest compaction for both prompt paths", () => {
    const pruned = Ids.ToolCallId.make("tool_pruned")
    const retained = Ids.ToolCallId.make("tool_retained")
    const preCompaction = Ids.ToolCallId.make("tool_pre_compaction")
    const events: ReadonlyArray<Event.Event> = [
      threadCreated(1),
      toolCompleted(2, preCompaction, "read", { content: "pre compacted output" }),
      contextPruned(3, [preCompaction], 30_000),
      compacted(4, "Goal\n- Keep this summary", 5),
      toolCompleted(5, pruned, "search", { content: "secret old payload".repeat(400) }),
      toolCompleted(6, retained, "read", { content: "visible payload" }),
      contextPruned(7, [pruned], 24_000),
    ]

    const messages = ModelContext.messagesFromEvents(events)
    const prompt = ModelContext.promptMessagesFromEvents(events)
    const serializedMessages = JSON.stringify(messages)
    const serializedPrompt = JSON.stringify(prompt)

    expect(serializedMessages).toContain("output elided to save context")
    expect(serializedMessages).toContain("tool_pruned")
    expect(serializedMessages).toContain("search")
    expect(serializedMessages).toContain("visible payload")
    expect(serializedMessages).not.toContain("secret old payload")
    expect(serializedMessages).not.toContain("pre compacted output")

    expect(serializedPrompt).toContain("output elided to save context")
    expect(serializedPrompt).toContain("tool_pruned")
    expect(serializedPrompt).toContain("search")
    expect(serializedPrompt).toContain("visible payload")
    expect(serializedPrompt).not.toContain("secret old payload")
    expect(serializedPrompt).not.toContain("pre compacted output")
  })

  test("only folds tool outputs that occur before the pruning event", () => {
    const reused = Ids.ToolCallId.make("tool_reused")
    const events: ReadonlyArray<Event.Event> = [
      threadCreated(1),
      toolCompleted(2, reused, "read", { content: "old reused payload" }),
      contextPruned(3, [reused], 24_000),
      toolCompleted(4, reused, "read", { content: "fresh reused payload" }),
    ]

    const messages = ModelContext.messagesFromEvents(events)
    const prompt = ModelContext.promptMessagesFromEvents(events)
    const serializedMessages = JSON.stringify(messages)
    const serializedPrompt = JSON.stringify(prompt)

    expect(serializedMessages).toContain("output elided to save context")
    expect(serializedMessages).toContain("fresh reused payload")
    expect(serializedMessages).not.toContain("old reused payload")
    expect(serializedPrompt).toContain("output elided to save context")
    expect(serializedPrompt).toContain("fresh reused payload")
    expect(serializedPrompt).not.toContain("old reused payload")
  })
})

const fields = (sequence: number): Omit<Event.TurnStarted, "type" | "data"> => ({
  id: Ids.EventId.make(`event_model_context_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_model_context_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: Ids.WorkspaceId.make("workspace_model_context") },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  ...fields(sequence),
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`message_model_context_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: now,
    }),
  },
})

const compacted = (sequence: number, summary: string, tailStartSequence: number): Event.ContextCompacted => ({
  id: Ids.EventId.make(`event_model_context_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "context.compacted",
  data: {
    summary,
    tail_start_sequence: tailStartSequence,
    trigger: "manual",
    model: "gpt-5.5",
  },
})

const contextPruned = (
  sequence: number,
  toolCallIds: ReadonlyArray<Ids.ToolCallId>,
  estimatedTokensFreed: number,
): Event.ContextPruned => ({
  id: Ids.EventId.make(`event_model_context_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "context.pruned",
  data: {
    tool_call_ids: [...toolCallIds],
    estimated_tokens_freed: estimatedTokensFreed,
  },
})

const toolRequested = (
  sequence: number,
  id: Ids.ToolCallId,
  name: string,
  input: Tool.Call["input"],
): Event.ToolCallRequested => ({
  ...fields(sequence),
  type: "tool.call.requested",
  data: { call: { id, name, input } },
})

const toolCompleted = (
  sequence: number,
  id: Ids.ToolCallId,
  name: string,
  output: NonNullable<Tool.Result["output"]>,
): Event.ToolCallCompleted => ({
  ...fields(sequence),
  type: "tool.call.completed",
  data: {
    result: {
      id,
      name,
      status: "success",
      output,
    },
  },
})
