import { Event, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { describe, expect, test } from "bun:test"
import {
  ChangedDraft,
  ClickedThread,
  LoadedThreads,
  OpenedThread,
  ReceivedThreadEvent,
  SubmittedDraft,
  eventRows,
  init,
  initialModel,
  update,
} from "../src/app"

const threadId = Ids.ThreadId.make("thread-web")
const workspaceId = Ids.WorkspaceId.make("workspace-web")
const messageId = Ids.MessageId.make("message-web")

describe("web app state", () => {
  test("initializes by loading backend state and the requested thread", () => {
    const [model, commands] = init({ api_base_url: "/api/rika", thread_id: threadId })

    expect(model.api_base_url).toBe("/api/rika")
    expect(model.selected_thread_id).toBe(threadId)
    expect(commands.map((command) => command.name)).toEqual(["LoadBackendHealth", "LoadThreads", "OpenThread"])
  })

  test("opens a thread from durable events before starting the live subscription", () => {
    const event = messageAdded(4, "assistant", "hello from the CLI")
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId), events: [event] } }),
    )

    expect(commands).toEqual([])
    expect(next.events).toEqual([event])
    expect(next.last_sequence).toBe(4)
    expect(next.subscription_after_sequence).toBe(4)
    expect(next.subscribed_thread_id).toBe(threadId)
    expect(next.connection).toBe("connected")
  })

  test("submitting a turn never appends optimistic transcript events", () => {
    const event = messageAdded(4, "assistant", "already rendered")
    const [opened] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId), events: [event] } }),
    )
    const [drafted] = update(opened, ChangedDraft({ value: "run tests" }))
    const [next, commands] = update(drafted, SubmittedDraft())

    expect(next.events).toEqual([event])
    expect(next.draft).toBe("")
    expect(next.pending_turn).toBe(true)
    expect(commands.map((command) => command.name)).toEqual(["StartTurn"])
  })

  test("applies live events once by sequence", () => {
    const event = messageAdded(5, "assistant", "streamed everywhere")
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      last_sequence: 4,
      subscription_after_sequence: 4,
    }

    const [next] = update(model, ReceivedThreadEvent({ event }))
    const [deduped] = update(next, ReceivedThreadEvent({ event }))

    expect(next.events).toEqual([event])
    expect(next.last_sequence).toBe(5)
    expect(deduped.events).toEqual([event])
    expect(deduped.last_sequence).toBe(5)
  })

  test("renders message events into readable transcript rows", () => {
    expect(eventRows([messageAdded(1, "user", "hi"), messageAdded(2, "assistant", "hello")])).toEqual([
      { id: "event-1", sequence: 1, kind: "message", title: "User", body: "hi" },
      { id: "event-2", sequence: 2, kind: "message", title: "Rika", body: "hello" },
    ])
  })

  test("auto-opens the newest thread after loading the thread list", () => {
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      LoadedThreads({ threads: [summary(threadId)] }),
    )

    expect(next.selected_thread_id).toBe(threadId)
    expect(commands.map((command) => command.name)).toEqual(["OpenThread"])
  })

  test("clicking a thread resets subscription state until its durable record opens", () => {
    const otherThreadId = Ids.ThreadId.make("thread-other")
    const [model] = update(
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        subscribed_thread_id: threadId,
        last_sequence: 9,
        subscription_after_sequence: 9,
      },
      ClickedThread({ thread_id: otherThreadId }),
    )

    expect(model.selected_thread_id).toBe(otherThreadId)
    expect(model.subscribed_thread_id).toBeUndefined()
    expect(model.events).toEqual([])
    expect(model.last_sequence).toBe(0)
  })
})

const summary = (id: Ids.ThreadId): Remote.ThreadSummary => ({
  thread_id: id,
  workspace_id: workspaceId,
  title_text: "Web thread",
  latest_message_text: "Latest",
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  created_at: 1,
  updated_at: 2,
})

const messageAdded = (sequence: number, role: RikaMessage.Role, text: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: {
      id: messageId,
      thread_id: threadId,
      role,
      content: [RikaMessage.text(text)],
      created_at: sequence,
    },
  },
})
