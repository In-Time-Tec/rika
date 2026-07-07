import { describe, expect, test } from "bun:test"
import { AgentLoop, CompactionService, ThreadService, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { OrbActivity, OrbManager, SandboxClientFake } from "@rika/orb"
import {
  ArtifactStore,
  OrbStore,
  Database,
  Migration,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { HttpServer, OrbMirror, PresenceHub, RemoteControl, ThreadLive } from "../src/index"

const threadId = Ids.ThreadId.make("thread_orb_mirror")
const projectId = Ids.ProjectId.make("project_orb_mirror")
const workspaceId = Ids.WorkspaceId.make("project:project_orb_mirror")
const turnId = Ids.TurnId.make("turn_orb_mirror")
const now = Common.TimestampMillis.make(2_010_000_000_000)

describe("OrbMirror", () => {
  test("mirrors running orb events idempotently and republishes them locally", async () => {
    const remoteEvents = [threadCreated(1), messageAdded(2, "mirrored")]
    const sandboxState = makeRunningSandboxState()
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
              return Stream.fromIterable(remoteEvents)
            },
          }),
        sandboxState,
        {
          times: [
            Common.TimestampMillis.make(2_010_000_000_000),
            Common.TimestampMillis.make(2_010_000_001_000),
            Common.TimestampMillis.make(2_010_000_002_000),
            Common.TimestampMillis.make(2_010_000_003_000),
            Common.TimestampMillis.make(2_010_000_004_000),
            Common.TimestampMillis.make(2_010_000_005_000),
          ],
        },
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
      const orb = await runtime.runPromise(OrbStore.get(Ids.OrbId.make("orb_1")))
      const published = await publishedPromise

      expect(replay.map((event) => event.id)).toEqual(remoteEvents.map((event) => event.id))
      expect(projection).toMatchObject({
        thread_id: threadId,
        latest_message_text: "mirrored",
      })
      expect(Array.from(published).map((event) => event.id)).toEqual(remoteEvents.map((event) => event.id))
      expect(subscriptions).toEqual([0, 2])
      expect(sandboxState.calls.setTimeout).toEqual([{ sandboxId: "sandbox_orb_mirror", timeoutMs: 300_000 }])
      expect(orb?.last_active_at).toBe(Common.TimestampMillis.make(2_010_000_005_000))
    } finally {
      await runtime.dispose()
    }
  })

  test("publishes and projects the canonical redacted event returned by local append", async () => {
    const secret = "mirror-secret-value"
    const redacted = "[REDACTED:FAKE_API_KEY]"
    const remoteEvents = [threadCreated(1), messageAdded(2, `mirrored ${secret}`)]
    const runtime = ManagedRuntime.make(
      makeLayer(
        (_endpointUrl, _token) =>
          Client.make({
            requestJson: () => Effect.never,
            streamJson: () => Stream.fromIterable(remoteEvents),
          }),
        makeRunningSandboxState(),
        { redaction: [{ label: "FAKE_API_KEY", value: secret }] },
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
        }),
      )
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))
      const projection = await runtime.runPromise(ThreadProjection.getThread(threadId))
      const published = Array.from(await publishedPromise)

      expect(JSON.stringify(replay)).toContain(redacted)
      expect(JSON.stringify(replay)).not.toContain(secret)
      expect(projection?.latest_message_text).toBe(`mirrored ${redacted}`)
      expect(
        Message.displayText(published[1]?.type === "message.added" ? published[1].data.message : { content: [] }),
      ).toBe(`mirrored ${redacted}`)
    } finally {
      await runtime.dispose()
    }
  })

  test("registers running orb project secrets before restart mirroring", async () => {
    const secret = "restart-secret-value"
    const redacted = "[REDACTED:OPENAI_API_KEY]"
    const remoteEvents = [threadCreated(1), messageAdded(2, `mirrored ${secret}`)]
    const runtime = ManagedRuntime.make(
      makeLayer((_endpointUrl, _token) =>
        Client.make({
          requestJson: () => Effect.never,
          streamJson: () => Stream.fromIterable(remoteEvents),
        }),
      ),
    )

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const project = yield* ProjectStore.create({
            name: "demo",
            repo_origin: "https://github.com/example/rika.git",
          })
          yield* ProjectStore.setSecret(project.project_id, "OPENAI_API_KEY", secret)
          yield* createRunningOrb(project.project_id)
          yield* OrbMirror.mirrorRunningOrbsOnce()
        }),
      )
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))

      expect(JSON.stringify(replay)).toContain(redacted)
      expect(JSON.stringify(replay)).not.toContain(secret)
    } finally {
      await runtime.dispose()
    }
  })

  test("mirror starts a resumed orb stream from the latest local sequence", async () => {
    const remoteEvents = [messageAdded(3, "after resume")]
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
        ThreadLive.subscribe({ thread_id: threadId, after_sequence: 2 }).pipe(Stream.take(1), Stream.runCollect),
      )

      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const orbId = yield* createRunningOrb()
          yield* ThreadEventLog.appendAndProject(threadCreated(1))
          yield* ThreadEventLog.appendAndProject(messageAdded(2, "before resume"))
          yield* OrbMirror.mirror(orbId)
        }),
      )
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))
      const published = await publishedPromise

      expect(subscriptions).toEqual([2])
      expect(replay.map((event) => event.sequence)).toEqual([1, 2, 3])
      expect(Array.from(published).map((event) => event.sequence)).toEqual([3])
    } finally {
      await runtime.dispose()
    }
  })

  test("flush mirrors catch-up events once from the latest local sequence", async () => {
    const remoteEvents = [messageAdded(2, "final flush")]
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
        ThreadLive.subscribe({ thread_id: threadId, after_sequence: 1 }).pipe(Stream.take(1), Stream.runCollect),
      )

      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const orbId = yield* createRunningOrb()
          yield* ThreadEventLog.appendAndProject(threadCreated(1))
          yield* OrbMirror.flush(orbId)
        }),
      )
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))
      const projection = await runtime.runPromise(ThreadProjection.getThread(threadId))
      const published = await publishedPromise

      expect(subscriptions).toEqual([1])
      expect(replay.map((event) => event.sequence)).toEqual([1, 2])
      expect(projection).toMatchObject({ latest_message_text: "final flush" })
      expect(Array.from(published).map((event) => event.sequence)).toEqual([2])
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
          yield* seedActiveTurn()
          yield* OrbMirror.mirrorRunningOrbsOnce()
          yield* OrbMirror.syncRunning()
          const stored = yield* OrbStore.get(orbId)
          const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
          const projection = yield* ThreadProjection.getThread(threadId)
          return { stored, replay, projection }
        }),
      )

      const failed = record.replay.filter((event): event is Event.TurnFailed => event.type === "turn.failed")
      expect(record.stored?.status).toBe("paused")
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({
        thread_id: threadId,
        turn_id: turnId,
        sequence: 3,
        data: { error: { kind: "unknown", message: "turn interrupted by orb pause" } },
      })
      expect(record.projection).toMatchObject({ active_turn_id: turnId, active_turn_status: "failed" })
      expect(record.replay.map((event) => event.sequence)).toEqual([1, 2, 3])
      expect(subscriptions).toEqual([2])
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
          yield* seedActiveTurn()
          yield* OrbMirror.mirrorRunningOrbsOnce()
          yield* OrbMirror.syncRunning()
          const stored = yield* OrbStore.get(orbId)
          const replay = yield* ThreadEventLog.readThread({ thread_id: threadId })
          const projection = yield* ThreadProjection.getThread(threadId)
          return { stored, replay, projection }
        }),
      )

      const failed = record.replay.filter((event): event is Event.TurnFailed => event.type === "turn.failed")
      expect(record.stored?.status).toBe("killed")
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({
        thread_id: threadId,
        turn_id: turnId,
        sequence: 3,
        data: { error: { kind: "unknown", message: "turn interrupted by orb pause" } },
      })
      expect(record.projection).toMatchObject({ active_turn_id: turnId, active_turn_status: "failed" })
      expect(record.replay.map((event) => event.sequence)).toEqual([1, 2, 3])
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
  options: {
    readonly times?: ReadonlyArray<Common.TimestampMillis>
    readonly redaction?: ReadonlyArray<SecretRedactor.Entry>
  } = {},
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-orb-mirror",
    data_dir: "/tmp/rika-orb-mirror/.rika",
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = timeSequenceLayer(options.times ?? [now])
  const idLayer = IdGenerator.sequenceLayer(1)
  const redactorLayer = SecretRedactor.layerFromEntries(options.redaction ?? [])
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    projectStoreLayer,
    OrbStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer), Layer.provideMerge(idLayer)),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const liveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const activityLayer = OrbActivity.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(SandboxClientFake.layer(sandboxState)),
    Layer.provideMerge(timeLayer),
  )
  const mirrorLayer = OrbMirror.layerWithClientFactory(clientFactory).pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(liveLayer),
    Layer.provideMerge(SandboxClientFake.layer(sandboxState)),
    Layer.provideMerge(activityLayer),
  )
  return Layer.mergeAll(
    migratedStorageLayer,
    liveLayer,
    SandboxClientFake.layer(sandboxState),
    projectStoreLayer,
    activityLayer,
    mirrorLayer,
  )
}

const timeSequenceLayer = (times: ReadonlyArray<Common.TimestampMillis>) => {
  let index = 0
  return Layer.succeed(
    Time.Service,
    Time.Service.of({
      nowMillis: Effect.sync(() => {
        const value = times[Math.min(index, times.length - 1)] ?? now
        index += 1
        return value
      }),
    }),
  )
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
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    workspaceStoreLayer,
    projectStoreLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    idLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const threadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const liveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const presenceLayer = PresenceHub.layer.pipe(Layer.provideMerge(timeLayer))
  const agentLayer = Layer.succeed(
    AgentLoop.Service,
    AgentLoop.Service.of({
      runTurn: () => Effect.never,
      streamTurn: () => Stream.never,
      cancelTurn: () => Effect.never,
    }),
  )
  const remoteLayer = RemoteControl.layerWithLive.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadLayer),
    Layer.provideMerge(workspaceAccessLayer),
    Layer.provideMerge(artifactLayer),
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(unusedCompactionLayer()),
    Layer.provideMerge(IdeBridge.layer),
    Layer.provideMerge(liveLayer),
    Layer.provideMerge(presenceLayer),
    Layer.provideMerge(diagnosticsLayer),
    Layer.provideMerge(remoteOrbManagerLayer()),
    Layer.provideMerge(remoteOrbMirrorLayer()),
  )
  return Layer.mergeAll(migratedStorageLayer, liveLayer, presenceLayer, redactorLayer, diagnosticsLayer, remoteLayer)
}

const unusedCompactionLayer = () =>
  CompactionService.fakeLayer({
    compact: (input) =>
      Effect.fail(
        new CompactionService.CompactionError({
          message: "Compaction is not exercised by this test.",
          operation: "compact",
          thread_id: input.thread_id,
        }),
      ),
  })

const remoteOrbManagerLayer = () =>
  Layer.succeed(
    OrbManager.Service,
    OrbManager.Service.of({
      provisionForThread: (input) =>
        Effect.succeed({
          orb_id: Ids.OrbId.make("orb_orb_mirror_remote"),
          thread_id: input.thread_id,
          project_id: input.project_id,
          sandbox_id: null,
          status: "running",
          base_commit: null,
          endpoint_url: null,
          created_at: now,
          last_active_at: now,
        }),
      pause: () => Effect.never,
      resume: () => Effect.never,
      kill: () => Effect.never,
      forceKill: () => Effect.never,
    }),
  )

const remoteOrbMirrorLayer = () =>
  Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: () => Effect.void,
      flush: () => Effect.void,
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )

const makeRemoteBackendLiveLayer = () => {
  const remoteLayer = makeRemoteControlLiveLayer()
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const httpLayer = HttpServer.layer.pipe(
    Layer.provideMerge(remoteLayer),
    Layer.provideMerge(PresenceHub.layer.pipe(Layer.provideMerge(Time.fixedLayer(now)))),
    Layer.provideMerge(diagnosticsLayer),
  )
  return Layer.mergeAll(redactorLayer, diagnosticsLayer, remoteLayer, httpLayer)
}

const createRunningOrb = (targetProjectId: Ids.ProjectId = projectId) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: threadId,
      project_id: targetProjectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_orb_mirror")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://sandbox_orb_mirror.fake.rika.local",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    return created.orb_id
  })

const seedActiveTurn = () =>
  Effect.gen(function* () {
    for (const event of [threadCreated(1), turnStarted(2)]) {
      yield* ThreadEventLog.appendAndProject(event)
    }
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

const turnStarted = (sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`event_orb_mirror_turn_started_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "turn.started",
  data: {},
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_orb_mirror_message_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`message_orb_mirror_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: now,
    }),
  },
})
