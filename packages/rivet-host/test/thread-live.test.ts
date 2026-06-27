import { describe, expect, test } from "bun:test"
import { AgentLoop, ContextResolver, ToolExecutor } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Registry } from "@rivetkit/effect"
import { Effect, Layer } from "effect"
import { ThreadLive } from "../src/index"

const threadId = Ids.ThreadId.make("thread_actor_smoke")
const workspaceId = Ids.WorkspaceId.make("workspace_actor_smoke")

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-actor-test",
  data_dir: "/workspace/rika-actor-test/.rika",
  default_mode: "smart",
})
const llmLayer = Router.layer.pipe(
  Layer.provideMerge(Provider.fakeLayer(["actor loop response"])),
  Layer.provideMerge(configLayer),
)

const baseServiceLayer = Layer.mergeAll(
  configLayer,
  Database.memoryLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  Time.fixedLayer(Common.TimestampMillis.make(1_800_000_000_000)),
  IdGenerator.sequenceLayer(1),
  ContextResolver.emptyLayer,
  ToolExecutor.emptyLayer,
  llmLayer,
)

const serviceLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseServiceLayer))

const supportLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(serviceLayer))

const registryLayer = ThreadLive.layer.pipe(
  Layer.provideMerge(supportLayer),
  Layer.provideMerge(Registry.layer({ noWelcome: true })),
)

describe("ThreadActorLive", () => {
  test("registers the ThreadActor with the local Rivet serverless host", async () => {
    const { handler, dispose } = Registry.toWebHandler(registryLayer)

    try {
      const response = await handler(new Request("http://runner.test/api/rivet/metadata"))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(hasThreadActorMetadata(body)).toBe(true)
    } finally {
      await dispose()
    }
  })

  test("replays a persisted thread without relying on hot actor state", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadEventLog.append(threadCreated(1))
        yield* ThreadEventLog.append(turnStarted(2))
        yield* ThreadEventLog.append(messageAdded(3, "hello actor"))

        const replayed = yield* ThreadLive.replaySnapshot(threadId)
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { replayed, events }
      }).pipe(Effect.provide(supportLayer)),
    )

    expect(result.replayed).toMatchObject({
      thread_id: threadId,
      last_sequence: 3,
      message_count: 1,
      active_turn_status: "active",
      latest_message_text: "hello actor",
    })
    expect(result.events.map((event) => event.type)).toEqual(["thread.created", "turn.started", "message.added"])
  })
})

const turnId = Ids.TurnId.make("turn_actor_smoke")

const hasThreadActorMetadata = (body: unknown) => {
  if (typeof body !== "object" || body === null || !("actorNames" in body)) return false
  const actorNames = body.actorNames
  return typeof actorNames === "object" && actorNames !== null && "ThreadActor" in actorNames
}

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`actor_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const turnStarted = (sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`actor_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: {},
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`actor_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("actor_message_1"),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: sequence,
    }),
  },
})
