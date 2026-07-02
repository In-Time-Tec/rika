import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message, Tool } from "@rika/schema"
import { Option } from "effect"
import { ThreadDigest } from "../src/index"

const threadId = Ids.ThreadId.make("thread_digest")
const turnId = Ids.TurnId.make("turn_digest")
const now = Common.TimestampMillis.make(1_966_000_000_000)

describe("ThreadDigest", () => {
  test("builds one completed-turn digest from durable messages, tools, and file paths", () => {
    const digest = ThreadDigest.completedTurnDigest(
      [
        message(1, "user", "Refactor this"),
        toolRequested(2, "read"),
        toolCompleted(3, "read", { path: "src/app.ts" }),
        message(4, "assistant", "Done"),
        turnCompleted(5),
      ],
      turnId,
    )

    expect(Option.getOrUndefined(digest)).toBe(
      ["Refactor this", "---", "Done", "", "Tools: read", "Files: src/app.ts"].join("\n"),
    )
  })

  test("does not build a digest for a turn without a completed terminal event", () => {
    const digest = ThreadDigest.completedTurnDigest([message(1, "user", "Unfinished")], turnId)

    expect(Option.isNone(digest)).toBe(true)
  })
})

const message = (sequence: number, role: Message.Role, text: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_digest_message_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_digest_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(text)],
      created_at: now,
    },
  },
})

const toolRequested = (sequence: number, name: string): Event.ToolCallRequested => ({
  id: Ids.EventId.make(`event_digest_tool_requested_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "tool.call.requested",
  data: { call: { id: Ids.ToolCallId.make(`tool_digest_${sequence}`), name, input: {} } },
})

const toolCompleted = (sequence: number, name: string, output: Tool.Result["output"]): Event.ToolCallCompleted => ({
  id: Ids.EventId.make(`event_digest_tool_completed_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make(`tool_digest_${sequence}`),
      name,
      status: "success",
      output,
    },
  },
})

const turnCompleted = (sequence: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event_digest_completed_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "turn.completed",
  data: {},
})
