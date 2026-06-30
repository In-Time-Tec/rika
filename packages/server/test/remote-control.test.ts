import { describe, expect, test } from "bun:test"
import { AgentLoop, ContextResolver, SkillRegistry, ThreadService, ToolExecutor, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { Provider, Router } from "@rika/llm"
import { ArtifactStore, Database, Migration, ThreadEventLog, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Artifact, Common, Ide, Ids } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { HttpServer, RemoteControl } from "../src/index"

const threadId = Ids.ThreadId.make("thread_remote_contract")
const ideThreadId = Ids.ThreadId.make("thread_remote_ide")
const workspaceId = Ids.WorkspaceId.make("workspace_remote_contract")
const artifactId = Ids.ArtifactId.make("artifact_remote_contract")
const ideClientId = Ids.IdeClientId.make("ide_remote_contract")
const ownerId = Ids.UserId.make("user_remote_owner")
const outsiderId = Ids.UserId.make("user_remote_outsider")
const now = Common.TimestampMillis.make(2_000_000_000_000)
const ideContext: Ide.ContextSnapshot = {
  workspace_roots: ["/workspace/rika-remote"],
  active_file: {
    path: "packages/server/src/remote-control.ts",
    language_id: "typescript",
    selection: { range: { start_line: 30, end_line: 35 }, selected_text: "readonly connectIde" },
  },
  diagnostics: [
    {
      path: "packages/server/src/remote-control.ts",
      severity: "information",
      message: "IDE seam is active",
      range: { start_line: 30, end_line: 30 },
      source: "mock-ide",
    },
  ],
}

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-remote",
  data_dir: "/workspace/rika-remote/.rika",
  default_mode: "smart",
})

const defaultContextLayer = ContextResolver.fakeLayer({ entries: [], rendered: "", total_chars: 0 })

const ideAwareContextLayer = Layer.succeed(
  ContextResolver.Service,
  ContextResolver.Service.of({
    resolve: Effect.fn("ServerTest.ContextResolver.resolve")(function* (input: ContextResolver.ResolveInput) {
      const entries = input.ide_context === undefined ? [] : IdeBridge.contextEntries(input.ide_context)
      const rendered = entries.map((entry) => `${entry.source}:${entry.path ?? entry.reason}`).join("\n")
      return {
        entries,
        rendered,
        total_chars: rendered.length,
        metadata: { ide_context: input.ide_context !== undefined },
      }
    }),
  }),
)

const makeLayer = (contextLayer = defaultContextLayer) => {
  const databaseLayer = Database.memoryLayer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    workspaceStoreLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(
      Provider.fakeRegistryLayer([
        { name: "anthropic", responses: ["remote hello"] },
        { name: "openai", responses: ["remote hello"] },
      ]),
    ),
  )
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    threadLayer,
    workspaceAccessLayer,
    contextLayer,
    SkillRegistry.emptyLayer,
    ToolExecutor.fakeLayer({}),
    Diagnostics.memoryLayer([]),
    llmLayer,
    IdeBridge.layer,
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

    const health = await Effect.runPromise(client.backendHealth())
    const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    expect(created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, archived: false })
    expect(health).toMatchObject({ status: "healthy", workspace_root: "/workspace/rika-remote" })

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
    const preview = await Effect.runPromise(client.previewThread(threadId, { limit: 2 }))
    expect(preview.summary.thread_id).toBe(threadId)
    expect(preview.events.map((event) => event.type)).toEqual(["turn.completed", "turn.failed"])
    const subscribed = await Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 }).pipe(Stream.runCollect),
    )
    const archived = await Effect.runPromise(client.archiveThread(threadId))
    const unarchived = await Effect.runPromise(client.unarchiveThread(threadId))
    expect(subscribed.map((event) => event.type)).toContain("message.added")
    expect(archived.archived).toBe(true)
    expect(unarchived.archived).toBe(false)

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
      expect(await authorizedHealth.json()).toMatchObject({
        status: "healthy",
        workspace_root: "/workspace/rika-remote",
        data_dir: "/workspace/rika-remote/.rika",
      })
    } finally {
      await runtime.runPromise(handle.close())
    }
  })

  test("remote user requests are scoped to workspace membership", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const created = await Effect.runPromise(
      client.createThread({ thread_id: threadId, workspace_id: workspaceId, user_id: ownerId }),
    )
    const ownerThreads = await Effect.runPromise(client.listThreads({ user_id: ownerId }))
    const outsiderThreads = await Effect.runPromise(client.listThreads({ user_id: outsiderId }))
    const outsiderOpen = await Effect.runPromise(client.openThread(threadId, outsiderId).pipe(Effect.flip))
    const outsiderPreview = await Effect.runPromise(
      client.previewThread(threadId, { user_id: outsiderId }).pipe(Effect.flip),
    )
    const outsiderTurn = await Effect.runPromise(
      client
        .startTurn({ thread_id: threadId, workspace_id: workspaceId, user_id: outsiderId, content: "break in" })
        .pipe(Stream.runCollect, Effect.flip),
    )

    expect(created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, user_id: ownerId })
    expect(ownerThreads.map((summary) => summary.thread_id)).toEqual([threadId])
    expect(outsiderThreads).toEqual([])
    expect(outsiderOpen).toMatchObject({ status: 403 })
    expect(outsiderPreview).toMatchObject({ status: 403 })
    expect(outsiderTurn).toMatchObject({ status: 403 })
  })

  test("IDE clients can provide turn context and receive navigation requests", async () => {
    const runtime = ManagedRuntime.make(makeLayer(ideAwareContextLayer))
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const connected = await Effect.runPromise(
      client.connectIde({
        client_id: ideClientId,
        name: "Mock IDE",
        workspace_roots: ["/workspace/rika-remote"],
        capabilities: ["active-context", "diagnostics", "navigation"],
        initial_context: ideContext,
      }),
    )
    const status = await Effect.runPromise(client.ideStatus())
    const streamed = await Effect.runPromise(
      client
        .startTurn({ thread_id: ideThreadId, workspace_id: workspaceId, content: "use my editor context" })
        .pipe(Stream.runCollect),
    )
    const navigationRequest: Ide.OpenFileRequest = {
      path: "packages/server/src/remote-control.ts",
      range: { start_line: 30, end_line: 35 },
      reason: "Show the IDE seam",
      thread_id: ideThreadId,
    }
    const navigation = await Effect.runPromise(client.openIdeFile(navigationRequest))
    const requests = await Effect.runPromise(client.ideNavigationRequests())

    expect(connected).toEqual({
      client_id: ideClientId,
      connected: true,
      capabilities: ["active-context", "diagnostics", "navigation"],
    })
    expect(status).toMatchObject({ connected: true, client_id: ideClientId, context: ideContext })
    expect(streamed.find((event) => event.type === "context.resolved")).toMatchObject({
      data: {
        entries: [
          expect.objectContaining({ source: "ide:active-file", path: "packages/server/src/remote-control.ts" }),
          expect.objectContaining({ source: "ide:diagnostics", content: expect.stringContaining("mock-ide") }),
        ],
        metadata: { ide_context: true },
      },
    })
    expect(navigation).toEqual({ accepted: true })
    expect(requests).toEqual([navigationRequest])
  })
})
