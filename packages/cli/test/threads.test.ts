import { describe, expect, test } from "bun:test"
import { ThreadService } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Output, Threads } from "../src/index"

const threadId = Ids.ThreadId.make("thread_cli_threads")
const workspaceId = Ids.WorkspaceId.make("workspace_cli_threads")
const turnId = Ids.TurnId.make("turn_cli_threads")
const now = Common.TimestampMillis.make(1_965_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-cli-threads-test",
  data_dir: "/workspace/rika-cli-threads-test/.rika",
  default_mode: "smart",
})

const makeLayer = (output: Output.MemoryOutput) => {
  const services = Layer.mergeAll(
    configLayer,
    Output.memoryLayer(output),
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
  )

  return Threads.layer.pipe(Layer.provideMerge(ThreadService.layer.pipe(Layer.provideMerge(services))))
}

describe("CLI thread commands", () => {
  test("prints thread search results as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        return yield* Threads.executeCommand({ type: "threads", action: "search", query: "cli" })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout[0]).not.toContain("\n")
    const results = Schema.decodeUnknownSync(Schema.Array(ThreadService.SearchResult))(
      JSON.parse(output.stdout[0] ?? "[]"),
    )
    expect(results[0]?.summary.thread_id).toBe(threadId)
    expect(results[0]?.matched.join("\n")).toContain("CLI thread command")
  })

  test("prints local share exports as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedThread()
        return yield* Threads.executeCommand({ type: "threads", action: "share", thread_id: threadId })
      }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    const exported = Schema.decodeUnknownSync(ThreadService.ThreadExport)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(exported.thread_id).toBe(threadId)
    expect(exported.events.map((event) => event.type)).toEqual(["thread.created", "message.added"])
  })
})

const seedThread = () =>
  Effect.gen(function* () {
    yield* ThreadService.create({ thread_id: threadId, workspace_id: workspaceId })
    const appended = yield* ThreadEventLog.append(messageAdded())
    yield* ThreadProjection.apply(appended)
  })

const messageAdded = (): Event.MessageAdded => ({
  id: Ids.EventId.make("thread_cli_threads_message_event"),
  thread_id: threadId,
  turn_id: turnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("thread_cli_threads_message"),
      thread_id: threadId,
      turn_id: turnId,
      created_at: now,
      content: "CLI thread command search body",
    }),
  },
})
