import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Backend } from "../src/index"
import { ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_backend_switcher")

describe("Backend thread options", () => {
  test("derive display-safe title, preview, and diff stats from thread summary data", () => {
    const option = Backend.threadOption({
      thread_id: threadId,
      title_text: "Fix switch thread preview",
      latest_message_text: '{"tool_call":{"name":"read","input":{"path":"package.json"}}}',
      updated_at: Date.now(),
      archived: false,
      diff: { additions: 3, modifications: 1, deletions: 1 },
    })

    expect(option.label).toBe("Fix switch thread preview")
    expect(option.title).toBe("Fix switch thread preview")
    expect(option.preview).toContain("Fix switch thread preview")
    expect(option.preview).not.toContain("tool_call")
    expect(option.diff).toEqual({ additions: 3, modifications: 1, deletions: 1 })
  })
})

describe("Backend inspect targets", () => {
  test("default to all telemetry before activity and the current thread after activity", () => {
    const empty = ViewState.initial({ thread_id: threadId, workspace_path: "/workspace", mode: "smart" })
    const active = ViewState.initial({
      thread_id: threadId,
      workspace_path: "/workspace",
      mode: "smart",
      events: [messageAdded(1, "hello")],
    })
    const context = {
      state: empty,
      thread_id: threadId,
      workspace_path: "/workspace",
      mode: "smart" as const,
    }

    expect(Backend.inspectTargetFor(context, undefined)).toEqual({ scope: "all" })
    expect(Backend.inspectTargetFor({ ...context, state: active }, undefined)).toEqual({
      scope: "thread",
      thread_id: threadId,
    })
    expect(Backend.inspectTargetFor(context, "all")).toEqual({ scope: "all" })
    expect(Backend.inspectTargetFor(context, `thread ${threadId}`)).toEqual({ scope: "thread", thread_id: threadId })
  })
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => {
  const turnId = Ids.TurnId.make("turn_backend_inspect")
  return {
    id: Ids.EventId.make(`event_backend_inspect_${sequence}`),
    sequence,
    thread_id: threadId,
    turn_id: turnId,
    version: 1,
    type: "message.added",
    created_at: Common.TimestampMillis.make(sequence),
    data: {
      message: {
        id: Ids.MessageId.make(`message_backend_inspect_${sequence}`),
        thread_id: threadId,
        turn_id: turnId,
        role: "user",
        content: [Message.text(content)],
        created_at: Common.TimestampMillis.make(sequence),
      },
    },
  }
}
