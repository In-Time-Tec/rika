import { describe, expect, test } from "bun:test"
import { Event, Ids, Message } from "@rika/schema"
import { Schema } from "effect"
import { thread_events } from "../../src/schema/event-log"

const event: Event.Event = {
  id: Ids.EventId.make("event_1"),
  thread_id: Ids.ThreadId.make("thread_1"),
  turn_id: Ids.TurnId.make("turn_1"),
  sequence: 1,
  version: 1,
  created_at: 1_765_000_000_000,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("message_1"),
      thread_id: Ids.ThreadId.make("thread_1"),
      turn_id: Ids.TurnId.make("turn_1"),
      content: "hello",
      created_at: 1_765_000_000_000,
    }),
  },
}

describe("event log schema", () => {
  test("accepts canonical event payload rows", () => {
    const row: typeof thread_events.$inferInsert = {
      id: event.id,
      thread_id: event.thread_id,
      turn_id: event.turn_id,
      sequence: event.sequence,
      version: event.version,
      type: event.type,
      payload: JSON.stringify(Schema.encodeSync(Event.Event)(event)),
      message_id: event.data.message.id,
      created_at: event.created_at,
    }

    expect(row).toMatchObject({ id: "event_1", thread_id: "thread_1", type: "message.added" })
  })
})
