import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Event, Ids, Message } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Database, Migration, ThreadEventLog } from "../src/index"

const threadId = Ids.ThreadId.make("thread_event_log_thread")
const workspaceId = Ids.WorkspaceId.make("workspace_1")
const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, ThreadEventLog.layer)

describe("ThreadEventLog", () => {
  test("appends and reads events in sequence order", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ThreadEventLog.append(threadCreated(1))
        const message = yield* ThreadEventLog.append(messageAdded(2, "hello"))
        const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { created, message, replay }
      }).pipe(Effect.provide(layer)),
    )

    expect(events.replay).toEqual([events.created, events.message])
  })

  test("treats appending the same event as idempotent", async () => {
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const event = threadCreated(1)
        yield* ThreadEventLog.append(event)
        yield* ThreadEventLog.append(event)
        return yield* ThreadEventLog.readThread({ thread_id: threadId })
      }).pipe(Effect.provide(layer)),
    )

    expect(count).toHaveLength(1)
  })

  test("reads complete history by default and only caps when a limit is provided", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(1))
        yield* ThreadEventLog.append(messageAdded(2, "first"))
        yield* ThreadEventLog.append(messageAdded(3, "second"))
        const complete = yield* ThreadEventLog.readThread({ thread_id: threadId })
        const capped = yield* ThreadEventLog.readThread({ thread_id: threadId, limit: 2 })
        return { complete, capped }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.complete.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(result.capped.map((event) => event.sequence)).toEqual([1, 2])
  })

  test("reads the latest thread tail in ascending sequence order", async () => {
    const tail = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(1))
        yield* ThreadEventLog.append(messageAdded(2, "first"))
        yield* ThreadEventLog.append(messageAdded(3, "second"))
        yield* ThreadEventLog.append(messageAdded(4, "third"))
        return yield* ThreadEventLog.readThreadTail({ thread_id: threadId, limit: 2 })
      }).pipe(Effect.provide(layer)),
    )

    expect(tail.map((event) => event.sequence)).toEqual([3, 4])
  })

  test("rejects stale sequence attempts explicitly", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.append(threadCreated(1))
        return yield* ThreadEventLog.append(messageAdded(1, "stale")).pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(error).toBeInstanceOf(ThreadEventLog.ThreadEventLogError)
    expect(error.operation).toBe("append")
  })

  test("reconstructs a thread after reopening a file-backed database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rika-event-log-"))
    const path = join(directory, "rika.sqlite")

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* ThreadEventLog.append(threadCreated(1))
          yield* ThreadEventLog.append(messageAdded(2, "persisted"))
        }).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path), Migration.layer, ThreadEventLog.layer))),
      )

      const replay = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          return yield* ThreadEventLog.readThread({ thread_id: threadId })
        }).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path), Migration.layer, ThreadEventLog.layer))),
      )

      expect(replay.map((event) => event.type)).toEqual(["thread.created", "message.added"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_created_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_message_${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn_1"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`message_${sequence}`),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_1"),
      content,
      created_at: sequence,
    }),
  },
})
