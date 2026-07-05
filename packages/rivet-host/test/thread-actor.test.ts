import { describe, expect, test } from "bun:test"
import { Event, Ids, Message } from "@rika/schema"
import { Schema } from "effect"
import { ThreadActor } from "../src/index"

const threadId = Ids.ThreadId.make("thread_state_test")
const turnId = Ids.TurnId.make("turn_state_test")
const workspaceId = Ids.WorkspaceId.make("workspace_state_test")
const userId = Ids.UserId.make("user_state_test")

describe("ThreadActor state projection", () => {
  test("rebuilds hot actor state from persisted thread events", () => {
    const state = ThreadActor.stateFromEvents(threadId, [
      threadCreated(1),
      turnStarted(2),
      messageAdded(3, "hello from the log"),
    ])

    expect(ThreadActor.snapshotFromState(state, threadId)).toMatchObject({
      thread_id: threadId,
      last_sequence: 3,
      message_count: 1,
      active_turn_id: turnId,
      active_turn_status: "active",
      latest_message_text: "hello from the log",
    })
  })

  test("declares workspace access denial as a typed action error", () => {
    const error = {
      _tag: "WorkspaceAccessDenied",
      message: "denied",
      action: "read",
      workspace_id: workspaceId,
      user_id: userId,
    }

    const decoded = Schema.decodeUnknownSync(ThreadActor.GetSnapshot.errorSchema)(error)

    expect(decoded).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "read",
      workspace_id: workspaceId,
      user_id: userId,
    })
  })
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const turnStarted = (sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: {},
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("state_message_1"),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: sequence,
    }),
  },
})
