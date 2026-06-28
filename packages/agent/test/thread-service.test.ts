import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, Time } from "@rika/core"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer } from "effect"
import { ThreadService } from "../src/index"

const threadId = Ids.ThreadId.make("thread_service")
const workspaceId = Ids.WorkspaceId.make("workspace_thread_service")
const turnId = Ids.TurnId.make("turn_thread_service")
const now = Common.TimestampMillis.make(1_960_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-thread-service-test",
  data_dir: "/workspace/rika-thread-service-test/.rika",
  default_mode: "smart",
})

const services = Layer.mergeAll(
  configLayer,
  Database.memoryLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  Time.fixedLayer(now),
  IdGenerator.sequenceLayer(1),
)

const layer = ThreadService.layer.pipe(Layer.provideMerge(services))

describe("ThreadService", () => {
  test("creates, opens, archives, lists, and unarchives local threads", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        const opened = yield* ThreadService.open({ thread_id: threadId })
        const archived = yield* ThreadService.archive({ thread_id: threadId })
        const active = yield* ThreadService.list({})
        const all = yield* ThreadService.list({ include_archived: true })
        const unarchived = yield* ThreadService.unarchive({ thread_id: threadId })
        const activeAgain = yield* ThreadService.list({})
        return { created, opened, archived, active, all, unarchived, activeAgain }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, archived: false })
    expect(result.opened.events.map((event) => event.type)).toEqual(["thread.created"])
    expect(result.archived.archived).toBe(true)
    expect(result.active).toEqual([])
    expect(result.all.map((summary) => summary.thread_id)).toEqual([threadId])
    expect(result.unarchived.archived).toBe(false)
    expect(result.activeAgain.map((summary) => summary.thread_id)).toEqual([threadId])
  })

  test("searches, exports, and renders compact thread references", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
        const message = messageAdded()
        const appended = yield* ThreadEventLog.append(message)
        yield* ThreadProjection.apply(appended)

        const search = yield* ThreadService.search({ query: "auth race" })
        const exported = yield* ThreadService.share({ thread_id: threadId })
        const reference = yield* ThreadService.reference({ thread_id: threadId, query: "auth" })
        return { search, exported, reference }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.search).toHaveLength(1)
    expect(result.search[0]?.summary.thread_id).toBe(threadId)
    expect(result.search[0]?.matched.join("\n")).toContain("Fix auth race")
    expect(result.exported).toMatchObject({ schema_version: 1, thread_id: threadId })
    expect(result.exported.events.map((event) => event.type)).toEqual(["thread.created", "message.added"])
    expect(result.reference.rendered).toContain(`Thread ${threadId}`)
    expect(result.reference.rendered).toContain("Fix auth race")
    expect(result.reference.entries).toContain("File: src/auth.ts")
  })
})

const messageAdded = (): Event.MessageAdded => ({
  id: Ids.EventId.make("thread_service_message_event"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("thread_service_message"),
      thread_id: threadId,
      turn_id: turnId,
      created_at: now,
      content: [Message.text("Fix auth race"), { type: "file-reference", path: "src/auth.ts" }],
    }),
  },
})
