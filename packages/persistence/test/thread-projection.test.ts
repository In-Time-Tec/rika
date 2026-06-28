import { describe, expect, test } from "bun:test"
import { Event, Ids, Message } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "../src/index"

const threadId = Ids.ThreadId.make("thread_projection_thread")
const workspaceId = Ids.WorkspaceId.make("workspace_projection")
const turnId = Ids.TurnId.make("turn_projection")
const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, ThreadEventLog.layer, ThreadProjection.layer)

describe("ThreadProjection", () => {
  test("projects thread list, latest message, and active turn state", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of projectionEvents()) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({
      thread_id: threadId,
      workspace_id: workspaceId,
      latest_message_text: "hello projection",
      active_turn_id: turnId,
      active_turn_status: "completed",
      archived: false,
    })
  })

  test("projects archive and unarchive events", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of [...projectionEvents(), archivedEvent(), unarchivedEvent()]) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }
        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({ thread_id: threadId, archived: false })
  })

  test("rebuilds projections from only the event log", async () => {
    const summaries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        for (const event of projectionEvents()) {
          yield* ThreadEventLog.append(event)
        }
        yield* ThreadProjection.clear()
        expect(yield* ThreadProjection.listThreads()).toEqual([])
        yield* ThreadProjection.rebuild()
        return yield* ThreadProjection.listThreads()
      }).pipe(Effect.provide(layer)),
    )

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ latest_message_text: "hello projection", active_turn_status: "completed" })
  })

  test("does not regress projections when an older duplicate event is reapplied", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const events = projectionEvents()
        for (const event of events) {
          const appended = yield* ThreadEventLog.append(event)
          yield* ThreadProjection.apply(appended)
        }

        const duplicateStarted = yield* ThreadEventLog.append(events[1])
        yield* ThreadProjection.apply(duplicateStarted)

        return yield* ThreadProjection.getThread(threadId)
      }).pipe(Effect.provide(layer)),
    )

    expect(summary).toMatchObject({ active_turn_status: "completed" })
  })
})

const projectionEvents = (): readonly [
  Event.ThreadCreated,
  Event.TurnStarted,
  Event.MessageAdded,
  Event.TurnCompleted,
] => [
  {
    id: Ids.EventId.make("projection_created"),
    thread_id: threadId,
    sequence: 1,
    version: 1,
    created_at: 1,
    type: "thread.created",
    data: { workspace_id: workspaceId },
  },
  {
    id: Ids.EventId.make("projection_turn_started"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 2,
    version: 1,
    created_at: 2,
    type: "turn.started",
    data: {},
  },
  {
    id: Ids.EventId.make("projection_message"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 3,
    version: 1,
    created_at: 3,
    type: "message.added",
    data: {
      message: Message.user({
        id: Ids.MessageId.make("projection_message"),
        thread_id: threadId,
        turn_id: turnId,
        content: "hello projection",
        created_at: 3,
      }),
    },
  },
  {
    id: Ids.EventId.make("projection_turn_completed"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 4,
    version: 1,
    created_at: 4,
    type: "turn.completed",
    data: {},
  },
]

const archivedEvent = (): Event.ThreadArchived => ({
  id: Ids.EventId.make("projection_thread_archived"),
  thread_id: threadId,
  sequence: 5,
  version: 1,
  created_at: 5,
  type: "thread.archived",
  data: {},
})

const unarchivedEvent = (): Event.ThreadUnarchived => ({
  id: Ids.EventId.make("projection_thread_unarchived"),
  thread_id: threadId,
  sequence: 6,
  version: 1,
  created_at: 6,
  type: "thread.unarchived",
  data: {},
})
