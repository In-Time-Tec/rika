import { describe, expect, test } from "bun:test"
import { AgentLoop, ContextResolver, SkillRegistry, ThreadService, ToolExecutor } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { ArtifactStore, Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Artifact, Common, Ids } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { HttpServer, RemoteControl } from "../src/index"

const threadId = Ids.ThreadId.make("thread_remote_contract")
const workspaceId = Ids.WorkspaceId.make("workspace_remote_contract")
const artifactId = Ids.ArtifactId.make("artifact_remote_contract")
const now = Common.TimestampMillis.make(2_000_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-remote",
  data_dir: "/workspace/rika-remote/.rika",
  default_mode: "smart",
})

const makeLayer = () => {
  const databaseLayer = Database.memoryLayer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const contextLayer = ContextResolver.fakeLayer({ entries: [], rendered: "", total_chars: 0 })
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(Provider.fakeLayer(["remote hello"])),
  )
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    threadLayer,
    contextLayer,
    SkillRegistry.emptyLayer,
    ToolExecutor.fakeLayer({}),
    llmLayer,
  )
  const agentLayer = AgentLoop.layer.pipe(Layer.provideMerge(agentBase))
  const remoteLayer = RemoteControl.layer.pipe(Layer.provideMerge(agentLayer), Layer.provideMerge(agentBase))
  const httpLayer = HttpServer.layer.pipe(Layer.provideMerge(remoteLayer))

  return Layer.mergeAll(agentBase, agentLayer, remoteLayer, httpLayer)
}

const makeClient = (handle: (request: Request) => Promise<Response>) =>
  Client.make(
    Client.fetchTransport({
      base_url: "http://rika.test",
      fetch: (input, init) =>
        handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
    }),
  )

describe("remote control API and SDK", () => {
  test("SDK starts a thread, sends a turn, streams events, interrupts, and reads artifacts", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    expect(created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, archived: false })

    const streamed = await Effect.runPromise(
      client
        .startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "say hello", mode: "smart" })
        .pipe(Stream.runCollect),
    )
    expect(streamed.map((event) => event.type)).toContain("message.added")
    expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })

    const turnId = streamed.find((event) => event.type === "turn.started")?.turn_id
    expect(turnId).toBeDefined()
    const interrupted = await Effect.runPromise(
      client.interruptTurn({ thread_id: threadId, turn_id: turnId ?? Ids.TurnId.make("missing"), reason: "SDK test" }),
    )
    expect(interrupted).toMatchObject({ type: "turn.failed", data: { error: { kind: "cancelled" } } })

    const opened = await Effect.runPromise(client.openThread(threadId))
    expect(opened.events.map((event) => event.type)).toContain("turn.failed")

    const artifact: Artifact.Artifact = {
      id: artifactId,
      thread_id: threadId,
      kind: "research",
      title: "Remote contract",
      content: { ok: true },
      created_at: now,
    }
    await runtime.runPromise(ArtifactStore.put(artifact))
    const artifacts = await Effect.runPromise(client.listArtifacts({ thread_id: threadId, kind: "research" }))
    const fetched = await Effect.runPromise(client.getArtifact(artifactId))
    expect(artifacts.map((item) => item.id)).toEqual([artifactId])
    expect(fetched).toEqual(artifact)
  })

  test("local token auth blocks unauthorized HTTP calls", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ port: 0, token: "secret" }))
    try {
      const unauthorized = await fetch(`${handle.url}/v1/threads`)
      const unauthorizedHealth = await fetch(`${handle.url}/health`)
      const authorized = await fetch(`${handle.url}/v1/threads`, {
        headers: { authorization: "Bearer secret" },
      })
      const authorizedHealth = await fetch(`${handle.url}/health`, {
        headers: { authorization: "Bearer secret" },
      })

      expect(unauthorized.status).toBe(401)
      expect(unauthorizedHealth.status).toBe(401)
      expect(await unauthorized.json()).toEqual({ error: { message: "Unauthorized", code: "unauthorized" } })
      expect(authorized.status).toBe(200)
      expect(authorizedHealth.status).toBe(200)
      expect(await authorized.json()).toEqual([])
      expect(await authorizedHealth.json()).toEqual({ ok: true })
    } finally {
      await runtime.runPromise(handle.close())
    }
  })
})
