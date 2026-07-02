import { describe, expect, test } from "bun:test"
import { AgentLoop, ThreadService, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { SandboxClientFake } from "@rika/orb"
import {
  ArtifactStore,
  OrbStore,
  Database,
  Migration,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { HttpServer, OrbMirror, RemoteControl, ThreadLive } from "../src/index"

const threadId = Ids.ThreadId.make("thread_orb_mirror")
const projectId = Ids.ProjectId.make("project_orb_mirror")
const workspaceId = Ids.WorkspaceId.make("project:project_orb_mirror")
const now = Common.TimestampMillis.make(2_010_000_000_000)

describe("OrbMirror", () => {
  test("mirrors running orb events idempotently and republishes them locally", async () => {
    const remoteEvents = [threadCreated(1), messageAdded(2, "mirrored")]
    const subscriptions: Array<number | undefined> = []
    const runtime = ManagedRuntime.make(
      makeLayer((_endpointUrl, _token) =>
        Client.make({
          requestJson: () => Effect.never,
          streamJson: (input) => {
            const url = new URL(input.path, "http://orb.test")
            const afterSequence = url.searchParams.get("after_sequence")
            subscriptions.push(afterSequence === null ? undefined : Number(afterSequence))
            return Stream.fromIterable(remoteEvents)
          },
        }),
      ),
    )

    try {
      const publishedPromise = runtime.runPromise(
        ThreadLive.subscribe({ thread_id: threadId }).pipe(Stream.take(2), Stream.runCollect),
      )

      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* createRunningOrb()
          yield* OrbMirror.mirrorRunningOrbsOnce()
          yield* OrbMirror.mirrorRunningOrbsOnce()
        }),
      )
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))
      const projection = await runtime.runPromise(ThreadProjection.getThread(threadId))
      const published = await publishedPromise

      expect(replay.map((event) => event.id)).toEqual(remoteEvents.map((event) => event.id))
      expect(projection).toMatchObject({
        thread_id: threadId,
        latest_message_text: "mirrored",
      })
      expect(Array.from(published).map((event) => event.id)).toEqual(remoteEvents.map((event) => event.id))
      expect(subscriptions).toEqual([0, 2])
    } finally {
      await runtime.dispose()
    }
  })

  test("syncRunning mirrors a newly registered orb through an in-process SDK HTTP backend", async () => {
    const remoteEvents = [threadCreated(1), messageAdded(2, "http mirrored")]
    const orbRuntime = ManagedRuntime.make(makeRemoteBackendLiveLayer())
    const mirrorRuntime = ManagedRuntime.make(
      makeLayer((endpointUrl, token) =>
        Client.make(
          Client.fetchTransport({
            base_url: endpointUrl,
            token,
            fetch: (input, init) =>
              orbRuntime.runPromise(
                HttpServer.handle(
                  input instanceof Request ? new Request(input, init) : new Request(String(input), init),
                ),
              ),
          }),
        ),
      ),
    )

    try {
      await orbRuntime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* Effect.forEach(remoteEvents, ThreadEventLog.append, { discard: true })
        }),
      )
      await mirrorRuntime.runPromise(Migration.migrate())
      const publishedPromise = mirrorRuntime.runPromise(
        ThreadLive.subscribe({ thread_id: threadId }).pipe(Stream.take(2), Stream.runCollect),
      )

      await mirrorRuntime.runPromise(
        Effect.gen(function* () {
          yield* createRunningOrb()
          yield* OrbMirror.syncRunning()
        }),
      )

      const published = await publishedPromise
      const replay = await mirrorRuntime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))
      const projection = await mirrorRuntime.runPromise(ThreadProjection.getThread(threadId))

      expect(replay.map((event) => event.id)).toEqual(remoteEvents.map((event) => event.id))
      expect(projection).toMatchObject({
        thread_id: threadId,
        latest_message_text: "http mirrored",
      })
      expect(Array.from(published).map((event) => event.id)).toEqual(remoteEvents.map((event) => event.id))
    } finally {
      await mirrorRuntime.dispose()
      await orbRuntime.dispose()
    }
  })

  test("reconnects from the latest mirrored sequence after a stream failure", async () => {
    const remoteEvents = [threadCreated(1), messageAdded(2, "after reconnect")]
    const subscriptions: Array<number | undefined> = []
    let attempt = 0
    const runtime = ManagedRuntime.make(
      makeLayer((_endpointUrl, _token) =>
        Client.make({
          requestJson: () => Effect.never,
          streamJson: (input) => {
            const url = new URL(input.path, "http://orb.test")
            const afterSequence = url.searchParams.get("after_sequence")
            subscriptions.push(afterSequence === null ? undefined : Number(afterSequence))
            attempt += 1
            return attempt === 1
              ? Stream.make(remoteEvents[0]).pipe(
                  Stream.concat(
                    Stream.fail(
                      new Client.SdkError({
                        message: "stream interrupted",
                        operation: "subscribeThreadEvents",
                      }),
                    ),
                  ),
                )
              : Stream.make(remoteEvents[1])
          },
        }),
      ),
    )

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* createRunningOrb()
          yield* OrbMirror.mirrorRunningOrbsOnce()
        }),
      )
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))

      expect(replay.map((event) => event.id)).toEqual(remoteEvents.map((event) => event.id))
      expect(subscriptions).toEqual([0, 1])
    } finally {
      await runtime.dispose()
    }
  })

  test("rejects remote events for a different thread", async () => {
    const injected = {
      ...threadCreated(1),
      thread_id: Ids.ThreadId.make("thread_orb_mirror_injected"),
    }
    const runtime = ManagedRuntime.make(
      makeLayer((_endpointUrl, _token) =>
        Client.make({
          requestJson: () => Effect.never,
          streamJson: () => Stream.make(injected),
        }),
      ),
    )

    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* createRunningOrb()
          const error = yield* OrbMirror.mirrorRunningOrbsOnce().pipe(Effect.flip)
          const events = yield* ThreadEventLog.readAll()
          return { error, events }
        }),
      )

      expect(result.error).toBeInstanceOf(OrbMirror.OrbMirrorError)
      expect(result.events).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  test("marks a running orb paused when the sandbox is paused after stream failure", async () => {
    const sandboxState = SandboxClientFake.makeState()
    sandboxState.sandboxes.set("sandbox_orb_mirror", {
      sandboxId: "sandbox_orb_mirror",
      templateId: "template_orb_mirror",
      metadata: {
        thread_id: threadId,
        project_id: projectId,
      },
      state: "paused",
    })
    const subscriptions: Array<number | undefined> = []
    const runtime = ManagedRuntime.make(
      makeLayer(
        (_endpointUrl, _token) =>
          Client.make({
            requestJson: () => Effect.never,
            streamJson: (input) => {
              const url = new URL(input.path, "http://orb.test")
              const afterSequence = url.searchParams.get("after_sequence")
              subscriptions.push(afterSequence === null ? undefined : Number(afterSequence))
              return Stream.fail(
                new Client.SdkError({
                  message: "stream interrupted",
                  operation: "subscribeThreadEvents",
                }),
              )
            },
          }),
        sandboxState,
      ),
    )

    try {
      const record = await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const orbId = yield* createRunningOrb()
          yield* OrbMirror.mirrorRunningOrbsOnce()
          return yield* OrbStore.get(orbId)
        }),
      )

      expect(record?.status).toBe("paused")
      expect(subscriptions).toEqual([0])
      expect(sandboxState.calls.list).toEqual([{ metadata: { thread_id: threadId, project_id: projectId } }])
    } finally {
      await runtime.dispose()
    }
  })

  test("marks a running orb killed when the sandbox disappears after stream failure", async () => {
    const sandboxState = SandboxClientFake.makeState()
    const runtime = ManagedRuntime.make(
      makeLayer(
        (_endpointUrl, _token) =>
          Client.make({
            requestJson: () => Effect.never,
            streamJson: () =>
              Stream.fail(
                new Client.SdkError({
                  message: "stream interrupted",
                  operation: "subscribeThreadEvents",
                }),
              ),
          }),
        sandboxState,
      ),
    )

    try {
      const record = await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const orbId = yield* createRunningOrb()
          yield* OrbMirror.mirrorRunningOrbsOnce()
          return yield* OrbStore.get(orbId)
        }),
      )

      expect(record?.status).toBe("killed")
      expect(sandboxState.calls.list).toEqual([{ metadata: { thread_id: threadId, project_id: projectId } }])
    } finally {
      await runtime.dispose()
    }
  })

  test("remote control subscribers use the caller-provided ThreadLive service", async () => {
    const runtime = ManagedRuntime.make(makeRemoteControlLiveLayer())

    try {
      const receivedPromise = runtime.runPromise(
        RemoteControl.subscribeThreadEvents({ thread_id: threadId }).pipe(Stream.take(1), Stream.runCollect),
      )
      await runtime.runPromise(Effect.sleep("10 millis"))
      await runtime.runPromise(ThreadLive.publish(threadCreated(1)))
      const received = await receivedPromise

      expect(Array.from(received).map((event) => event.id)).toEqual([threadCreated(1).id])
    } finally {
      await runtime.dispose()
    }
  })
})

const makeLayer = (
  clientFactory: OrbMirror.ClientFactory,
  sandboxState: SandboxClientFake.State = makeRunningSandboxState(),
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-orb-mirror",
    data_dir: "/workspace/rika-orb-mirror/.rika",
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    OrbStore.layer.pipe(
      Layer.provideMerge(databaseLayer),
      Layer.provideMerge(Time.fixedLayer(now)),
      Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    ),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const liveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const mirrorLayer = OrbMirror.layerWithClientFactory(clientFactory).pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(liveLayer),
    Layer.provideMerge(SandboxClientFake.layer(sandboxState)),
  )
  return Layer.mergeAll(migratedStorageLayer, liveLayer, mirrorLayer)
}

const makeRunningSandboxState = () => {
  const state = SandboxClientFake.makeState()
  state.sandboxes.set("sandbox_orb_mirror", {
    sandboxId: "sandbox_orb_mirror",
    templateId: "template_orb_mirror",
    metadata: {
      thread_id: threadId,
      project_id: projectId,
    },
    state: "running",
  })
  return state
}

const makeRemoteControlLiveLayer = () => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-orb-mirror",
    data_dir: "/workspace/rika-orb-mirror/.rika",
    default_mode: "smart",
  })
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
  const liveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const agentLayer = Layer.succeed(
    AgentLoop.Service,
    AgentLoop.Service.of({
      runTurn: () => Effect.never,
      streamTurn: () => Stream.never,
      cancelTurn: () => Effect.never,
      queueTurn: () => Effect.never,
    }),
  )
  const remoteLayer = RemoteControl.layerWithLive.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadLayer),
    Layer.provideMerge(workspaceAccessLayer),
    Layer.provideMerge(artifactLayer),
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(IdeBridge.layer),
    Layer.provideMerge(liveLayer),
  )
  return Layer.mergeAll(migratedStorageLayer, liveLayer, remoteLayer)
}

const makeRemoteBackendLiveLayer = () => {
  const remoteLayer = makeRemoteControlLiveLayer()
  const httpLayer = HttpServer.layer.pipe(
    Layer.provideMerge(remoteLayer),
    Layer.provideMerge(Diagnostics.memoryLayer([])),
  )
  return Layer.mergeAll(remoteLayer, httpLayer)
}

const createRunningOrb = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: threadId,
      project_id: projectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_orb_mirror")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://sandbox_orb_mirror.fake.rika.local",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    return created.orb_id
  })

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_orb_mirror_created_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_orb_mirror_message_${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn_orb_mirror"),
  sequence,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`message_orb_mirror_${sequence}`),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn_orb_mirror"),
      content,
      created_at: now,
    }),
  },
})
