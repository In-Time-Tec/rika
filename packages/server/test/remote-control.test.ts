import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgentLoop,
  CompactionService,
  ContextResolver,
  SkillRegistry,
  ThreadService,
  ToolExecutor,
  WorkspaceAccess,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { OrbManager } from "@rika/orb"
import { Provider, Router } from "@rika/llm"
import {
  ArtifactStore,
  Database,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Artifact, Codec, Common, Event, Ide, Ids, Orb, Remote } from "@rika/schema"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { HttpServer, OrbMirror, PresenceHub, RemoteControl } from "../src/index"

const threadId = Ids.ThreadId.make("thread_remote_contract")
const ideThreadId = Ids.ThreadId.make("thread_remote_ide")
const workspaceId = Ids.WorkspaceId.make("workspace_remote_contract")
const projectId = Ids.ProjectId.make("project_remote_contract")
const projectWorkspaceId = Ids.WorkspaceId.make("project:project_remote_contract")
const artifactId = Ids.ArtifactId.make("artifact_remote_contract")
const orbId = Ids.OrbId.make("orb_remote_contract")
const orbThreadId = Ids.ThreadId.make("thread_remote_orb_contract")
const orphanedThreadId = Ids.ThreadId.make("thread_remote_orphaned_turn")
const orphanedTurnId = Ids.TurnId.make("turn_remote_orphaned")
const outsiderThreadId = Ids.ThreadId.make("thread_remote_outsider_create")
const ideClientId = Ids.IdeClientId.make("ide_remote_contract")
const ownerId = Ids.UserId.make("user_remote_owner")
const memberId = Ids.UserId.make("user_remote_member")
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

const configLayerForDataDir = (dataDir: string) =>
  Config.layerFromValues({
    workspace_root: "/workspace/rika-remote",
    data_dir: dataDir,
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

const makeLayer = (
  contextLayer = defaultContextLayer,
  orbManagerLayer: Layer.Layer<OrbManager.Service, never, OrbStore.Service> = fakeOrbManagerLayer(),
  orbMirrorLayer: Layer.Layer<OrbMirror.Service> = fakeOrbMirrorLayer(),
  options: {
    readonly dataDir?: string
    readonly agentLayer?: Layer.Layer<AgentLoop.Service>
    readonly compactionLayer?: Layer.Layer<CompactionService.Service>
    readonly providerResponses?: ReadonlyArray<Provider.FakeResponse>
    readonly toolLayer?: Layer.Layer<ToolExecutor.Service, never, Diagnostics.Service>
  } = {},
) => {
  const runtimeConfigLayer = options.dataDir === undefined ? configLayer : configLayerForDataDir(options.dataDir)
  const databaseLayer =
    options.dataDir === undefined ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(runtimeConfigLayer))
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
  const storageLayer = Layer.mergeAll(
    runtimeConfigLayer,
    databaseLayer,
    artifactLayer,
    workspaceStoreLayer,
    Migration.layer,
    OrbStore.layer.pipe(
      Layer.provideMerge(databaseLayer),
      Layer.provideMerge(Time.fixedLayer(now)),
      Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    ),
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const threadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const providedOrbManagerLayer = orbManagerLayer.pipe(Layer.provideMerge(migratedStorageLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(runtimeConfigLayer),
    Layer.provideMerge(
      Provider.fakeRegistryLayer([
        { name: "anthropic", responses: options.providerResponses ?? ["remote hello"] },
        { name: "openai", responses: options.providerResponses ?? ["remote hello"] },
      ]),
    ),
    Layer.provideMerge(diagnosticsLayer),
  )
  const toolLayer = (options.toolLayer ?? ToolExecutor.fakeLayer({})).pipe(Layer.provideMerge(diagnosticsLayer))
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    projectStoreLayer,
    threadLayer,
    workspaceAccessLayer,
    contextLayer,
    SkillRegistry.emptyLayer,
    toolLayer,
    redactorLayer,
    diagnosticsLayer,
    llmLayer,
    IdeBridge.layer,
    providedOrbManagerLayer,
    orbMirrorLayer,
  )
  const agentLayer = options.agentLayer ?? AgentLoop.layer.pipe(Layer.provideMerge(agentBase))
  const compactionLayer = options.compactionLayer ?? CompactionService.layer.pipe(Layer.provideMerge(agentBase))
  const presenceLayer = PresenceHub.layer.pipe(Layer.provideMerge(Time.fixedLayer(now)))
  const remoteLayer = RemoteControl.layer.pipe(
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(compactionLayer),
    Layer.provideMerge(agentBase),
    Layer.provideMerge(presenceLayer),
  )
  const httpLayer = HttpServer.layer.pipe(Layer.provideMerge(remoteLayer), Layer.provideMerge(presenceLayer))

  return Layer.mergeAll(agentBase, agentLayer, compactionLayer, remoteLayer, httpLayer)
}

const makeThreadStorageLayer = (dataDir: string) => {
  const runtimeConfigLayer = configLayerForDataDir(dataDir)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(runtimeConfigLayer))
  return Layer.mergeAll(
    runtimeConfigLayer,
    databaseLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
  )
}

const fakeOrbManagerLayer = (
  onProvision: (input: OrbManager.ProvisionInput) => void = () => {},
): Layer.Layer<OrbManager.Service> =>
  Layer.succeed(
    OrbManager.Service,
    OrbManager.Service.of({
      provisionForThread: (input) =>
        Effect.sync(() => {
          onProvision(input)
          return orbRecord(input.thread_id, input.project_id, "running")
        }),
      pause: (id) => Effect.succeed(orbRecord(orbThreadId, projectId, "paused", id)),
      resume: (id) => Effect.succeed(orbRecord(orbThreadId, projectId, "running", id)),
      kill: (id) => Effect.succeed(orbRecord(orbThreadId, projectId, "killed", id)),
      forceKill: (id) => Effect.succeed(orbRecord(orbThreadId, projectId, "killed", id)),
    }),
  )

const fakeOrbMirrorLayer = (onMirror: (mirroredOrbId: Ids.OrbId) => void = () => {}): Layer.Layer<OrbMirror.Service> =>
  Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: (mirroredOrbId) => Effect.sync(() => onMirror(mirroredOrbId)),
      flush: () => Effect.void,
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )

const blockingAgentLoopLayer = (): Layer.Layer<AgentLoop.Service> =>
  Layer.succeed(
    AgentLoop.Service,
    AgentLoop.Service.of({
      runTurn: () => Effect.never,
      streamTurn: () => Stream.never,
      cancelTurn: () => Effect.never,
    }),
  )

const capturingAgentLoopLayer = (inputs: Array<AgentLoop.RunTurnInput>): Layer.Layer<AgentLoop.Service> =>
  Layer.succeed(
    AgentLoop.Service,
    AgentLoop.Service.of({
      runTurn: () => Effect.never,
      streamTurn: (input) =>
        Stream.sync(() => {
          inputs.push(input)
          return {
            id: Ids.EventId.make("event_remote_captured_completed"),
            thread_id: input.thread_id,
            turn_id: Ids.TurnId.make("turn_remote_captured"),
            sequence: 1,
            version: 1,
            created_at: now,
            type: "turn.completed",
            data: {},
          } satisfies Event.TurnCompleted
        }),
      cancelTurn: () => Effect.never,
    }),
  )

const orbManagerLayerWithStoredResume = (
  onResume: (orbId: Ids.OrbId) => void,
): Layer.Layer<OrbManager.Service, never, OrbStore.Service> =>
  Layer.effect(
    OrbManager.Service,
    Effect.map(OrbStore.Service, (orbs) =>
      OrbManager.Service.of({
        provisionForThread: (input) =>
          Effect.sync(() => {
            return orbRecord(input.thread_id, input.project_id, "running")
          }),
        pause: (id) => orbManagerStoreStep("pause", id, orbs.setStatus(id, "paused")),
        resume: (id) =>
          Effect.sync(() => {
            onResume(id)
          }).pipe(Effect.andThen(orbManagerStoreStep("resume", id, orbs.setStatus(id, "running")))),
        kill: (id) => orbManagerStoreStep("kill", id, orbs.setStatus(id, "killed")),
        forceKill: (id) => orbManagerStoreStep("forceKill", id, orbs.setStatus(id, "killed")),
      }),
    ),
  )

const orbManagerLayerWithStoredLifecycle = (
  onCall: (step: "pause" | "resume" | "kill", orbId: Ids.OrbId) => void,
): Layer.Layer<OrbManager.Service, never, OrbStore.Service> =>
  Layer.effect(
    OrbManager.Service,
    Effect.map(OrbStore.Service, (orbs) =>
      OrbManager.Service.of({
        provisionForThread: (input) =>
          Effect.sync(() => {
            return orbRecord(input.thread_id, input.project_id, "running")
          }),
        pause: (id) =>
          Effect.sync(() => onCall("pause", id)).pipe(
            Effect.andThen(orbManagerStoreStep("pause", id, orbs.setStatus(id, "paused"))),
          ),
        resume: (id) =>
          Effect.sync(() => onCall("resume", id)).pipe(
            Effect.andThen(orbManagerStoreStep("resume", id, orbs.setStatus(id, "running"))),
          ),
        kill: (id) =>
          Effect.sync(() => onCall("kill", id)).pipe(
            Effect.andThen(orbManagerStoreStep("kill", id, orbs.setStatus(id, "killed"))),
          ),
        forceKill: (id) =>
          Effect.sync(() => onCall("kill", id)).pipe(
            Effect.andThen(orbManagerStoreStep("forceKill", id, orbs.setStatus(id, "killed"))),
          ),
      }),
    ),
  )

const orbManagerStoreStep = (
  step: string,
  recordOrbId: Ids.OrbId,
  effect: Effect.Effect<Orb.OrbRecord, unknown>,
): Effect.Effect<Orb.OrbRecord, OrbManager.OrbProvisionError> =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new OrbManager.OrbProvisionError({
          message: error instanceof Error ? error.message : String(error),
          step,
          orb_id: recordOrbId,
        }),
    ),
  )

const orbRecord = (
  recordThreadId: Ids.ThreadId,
  recordProjectId: Ids.ProjectId,
  status: Orb.OrbStatus,
  recordOrbId = orbId,
): Orb.OrbRecord => ({
  orb_id: recordOrbId,
  thread_id: recordThreadId,
  project_id: recordProjectId,
  sandbox_id: "sandbox_remote_contract",
  status,
  base_commit: "abc123",
  endpoint_url: "https://orb.remote-contract.test",
  created_at: now,
  last_active_at: now,
})

const remoteOrbSummary = (record: Orb.OrbRecord): Remote.OrbSummary => ({
  orb_id: record.orb_id,
  thread_id: record.thread_id,
  project_id: record.project_id,
  status: record.status,
  base_commit: record.base_commit,
  created_at: record.created_at,
  last_active_at: record.last_active_at,
  running_minutes: 0,
})

const createRunningOrbRecord = (recordThreadId: Ids.ThreadId) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: recordThreadId,
      project_id: projectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_remote_contract")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb.remote-contract.test",
      token: "orb-token",
    })
    return yield* OrbStore.setStatus(created.orb_id, "running")
  })

const createPausedOrbRecord = (recordThreadId: Ids.ThreadId) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: recordThreadId,
      project_id: projectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_remote_contract")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb.remote-contract.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    return yield* OrbStore.setStatus(created.orb_id, "paused")
  })

const appendProjected = (event: Event.Event) =>
  Effect.gen(function* () {
    yield* ThreadEventLog.appendAndProject(event)
  })

const orphanedThreadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("event_remote_orphaned_thread_created"),
  thread_id: orphanedThreadId,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const orphanedTurnStarted = (): Event.TurnStarted => ({
  id: Ids.EventId.make("event_remote_orphaned_turn_started"),
  thread_id: orphanedThreadId,
  turn_id: orphanedTurnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "turn.started",
  data: {},
})

const makeClient = (handle: (request: Request) => Promise<Response>) =>
  Client.make(
    Client.fetchTransport({
      base_url: "http://rika.test",
      fetch: (input, init) =>
        handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
    }),
  )

const requestJson = async (
  handle: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
) => {
  const response = await handle(
    new Request(`http://rika.test${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  )
  const text = await response.text()
  const json = text.length === 0 ? null : (JSON.parse(text) as unknown)
  return { status: response.status, json, text }
}

describe("remote control API and SDK", () => {
  test("SDK starts a thread, sends a turn, streams events, interrupts, and reads artifacts", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    expect(created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, archived: false })

    const firstSubscriber = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    const secondSubscriber = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    const accepted = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "say hello", mode: "smart" }),
    )
    const [streamed, mirrored] = await Promise.all([firstSubscriber, secondSubscriber])

    expect(accepted).toEqual({ thread_id: threadId, accepted: true })
    expect(mirrored.map((event) => event.type)).toEqual(streamed.map((event) => event.type))
    expect(streamed.map((event) => event.type)).toContain("message.added")
    expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })

    const turnId = streamed.find((event) => event.type === "turn.started")?.turn_id
    if (turnId === undefined) throw new Error("Missing streamed turn id")

    const preview = await Effect.runPromise(client.previewThread(threadId, { limit: 2 }))
    expect(preview.summary.thread_id).toBe(threadId)
    expect(preview.events.map((event) => event.type)).toEqual(["message.added", "turn.completed"])

    const completedInterrupt = await Effect.runPromise(
      client.interruptTurn({ thread_id: threadId, turn_id: turnId, reason: "already completed" }),
    )
    const previewAfterCompletedInterrupt = await Effect.runPromise(client.previewThread(threadId, { limit: 2 }))
    expect(completedInterrupt).toMatchObject({
      type: "turn.completed",
      turn_id: turnId,
    })
    expect(previewAfterCompletedInterrupt.events.map((event) => event.type)).toEqual([
      "message.added",
      "turn.completed",
    ])

    const metadataEvents = Effect.runPromise(
      client
        .subscribeThreadEvents({ thread_id: threadId, after_sequence: preview.events.at(-1)?.sequence })
        .pipe(Stream.take(2), Stream.runCollect),
    )
    const archived = await Effect.runPromise(client.archiveThread(threadId))
    const unarchived = await Effect.runPromise(client.unarchiveThread(threadId))
    const subscribed = await metadataEvents
    expect(subscribed.map((event) => event.type)).toEqual(["thread.archived", "thread.unarchived"])
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
    const storedArtifact = { ...artifact, workspace_id: workspaceId }
    await runtime.runPromise(ArtifactStore.put(artifact))
    const artifacts = await Effect.runPromise(client.listArtifacts({ thread_id: threadId, kind: "research" }))
    const fetched = await Effect.runPromise(client.getArtifact(artifactId))
    expect(artifacts.map((item) => item.id)).toEqual([artifactId])
    expect(fetched).toEqual(storedArtifact)
  })

  test("startTurn preserves read-only tool access for the agent loop", async () => {
    const captured: Array<AgentLoop.RunTurnInput> = []
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), {
        agentLayer: capturingAgentLoopLayer(captured),
      }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    const subscriber = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId }).pipe(Stream.take(1), Stream.runCollect),
    )
    await Effect.runPromise(
      client.startTurn({
        thread_id: threadId,
        workspace_id: workspaceId,
        content: "audit only",
        tool_access: "read-only",
      }),
    )
    await subscriber

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ tool_access: "read-only", content: "audit only" })
  })

  test("interrupting an active turn stops in-flight work and releases the thread", async () => {
    const interruptThreadId = Ids.ThreadId.make("thread_remote_interrupt_stops_work")
    const toolStarted = Effect.runSync(Deferred.make<void>())
    const releaseTool = Effect.runSync(Deferred.make<void>())
    const sideEffectDone = Effect.runSync(Deferred.make<void>())
    let sideEffectRan = false
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), {
        providerResponses: [
          {
            type: "tool-call",
            id: "call_remote_interrupt_delayed",
            name: "delayed_side_effect",
            input: {},
          },
          "accepted after interrupt",
        ],
        toolLayer: ToolExecutor.fakeLayer({
          delayed_side_effect: () =>
            Deferred.succeed(toolStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTool)),
              Effect.andThen(
                Effect.sync(() => {
                  sideEffectRan = true
                }),
              ),
              Effect.andThen(Deferred.succeed(sideEffectDone, undefined)),
              Effect.as({ ok: true }),
            ),
        }),
      }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: interruptThreadId, workspace_id: workspaceId }))
      const accepted = await Effect.runPromise(
        client.startTurn({
          thread_id: interruptThreadId,
          workspace_id: workspaceId,
          content: "run a delayed side effect",
          mode: "smart",
        }),
      )
      const started = await runtime.runPromise(Deferred.await(toolStarted).pipe(Effect.timeoutOption("1 second")))
      const beforeInterrupt = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: interruptThreadId }))
      const startedTurn = beforeInterrupt.find((event): event is Event.TurnStarted => event.type === "turn.started")
      if (startedTurn === undefined) throw new Error("Missing started turn")

      const interrupted = await Effect.runPromise(
        client.interruptTurn({
          thread_id: interruptThreadId,
          turn_id: startedTurn.turn_id,
          reason: "test interrupt",
        }),
      )
      const acceptedAfterInterrupt = await Effect.runPromise(
        client.startTurn({
          thread_id: interruptThreadId,
          workspace_id: workspaceId,
          content: "accepted after interrupt",
          mode: "smart",
        }),
      )
      await runtime.runPromise(
        Deferred.succeed(releaseTool, undefined).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.yieldNow),
        ),
      )
      const sideEffectObserved = await runtime.runPromise(
        Deferred.await(sideEffectDone).pipe(Effect.timeoutOption("20 millis")),
      )
      const events = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: interruptThreadId }))
      const originalTerminalEvents = events.filter(
        (event): event is Event.TurnCompleted | Event.TurnFailed =>
          event.turn_id === startedTurn.turn_id && (event.type === "turn.completed" || event.type === "turn.failed"),
      )

      expect(accepted).toEqual({ thread_id: interruptThreadId, accepted: true })
      expect(started._tag).toBe("Some")
      expect(interrupted).toMatchObject({
        type: "turn.failed",
        turn_id: startedTurn.turn_id,
        data: { error: { kind: "cancelled" } },
      })
      expect(acceptedAfterInterrupt).toEqual({ thread_id: interruptThreadId, accepted: true })
      expect(sideEffectRan).toBe(false)
      expect(sideEffectObserved._tag).toBe("None")
      expect(originalTerminalEvents.map((event) => event.type)).toEqual(["turn.failed"])
    } finally {
      await runtime.dispose()
    }
  })

  test("interrupting a terminal stale turn id does not stop the active turn", async () => {
    const staleInterruptThreadId = Ids.ThreadId.make("thread_remote_stale_interrupt")
    const toolStarted = Effect.runSync(Deferred.make<void>())
    const releaseTool = Effect.runSync(Deferred.make<void>())
    const sideEffectDone = Effect.runSync(Deferred.make<void>())
    let sideEffectRan = false
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), {
        providerResponses: [
          "first turn complete",
          {
            type: "tool-call",
            id: "call_remote_stale_interrupt_delayed",
            name: "delayed_side_effect",
            input: {},
          },
          "cleanup after stale interrupt",
        ],
        toolLayer: ToolExecutor.fakeLayer({
          delayed_side_effect: () =>
            Deferred.succeed(toolStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTool)),
              Effect.andThen(
                Effect.sync(() => {
                  sideEffectRan = true
                }),
              ),
              Effect.andThen(Deferred.succeed(sideEffectDone, undefined)),
              Effect.as({ ok: true }),
            ),
        }),
      }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: staleInterruptThreadId, workspace_id: workspaceId }))
      const firstStream = Effect.runPromise(
        client.subscribeThreadEvents({ thread_id: staleInterruptThreadId }).pipe(
          Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
          Stream.runCollect,
        ),
      )
      await Effect.runPromise(
        client.startTurn({
          thread_id: staleInterruptThreadId,
          workspace_id: workspaceId,
          content: "first turn",
          mode: "smart",
        }),
      )
      const firstEvents = await firstStream
      const staleTurn = firstEvents.find((event): event is Event.TurnStarted => event.type === "turn.started")
      if (staleTurn === undefined) throw new Error("Missing first started turn")

      await Effect.runPromise(
        client.startTurn({
          thread_id: staleInterruptThreadId,
          workspace_id: workspaceId,
          content: "second turn",
          mode: "smart",
        }),
      )
      const started = await runtime.runPromise(Deferred.await(toolStarted).pipe(Effect.timeoutOption("1 second")))
      const beforeStaleInterrupt = await runtime.runPromise(
        ThreadEventLog.readThread({ thread_id: staleInterruptThreadId }),
      )
      const activeTurn = beforeStaleInterrupt.findLast(
        (event): event is Event.TurnStarted => event.type === "turn.started",
      )
      if (activeTurn === undefined) throw new Error("Missing active started turn")

      const staleInterrupt = await Effect.runPromise(
        client.interruptTurn({
          thread_id: staleInterruptThreadId,
          turn_id: staleTurn.turn_id,
          reason: "stale interrupt",
        }),
      )
      const afterStaleInterrupt = await runtime.runPromise(
        ThreadEventLog.readThread({ thread_id: staleInterruptThreadId }),
      )
      const activeTerminalAfterStale = afterStaleInterrupt.filter(
        (event): event is Event.TurnCompleted | Event.TurnFailed =>
          event.turn_id === activeTurn.turn_id && (event.type === "turn.completed" || event.type === "turn.failed"),
      )
      const cleanup = await Effect.runPromise(
        client.interruptTurn({
          thread_id: staleInterruptThreadId,
          turn_id: activeTurn.turn_id,
          reason: "cleanup",
        }),
      )
      const afterCleanup = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: staleInterruptThreadId }))
      const cleanupAgain = await Effect.runPromise(
        client.interruptTurn({
          thread_id: staleInterruptThreadId,
          turn_id: activeTurn.turn_id,
          reason: "cleanup again",
        }),
      )
      const afterCleanupAgain = await runtime.runPromise(
        ThreadEventLog.readThread({ thread_id: staleInterruptThreadId }),
      )
      await runtime.runPromise(
        Deferred.succeed(releaseTool, undefined).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.yieldNow),
        ),
      )
      const sideEffectObserved = await runtime.runPromise(
        Deferred.await(sideEffectDone).pipe(Effect.timeoutOption("20 millis")),
      )

      expect(started._tag).toBe("Some")
      expect(staleInterrupt).toMatchObject({ type: "turn.completed", turn_id: staleTurn.turn_id })
      expect(activeTerminalAfterStale).toHaveLength(0)
      expect(cleanup).toMatchObject({
        type: "turn.failed",
        turn_id: activeTurn.turn_id,
        data: { error: { kind: "cancelled" } },
      })
      expect(cleanupAgain).toMatchObject({
        type: "turn.failed",
        turn_id: activeTurn.turn_id,
        data: { error: { kind: "cancelled" } },
      })
      expect(afterCleanupAgain).toHaveLength(afterCleanup.length)
      expect(sideEffectRan).toBe(false)
      expect(sideEffectObserved._tag).toBe("None")
    } finally {
      await runtime.dispose()
    }
  })

  test("uses project identity when remote requests omit workspace id", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))
    const projectThreadId = Ids.ThreadId.make("thread_project_workspace")

    const created = await Effect.runPromise(client.createThread({ thread_id: projectThreadId, project_id: projectId }))
    const streamedPromise = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: projectThreadId }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    await Effect.runPromise(
      client.startTurn({ thread_id: projectThreadId, project_id: projectId, content: "same repo" }),
    )
    const streamed = await streamedPromise
    const opened = await Effect.runPromise(client.openThread(projectThreadId))

    expect(created.workspace_id).toBe(projectWorkspaceId)
    expect(opened.summary.workspace_id).toBe(projectWorkspaceId)
    expect(streamed.find((event) => event.type === "thread.created")).toMatchObject({
      data: { workspace_id: projectWorkspaceId },
    })
  })

  test("remote thread summaries include orb status across read paths", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    await runtime.runPromise(createRunningOrbRecord(threadId))

    const listed = await Effect.runPromise(client.listThreads())
    const opened = await Effect.runPromise(client.openThread(threadId))
    const preview = await Effect.runPromise(client.previewThread(threadId))
    const searched = await Effect.runPromise(client.searchThreads({ query: "" }))
    const shared = await Effect.runPromise(client.shareThread(threadId))
    const archived = await Effect.runPromise(client.archiveThread(threadId))
    const unarchived = await Effect.runPromise(client.unarchiveThread(threadId))

    expect(listed.find((summary) => summary.thread_id === threadId)?.orb_status).toBe("running")
    expect(opened.summary.orb_status).toBe("running")
    expect(preview.summary.orb_status).toBe("running")
    expect(searched.find((result) => result.summary.thread_id === threadId)?.summary.orb_status).toBe("running")
    expect(shared.summary.orb_status).toBe("running")
    expect(archived.orb_status).toBe("running")
    expect(unarchived.orb_status).toBe("running")
  })

  test("archive pauses a running orb and unarchive leaves it paused", async () => {
    const calls: Array<string> = []
    const runtime = ManagedRuntime.make(
      makeLayer(
        defaultContextLayer,
        orbManagerLayerWithStoredLifecycle((step, id) => calls.push(`${step}:${id}`)),
        fakeOrbMirrorLayer((id) => calls.push(`mirror:${id}`)),
      ),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    await Effect.runPromise(client.createThread({ thread_id: orbThreadId, project_id: projectId }))
    const running = await runtime.runPromise(createRunningOrbRecord(orbThreadId))
    const archived = await Effect.runPromise(client.archiveThread(orbThreadId))
    const afterArchive = await runtime.runPromise(OrbStore.get(running.orb_id))
    const unarchived = await Effect.runPromise(client.unarchiveThread(orbThreadId))
    const afterUnarchive = await runtime.runPromise(OrbStore.get(running.orb_id))

    expect(calls).toEqual([`pause:${running.orb_id}`])
    expect(archived).toMatchObject({ thread_id: orbThreadId, archived: true, orb_status: "paused" })
    expect(afterArchive?.status).toBe("paused")
    expect(unarchived).toMatchObject({ thread_id: orbThreadId, archived: false, orb_status: "paused" })
    expect(afterUnarchive?.status).toBe("paused")

    const streamedPromise = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: orbThreadId }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    const accepted = await Effect.runPromise(
      client.startTurn({ thread_id: orbThreadId, project_id: projectId, content: "resume after unarchive" }),
    )
    const streamed = await streamedPromise
    const afterTurn = await runtime.runPromise(OrbStore.get(running.orb_id))

    expect(accepted).toEqual({ thread_id: orbThreadId, accepted: true })
    expect(calls).toEqual([`pause:${running.orb_id}`, `resume:${running.orb_id}`, `mirror:${running.orb_id}`])
    expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })
    expect(afterTurn?.status).toBe("running")
  })

  test("creates projects and provisions orb-backed threads over the remote API", async () => {
    const provisioned: Array<OrbManager.ProvisionInput> = []
    const runtime = ManagedRuntime.make(
      makeLayer(
        defaultContextLayer,
        fakeOrbManagerLayer((input) => provisioned.push(input)),
      ),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const project = await Effect.runPromise(
      client.createProject({ name: "demo", repo_origin: "https://github.com/example/rika.git" }),
    )
    const projects = await Effect.runPromise(client.listProjects())
    const summary = await Effect.runPromise(
      client.createOrbThread({ project_id: project.project_id, thread_id: orbThreadId, mode: "smart" }),
    )

    expect(project).toMatchObject({
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
      default_branch: "main",
    })
    expect(projects.map((item) => item.project_id)).toEqual([project.project_id])
    expect(provisioned).toEqual([
      {
        thread_id: orbThreadId,
        project_id: project.project_id,
        workspace_root: "/workspace/rika-remote",
      },
    ])
    expect(summary).toMatchObject({
      thread_id: orbThreadId,
      workspace_id: Ids.WorkspaceId.make(`project:${project.project_id}`),
      orb_status: "running",
      archived: false,
    })
  })

  test("project settings API returns redacted lists and env-visible details", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-project-api-"))
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), { dataDir }),
    )

    try {
      const handle = (request: Request) => runtime.runPromise(HttpServer.handle(request))
      const created = await requestJson(handle, "POST", "/v1/projects", {
        name: "demo",
        repo_origin: "https://token@example.com/org/rika.git?private=1",
        default_branch: "main",
        env: { NODE_ENV: "development" },
      })
      expect(created.status).toBe(200)
      expect(created.json).toMatchObject({
        name: "demo",
        repo_origin: "https://example.com/org/rika.git",
        env: { NODE_ENV: "development" },
        secret_names: [],
      })

      const createdProject = Codec.decode(Remote.ProjectDetail)(created.json)
      const createdProjectId = createdProject.project_id
      const secret = await requestJson(handle, "PUT", `/v1/projects/${createdProjectId}/secrets/OPENAI_API_KEY`, {
        value: "secret-value",
      })
      const listed = await requestJson(handle, "GET", "/v1/projects")
      const detail = await requestJson(handle, "GET", `/v1/projects/${createdProjectId}`)
      const renamed = await requestJson(handle, "PATCH", `/v1/projects/${createdProjectId}`, {
        name: "renamed",
        repo_origin: "https://github.com/example/renamed.git",
        default_branch: "trunk",
        template_id: "template-next",
        env: { NODE_ENV: "test", FEATURE_FLAG: "on" },
      })
      const deleted = await requestJson(handle, "DELETE", `/v1/projects/${createdProjectId}/secrets/OPENAI_API_KEY`)

      expect(secret.status).toBe(200)
      expect(secret.json).toMatchObject({ secret_names: ["OPENAI_API_KEY"] })
      expect(JSON.stringify(secret.json)).not.toContain("secret-value")
      expect(listed.status).toBe(200)
      expect(listed.json).toEqual([
        {
          project_id: createdProjectId,
          name: "demo",
          repo_origin: "https://example.com/org/rika.git",
          default_branch: "main",
          template_id: null,
          env_keys: ["NODE_ENV"],
          secret_names: ["OPENAI_API_KEY"],
          created_at: now,
          updated_at: now,
        },
      ])
      expect(JSON.stringify(listed.json)).not.toContain("development")
      expect(JSON.stringify(listed.json)).not.toContain("secret-value")
      expect(detail.status).toBe(200)
      expect(detail.json).toMatchObject({
        env: { NODE_ENV: "development" },
        secret_names: ["OPENAI_API_KEY"],
      })
      expect(JSON.stringify(detail.json)).not.toContain("secret-value")
      expect(renamed.status).toBe(200)
      expect(renamed.json).toMatchObject({
        name: "renamed",
        repo_origin: "https://github.com/example/renamed.git",
        default_branch: "trunk",
        template_id: "template-next",
        env: { NODE_ENV: "test", FEATURE_FLAG: "on" },
        secret_names: ["OPENAI_API_KEY"],
      })
      expect(deleted.status).toBe(200)
      expect(deleted.json).toMatchObject({ secret_names: [] })
      expect(JSON.stringify(deleted.json)).not.toContain("secret-value")
    } finally {
      await runtime.dispose()
      await rm(dataDir, { force: true, recursive: true })
    }
  })

  test("orb lifecycle API lists token-free summaries and drives manager transitions", async () => {
    const calls: Array<string> = []
    const runtime = ManagedRuntime.make(
      makeLayer(
        defaultContextLayer,
        orbManagerLayerWithStoredLifecycle((step, id) => calls.push(`${step}:${id}`)),
      ),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      const seeded = await runtime.runPromise(createRunningOrbRecord(orbThreadId))
      const expectedRunning = remoteOrbSummary(seeded)
      const listed = await Effect.runPromise(client.listOrbs())
      const byThread = await Effect.runPromise(client.getOrbByThread(orbThreadId))
      const paused = await Effect.runPromise(client.pauseOrb(seeded.orb_id))
      const resumed = await Effect.runPromise(client.resumeOrb(seeded.orb_id))
      const killed = await Effect.runPromise(client.killOrb(seeded.orb_id))

      expect(listed).toEqual([expectedRunning])
      expect(byThread).toEqual(expectedRunning)
      expect(paused).toEqual({ ...expectedRunning, status: "paused" })
      expect(resumed).toEqual(expectedRunning)
      expect(killed).toEqual({ ...expectedRunning, status: "killed" })
      expect(calls).toEqual([`pause:${seeded.orb_id}`, `resume:${seeded.orb_id}`, `kill:${seeded.orb_id}`])
      expect(JSON.stringify(listed)).not.toContain("orb-token")
      expect(JSON.stringify(listed)).not.toContain("orb.remote-contract.test")
    } finally {
      await runtime.dispose()
    }
  })

  test("orb lifecycle API maps invalid transitions to conflict responses", async () => {
    const runtime = ManagedRuntime.make(
      makeLayer(
        defaultContextLayer,
        orbManagerLayerWithStoredLifecycle(() => {}),
      ),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      const running = await runtime.runPromise(createRunningOrbRecord(orbThreadId))
      await Effect.runPromise(client.killOrb(running.orb_id))
      const error = await Effect.runPromise(client.pauseOrb(running.orb_id).pipe(Effect.flip))

      expect(error).toBeInstanceOf(Client.SdkError)
      expect(error.status).toBe(409)
      expect(error.message).toContain("Invalid orb status transition")
    } finally {
      await runtime.dispose()
    }
  })

  test("manual compaction appends and publishes a context.compacted event", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      const streamedPromise = Effect.runPromise(
        client
          .subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 })
          .pipe(Stream.take(1), Stream.runCollect),
      )
      const compacted = await Effect.runPromise(client.compactThread(created.thread_id))
      const streamed = await streamedPromise
      const stored = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: threadId }))

      expect(compacted).toMatchObject({
        type: "context.compacted",
        thread_id: threadId,
        sequence: 2,
        data: {
          trigger: "manual",
          summary: "remote hello",
          model: "gpt-5.5",
        },
      })
      expect(streamed).toEqual([compacted])
      expect(stored.at(-1)).toEqual(compacted)
    } finally {
      await runtime.dispose()
    }
  })

  test("manual compaction returns conflict while thread work is already active", async () => {
    let startedResolve: (() => void) | undefined
    let finishResolve: ((value: CompactionService.CompactionResult) => void) | undefined
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })
    const finish = new Promise<CompactionService.CompactionResult>((resolve) => {
      finishResolve = resolve
    })
    const event: Event.ContextCompacted = {
      id: Ids.EventId.make("event_remote_compaction_blocked"),
      thread_id: threadId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "context.compacted",
      data: {
        summary: "Blocked fake summary",
        tail_start_sequence: 1,
        trigger: "manual",
        tokens_before: 1,
        model: "gpt-5.5",
      },
    }
    const compactionLayer = CompactionService.fakeLayer({
      compact: () =>
        Effect.promise(() => {
          if (startedResolve === undefined) throw new Error("Missing compaction start resolver")
          startedResolve()
          return finish
        }),
    })
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), { compactionLayer }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      const first = Effect.runPromise(client.compactThread(threadId))
      await started
      const error = await Effect.runPromise(client.compactThread(threadId).pipe(Effect.flip))
      if (finishResolve === undefined) throw new Error("Missing compaction finish resolver")
      finishResolve({ event, tokens_before: 1 })
      const completed = await first

      expect(error).toBeInstanceOf(Client.SdkError)
      expect(error.status).toBe(409)
      expect(error.message).toContain("already has active work")
      expect(completed).toEqual(event)
    } finally {
      await runtime.dispose()
    }
  })

  test("manual compaction returns conflict while a turn is already active", async () => {
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), {
        agentLayer: blockingAgentLoopLayer(),
      }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      const accepted = await Effect.runPromise(
        client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "hold open" }),
      )
      const error = await Effect.runPromise(client.compactThread(threadId).pipe(Effect.flip))

      expect(accepted).toEqual({ thread_id: threadId, accepted: true })
      expect(error).toMatchObject({ status: 409 })
    } finally {
      await runtime.dispose()
    }
  })

  test("startTurn conflicts include the active turn user id", async () => {
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), {
        agentLayer: blockingAgentLoopLayer(),
      }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId, user_id: ownerId }))
      await runtime.runPromise(
        WorkspaceStore.putMembership({
          workspace_id: workspaceId,
          user_id: outsiderId,
          role: "member",
          created_at: now,
        }),
      )
      await Effect.runPromise(client.setThreadVisibility(threadId, "workspace", ownerId))
      await Effect.runPromise(
        client.startTurn({ thread_id: threadId, workspace_id: workspaceId, user_id: ownerId, content: "hold open" }),
      )

      const response = await runtime.runPromise(
        HttpServer.handle(
          new Request("http://rika.test/v1/turns", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              thread_id: threadId,
              workspace_id: workspaceId,
              user_id: outsiderId,
              content: "second turn",
            }),
          }),
        ),
      )
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body).toMatchObject({
        error: {
          code: "startTurn",
          details: { status: 409, active_user_id: ownerId },
        },
      })
    } finally {
      await runtime.dispose()
    }
  })

  test("concurrent startTurn calls reserve a thread once", async () => {
    const concurrentThreadId = Ids.ThreadId.make("thread_remote_concurrent_start")
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), {
        agentLayer: blockingAgentLoopLayer(),
      }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: concurrentThreadId, workspace_id: workspaceId }))
      const results = await Promise.allSettled([
        Effect.runPromise(
          client.startTurn({
            thread_id: concurrentThreadId,
            workspace_id: workspaceId,
            user_id: ownerId,
            content: "first concurrent turn",
          }),
        ),
        Effect.runPromise(
          client.startTurn({
            thread_id: concurrentThreadId,
            workspace_id: workspaceId,
            user_id: memberId,
            content: "second concurrent turn",
          }),
        ),
      ])
      const accepted = results.filter(
        (result): result is PromiseFulfilledResult<Remote.StartTurnResponse> => result.status === "fulfilled",
      )
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")

      expect(accepted).toHaveLength(1)
      expect(accepted[0]?.value).toEqual({ thread_id: concurrentThreadId, accepted: true })
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(Client.SdkError)
      expect(rejected[0]?.reason).toMatchObject({ status: 409 })
    } finally {
      await runtime.dispose()
    }
  })

  test("forks completed thread history over the remote API", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      const streamedPromise = Effect.runPromise(
        client.subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 }).pipe(
          Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
          Stream.runCollect,
        ),
      )
      await Effect.runPromise(client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "fork me" }))
      const streamed = await streamedPromise
      const terminal = streamed.find((event): event is Event.TurnCompleted => event.type === "turn.completed")
      if (terminal === undefined) throw new Error("Missing terminal turn event")

      const forked = await Effect.runPromise(client.forkThread(threadId, { at_turn: terminal.turn_id }))
      const opened = await Effect.runPromise(client.openThread(forked.thread_id))
      const created = opened.events.find((event): event is Event.ThreadCreated => event.type === "thread.created")

      expect(forked.thread_id).not.toBe(threadId)
      expect(opened.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: terminal.sequence }, (_, index) => index + 1),
      )
      expect(opened.events.every((event) => event.thread_id === forked.thread_id)).toBe(true)
      expect(created?.data.forked_from).toEqual({ thread_id: threadId, sequence: terminal.sequence })
      expect(opened.summary.latest_message_text).toBe("remote hello")
    } finally {
      await runtime.dispose()
    }
  })

  test("remote fork returns conflict while a turn is already active", async () => {
    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), {
        agentLayer: blockingAgentLoopLayer(),
      }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      await Effect.runPromise(
        client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "hold open" }),
      )
      const error = await Effect.runPromise(client.forkThread(threadId).pipe(Effect.flip))

      expect(error).toBeInstanceOf(Client.SdkError)
      expect(error.status).toBe(409)
      expect(error.message).toContain("active")
    } finally {
      await runtime.dispose()
    }
  })

  test("startTurn resumes a paused orb and restarts mirroring before the turn runs", async () => {
    const calls: Array<string> = []
    const runtime = ManagedRuntime.make(
      makeLayer(
        defaultContextLayer,
        orbManagerLayerWithStoredResume((id) => calls.push(`resume:${id}`)),
        fakeOrbMirrorLayer((id) => calls.push(`mirror:${id}`)),
      ),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    await Effect.runPromise(client.createThread({ thread_id: orbThreadId, project_id: projectId }))
    const paused = await runtime.runPromise(createPausedOrbRecord(orbThreadId))
    const streamedPromise = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: orbThreadId }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    const accepted = await Effect.runPromise(
      client.startTurn({ thread_id: orbThreadId, project_id: projectId, content: "resume before turn" }),
    )
    const streamed = await streamedPromise
    const stored = await runtime.runPromise(OrbStore.get(paused.orb_id))

    expect(accepted).toEqual({ thread_id: orbThreadId, accepted: true })
    expect(calls).toEqual([`resume:${paused.orb_id}`, `mirror:${paused.orb_id}`])
    expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })
    expect(stored?.status).toBe("running")
  })

  test("startup reconciliation fails orphaned active turns and allows a new turn", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-remote-orphaned-turn-"))
    const storageRuntime = ManagedRuntime.make(makeThreadStorageLayer(dataDir))

    try {
      await storageRuntime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* appendProjected(orphanedThreadCreated())
          yield* appendProjected(orphanedTurnStarted())
        }),
      )
    } finally {
      await storageRuntime.dispose()
    }

    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), { dataDir }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await runtime.runPromise(RemoteControl.backendHealth("http://rika.test"))
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: orphanedThreadId }))
      const projection = await runtime.runPromise(ThreadProjection.getThread(orphanedThreadId))
      const streamedPromise = Effect.runPromise(
        client.subscribeThreadEvents({ thread_id: orphanedThreadId, after_sequence: replay.at(-1)?.sequence }).pipe(
          Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
          Stream.runCollect,
        ),
      )
      const accepted = await Effect.runPromise(
        client.startTurn({ thread_id: orphanedThreadId, workspace_id: workspaceId, content: "after restart" }),
      )
      const streamed = await streamedPromise
      const failed = replay.filter((event): event is Event.TurnFailed => event.type === "turn.failed")

      expect(replay.map((event) => event.type)).toEqual(["thread.created", "turn.started", "turn.failed"])
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({
        thread_id: orphanedThreadId,
        turn_id: orphanedTurnId,
        sequence: 3,
        data: { error: { kind: "unknown", message: "turn interrupted by backend restart" } },
      })
      expect(projection).toMatchObject({
        thread_id: orphanedThreadId,
        active_turn_id: orphanedTurnId,
        active_turn_status: "failed",
      })
      expect(accepted).toEqual({ thread_id: orphanedThreadId, accepted: true })
      expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })
    } finally {
      await runtime.dispose()
      await rm(dataDir, { force: true, recursive: true })
    }
  })

  test("project remote API returns redacted summaries", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const created = await Effect.runPromise(
      client.createProject({
        name: "credentialed",
        repo_origin:
          "https://x-access-token:leaky-token-123@github.com/example/private.git?token=query-leak-123#fragment-leak-123",
      }),
    )
    await runtime.runPromise(ProjectStore.setEnv(created.project_id, "TOKEN", "env-secret-123"))
    const stored = await runtime.runPromise(ProjectStore.get(created.project_id))
    const projects = await Effect.runPromise(client.listProjects())
    const payload = JSON.stringify({ created, projects })

    expect(created).toMatchObject({
      name: "credentialed",
      repo_origin: "https://github.com/example/private.git",
      env: {},
      secret_names: [],
    })
    expect(stored?.repo_origin).toBe("https://github.com/example/private.git")
    expect(projects).toEqual([
      {
        project_id: created.project_id,
        name: created.name,
        repo_origin: created.repo_origin,
        default_branch: created.default_branch,
        template_id: created.template_id,
        env_keys: ["TOKEN"],
        secret_names: created.secret_names,
        created_at: created.created_at,
        updated_at: now,
      },
    ])
    expect(payload).not.toContain("leaky-token-123")
    expect(payload).not.toContain("query-leak-123")
    expect(payload).not.toContain("fragment-leak-123")
    expect(payload).not.toContain("env-secret-123")
    expect(JSON.stringify(projects)).not.toContain('"env"')
  })

  test("local token auth blocks unauthorized HTTP calls", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ port: 0, token: "secret" }))
    const client = Client.make(Client.fetchTransport({ base_url: handle.url, token: "secret" }))
    try {
      const unauthorized = await fetch(`${handle.url}/v1/threads`)
      const wrongToken = await fetch(`${handle.url}/v1/threads`, {
        headers: { authorization: "Bearer wrong" },
      })
      const unauthorizedHealth = await fetch(`${handle.url}/health`)
      const authorized = await fetch(`${handle.url}/v1/threads`, {
        headers: { authorization: "Bearer secret" },
      })
      const authorizedHealth = await fetch(`${handle.url}/health`, {
        headers: { authorization: "Bearer secret" },
      })
      const sdkHealth = await Effect.runPromise(client.backendHealth())

      expect(unauthorized.status).toBe(401)
      expect(wrongToken.status).toBe(401)
      expect(unauthorizedHealth.status).toBe(200)
      expect(await unauthorized.json()).toEqual({ error: { message: "Unauthorized", code: "unauthorized" } })
      expect(await wrongToken.json()).toEqual({ error: { message: "Unauthorized", code: "unauthorized" } })
      expect(await unauthorizedHealth.json()).toEqual({ status: "ok" })
      expect(authorized.status).toBe(200)
      expect(authorizedHealth.status).toBe(200)
      expect(await authorized.json()).toEqual([])
      expect(await authorizedHealth.json()).toMatchObject({
        status: "healthy",
        workspace_root: "/workspace/rika-remote",
        data_dir: "/workspace/rika-remote/.rika",
      })
      expect(sdkHealth).toMatchObject({ status: "healthy", workspace_root: "/workspace/rika-remote" })
    } finally {
      await runtime.runPromise(handle.close())
    }
  })

  test("local token auth protects every non-health route", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ port: 0, token: "secret" }))
    const routes: ReadonlyArray<{ readonly method: "GET" | "POST"; readonly path: string }> = [
      { method: "GET", path: "/v1/threads" },
      { method: "POST", path: "/v1/threads" },
      { method: "POST", path: "/v1/orbs" },
      { method: "GET", path: "/v1/orbs" },
      { method: "GET", path: `/v1/orbs/by-thread/${orbThreadId}` },
      { method: "POST", path: `/v1/orbs/${orbId}/pause` },
      { method: "POST", path: `/v1/orbs/${orbId}/resume` },
      { method: "POST", path: `/v1/orbs/${orbId}/kill` },
      { method: "GET", path: "/v1/projects" },
      { method: "POST", path: "/v1/projects" },
      { method: "GET", path: "/v1/threads/search" },
      { method: "GET", path: `/v1/threads/${threadId}` },
      { method: "GET", path: `/v1/threads/${threadId}/preview` },
      { method: "POST", path: `/v1/threads/${threadId}/visibility` },
      { method: "POST", path: `/v1/threads/${threadId}/archive` },
      { method: "POST", path: `/v1/threads/${threadId}/unarchive` },
      { method: "POST", path: `/v1/threads/${threadId}/compact` },
      { method: "GET", path: `/v1/threads/${threadId}/share` },
      { method: "GET", path: `/v1/threads/${threadId}/reference` },
      { method: "GET", path: `/v1/threads/${threadId}/events` },
      { method: "POST", path: "/v1/turns" },
      { method: "POST", path: "/v1/turns/interrupt" },
      { method: "GET", path: "/v1/artifacts" },
      { method: "GET", path: `/v1/artifacts/${artifactId}` },
      { method: "GET", path: "/v1/ide/status" },
      { method: "POST", path: "/v1/ide/connect" },
      { method: "POST", path: "/v1/ide/disconnect" },
      { method: "POST", path: "/v1/ide/context" },
      { method: "POST", path: "/v1/ide/open-file" },
      { method: "GET", path: "/v1/ide/navigation-requests" },
      { method: "GET", path: "/v1/orb/files" },
      { method: "GET", path: "/v1/orb/file?path=README.md" },
      { method: "GET", path: "/v1/orb/changes" },
    ]

    try {
      const responses = await Promise.all(
        routes.map(async (route) => ({
          route,
          response: await fetch(`${handle.url}${route.path}`, { method: route.method }),
        })),
      )

      expect(
        responses.map(({ route, response }) => ({ method: route.method, path: route.path, status: response.status })),
      ).toEqual(routes.map((route) => ({ ...route, status: 401 })))
    } finally {
      await runtime.runPromise(handle.close())
    }
  })

  test("HTTP thread authorization ignores self-asserted user_id", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const ownerToken = `user:${ownerId}:owner-secret`
    const outsiderToken = `user:${outsiderId}:outsider-secret`
    const forgedThreadId = Ids.ThreadId.make("thread_remote_forged_creator")
    const forgedWorkspaceId = Ids.WorkspaceId.make("workspace_remote_forged_creator")
    const ownerHandle = await runtime.runPromise(HttpServer.serve({ port: 0, token: ownerToken }))
    const outsiderHandle = await runtime.runPromise(HttpServer.serve({ port: 0, token: outsiderToken }))

    try {
      const created = await fetch(`${ownerHandle.url}/v1/threads`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ thread_id: threadId, workspace_id: workspaceId, user_id: ownerId }),
      })
      const forged = await fetch(`${outsiderHandle.url}/v1/threads/${threadId}?user_id=${ownerId}`, {
        headers: { authorization: `Bearer ${outsiderToken}` },
      })
      const forgedOwnedCreate = await fetch(`${outsiderHandle.url}/v1/threads`, {
        method: "POST",
        headers: { authorization: `Bearer ${outsiderToken}`, "content-type": "application/json" },
        body: JSON.stringify({ thread_id: forgedThreadId, workspace_id: workspaceId, user_id: ownerId }),
      })
      const forgedCreate = await fetch(`${outsiderHandle.url}/v1/threads`, {
        method: "POST",
        headers: { authorization: `Bearer ${outsiderToken}`, "content-type": "application/json" },
        body: JSON.stringify({ thread_id: forgedThreadId, workspace_id: forgedWorkspaceId, user_id: ownerId }),
      })
      const forgedCreated = Schema.decodeUnknownSync(Remote.ThreadSummary)(await forgedCreate.json())
      const ownerForgedOpen = await fetch(`${ownerHandle.url}/v1/threads/${forgedThreadId}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
      const outsiderForgedOpen = await fetch(`${outsiderHandle.url}/v1/threads/${forgedThreadId}?user_id=${ownerId}`, {
        headers: { authorization: `Bearer ${outsiderToken}` },
      })

      expect(created.status).toBe(200)
      expect(forged.status).toBe(403)
      expect(await forged.json()).toMatchObject({ error: { code: "workspace_access_denied" } })
      expect(forgedOwnedCreate.status).toBe(403)
      expect(await forgedOwnedCreate.json()).toMatchObject({ error: { code: "workspace_access_denied" } })
      expect(forgedCreate.status).toBe(200)
      expect(forgedCreated.user_id).toBe(outsiderId)
      expect(ownerForgedOpen.status).toBe(403)
      expect(outsiderForgedOpen.status).toBe(200)
    } finally {
      await runtime.runPromise(ownerHandle.close())
      await runtime.runPromise(outsiderHandle.close())
    }
  })

  test("HTTP thread event subscriptions do not leak private presence", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const ownerToken = `user:${ownerId}:owner-secret`
    const outsiderToken = `user:${outsiderId}:outsider-secret`
    const presenceThreadId = Ids.ThreadId.make("thread_remote_private_presence")
    const ownerHandle = await runtime.runPromise(HttpServer.serve({ port: 0, token: ownerToken }))
    const outsiderHandle = await runtime.runPromise(HttpServer.serve({ port: 0, token: outsiderToken }))

    try {
      const created = await fetch(`${ownerHandle.url}/v1/threads`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ thread_id: presenceThreadId, workspace_id: workspaceId, user_id: ownerId }),
      })
      const presenceSet = await fetch(`${ownerHandle.url}/v1/threads/${presenceThreadId}/presence`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ user_id: ownerId, state: "active" }),
      })
      const events = await fetch(`${outsiderHandle.url}/v1/threads/${presenceThreadId}/events?user_id=${ownerId}`, {
        headers: { authorization: `Bearer ${outsiderToken}` },
      })
      const body = await events.text()
      const frames = body
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => Schema.decodeUnknownSync(Remote.StreamFrame)(JSON.parse(line)))

      expect(created.status).toBe(200)
      expect(presenceSet.status).toBe(200)
      expect(events.status).toBe(200)
      expect(frames).toEqual([
        expect.objectContaining({ error: expect.objectContaining({ code: "workspace_access_denied" }) }),
      ])
      expect(body).not.toContain(ownerId)
    } finally {
      await runtime.runPromise(ownerHandle.close())
      await runtime.runPromise(outsiderHandle.close())
    }
  })

  test("serves orb changes only when the HTTP server is in orb mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-changes-http-"))
    await runGit(workspace, ["init", "-b", "main"])
    await runGit(workspace, ["config", "user.email", "rika@example.test"])
    await runGit(workspace, ["config", "user.name", "Rika Test"])
    await writeFile(join(workspace, "README.md"), "before\n")
    await runGit(workspace, ["add", "README.md"])
    await runGit(workspace, ["commit", "-m", "init"])
    const baseCommit = (await runGit(workspace, ["rev-parse", "HEAD"])).trim()
    await writeFile(join(workspace, "README.md"), "after\n")

    const runtime = ManagedRuntime.make(makeLayer())

    try {
      const disabled = await runtime.runPromise(HttpServer.handle(new Request("http://rika.test/v1/orb/changes")))
      const handle = await runtime.runPromise(
        HttpServer.serve({
          port: 0,
          token: "secret",
          orb: true,
          base_commit: baseCommit,
          workspace_root: workspace,
        }),
      )
      try {
        const unauthorized = await fetch(`${handle.url}/v1/orb/changes`)
        const enabled = await fetch(`${handle.url}/v1/orb/changes`, {
          headers: { authorization: "Bearer secret" },
        })
        const body = Schema.decodeUnknownSync(Remote.OrbChangesResponse)(await enabled.json())

        expect(disabled.status).toBe(404)
        expect(unauthorized.status).toBe(401)
        expect(enabled.status).toBe(200)
        expect(body).toMatchObject({
          base_commit: baseCommit,
          head_commit: baseCommit,
          dirty: true,
        })
        expect(body.diff).toContain("diff --git a/README.md b/README.md")
        expect(body.diff).toContain("+after")
      } finally {
        await runtime.runPromise(handle.close())
      }
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("serves read-only orb files only when the HTTP server is in orb mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-files-http-"))
    await mkdir(join(workspace, "src"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(join(workspace, "README.md"), "hello\n")
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1\n")
    await writeFile(join(workspace, ".rika", "runtime.db"), "internal\n")
    const runtime = ManagedRuntime.make(makeLayer())

    try {
      const disabled = await runtime.runPromise(HttpServer.handle(new Request("http://rika.test/v1/orb/files")))
      const handle = await runtime.runPromise(
        HttpServer.serve({
          port: 0,
          token: "secret",
          orb: true,
          base_commit: "abc123",
          workspace_root: workspace,
        }),
      )
      try {
        const listed = await fetch(`${handle.url}/v1/orb/files`, {
          headers: { authorization: "Bearer secret" },
        })
        const opened = await fetch(`${handle.url}/v1/orb/file?path=README.md`, {
          headers: { authorization: "Bearer secret" },
        })
        const invalid = await fetch(`${handle.url}/v1/orb/file?path=..%2Fsecret.txt`, {
          headers: { authorization: "Bearer secret" },
        })
        const files = Schema.decodeUnknownSync(Remote.OrbFilesResponse)(await listed.json())
        const file = Schema.decodeUnknownSync(Remote.OrbFileResponse)(await opened.json())

        expect(disabled.status).toBe(404)
        expect(listed.status).toBe(200)
        expect(opened.status).toBe(200)
        expect(invalid.status).toBe(400)
        expect(files).toEqual({
          path: "",
          entries: [
            { name: "src", path: "src", kind: "dir" },
            { name: "README.md", path: "README.md", kind: "file", size: 6 },
          ],
        })
        expect(file).toEqual({ path: "README.md", kind: "text", content: "hello\n", truncated: false })
      } finally {
        await runtime.runPromise(handle.close())
      }
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("client-supplied auth marker cannot unlock health details", async () => {
    const runtime = ManagedRuntime.make(makeLayer())

    const response = await runtime.runPromise(
      HttpServer.handle(
        new Request("http://rika.test/health", {
          headers: {
            "x-rika-required-token": "fake",
            authorization: "Bearer fake",
          },
        }),
      ),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  test("non-loopback server binds require a token", async () => {
    const runtime = ManagedRuntime.make(makeLayer())

    const error = await runtime.runPromise(HttpServer.serve({ host: "0.0.0.0", port: 0 }).pipe(Effect.flip))
    const handle = await runtime.runPromise(HttpServer.serve({ host: "0.0.0.0", port: 0, token: "secret" }))

    try {
      expect(error).toBeInstanceOf(HttpServer.HttpServerError)
      if (!(error instanceof HttpServer.HttpServerError)) throw new Error("expected HttpServerError")
      expect(error.message).toBe("refusing to bind non-loopback host without --token")
      expect(handle.url).toStartWith("http://0.0.0.0:")
    } finally {
      await runtime.runPromise(handle.close())
    }
  })

  test("remote thread visibility gates user reads", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const remote = yield* RemoteControl.Service
        const created = yield* remote.createThread({
          thread_id: threadId,
          workspace_id: workspaceId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        yield* WorkspaceStore.putMembership({
          workspace_id: workspaceId,
          user_id: memberId,
          role: "member",
          created_at: now,
        })

        const ownerThreads = yield* remote.listThreads({ user_id: ownerId, authorization_user_id: ownerId })
        const privateOutsiderThreads = yield* remote.listThreads({
          user_id: outsiderId,
          authorization_user_id: outsiderId,
        })
        const privateOutsiderOpen = yield* remote
          .openThread({ thread_id: threadId, user_id: outsiderId, authorization_user_id: outsiderId })
          .pipe(Effect.flip)
        const privateOutsiderCreate = yield* remote
          .createThread({
            thread_id: threadId,
            workspace_id: workspaceId,
            user_id: outsiderId,
            authorization_user_id: outsiderId,
          })
          .pipe(Effect.flip)

        const workspaceVisible = yield* remote.setThreadVisibility({
          thread_id: threadId,
          visibility: "workspace",
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        const memberThreads = yield* remote.listThreads({ user_id: memberId, authorization_user_id: memberId })
        const memberSearch = yield* remote.searchThreads({
          query: "",
          user_id: memberId,
          authorization_user_id: memberId,
        })
        const outsiderThreads = yield* remote.listThreads({ user_id: outsiderId, authorization_user_id: outsiderId })

        const unlisted = yield* remote.setThreadVisibility({
          thread_id: threadId,
          visibility: "unlisted",
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        const outsiderOpen = yield* remote.openThread({
          thread_id: threadId,
          user_id: outsiderId,
          authorization_user_id: outsiderId,
        })
        const outsiderPreview = yield* remote.previewThread({
          thread_id: threadId,
          user_id: outsiderId,
          authorization_user_id: outsiderId,
        })
        const outsiderUnlistedThreads = yield* remote.listThreads({
          user_id: outsiderId,
          authorization_user_id: outsiderId,
        })
        const outsiderSearch = yield* remote.searchThreads({
          query: "",
          user_id: outsiderId,
          authorization_user_id: outsiderId,
        })
        const outsiderCreateError = yield* remote
          .createThread({
            thread_id: outsiderThreadId,
            workspace_id: workspaceId,
            user_id: outsiderId,
            authorization_user_id: outsiderId,
          })
          .pipe(Effect.flip)
        return {
          created,
          ownerThreads,
          privateOutsiderThreads,
          privateOutsiderOpen,
          privateOutsiderCreate,
          workspaceVisible,
          memberThreads,
          memberSearch,
          outsiderThreads,
          unlisted,
          outsiderOpen,
          outsiderPreview,
          outsiderUnlistedThreads,
          outsiderSearch,
          outsiderCreateError,
        }
      }),
    )

    expect(result.created).toMatchObject({
      thread_id: threadId,
      workspace_id: workspaceId,
      user_id: ownerId,
      visibility: "private",
    })
    expect(result.ownerThreads.map((summary) => summary.thread_id)).toEqual([threadId])
    expect(result.privateOutsiderThreads).toEqual([])
    expect(result.privateOutsiderOpen).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.privateOutsiderCreate).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.workspaceVisible.visibility).toBe("workspace")
    expect(result.memberThreads.map((summary) => summary.thread_id)).toEqual([threadId])
    expect(result.memberSearch.map((item) => item.summary.thread_id)).toEqual([threadId])
    expect(result.outsiderThreads).toEqual([])
    expect(result.unlisted.visibility).toBe("unlisted")
    expect(result.outsiderOpen.summary.thread_id).toBe(threadId)
    expect(result.outsiderPreview.summary.thread_id).toBe(threadId)
    expect(result.outsiderUnlistedThreads).toEqual([])
    expect(result.outsiderSearch).toEqual([])
    expect(result.outsiderCreateError).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.outsiderCreateError).toMatchObject({
      action: "write",
      workspace_id: workspaceId,
      user_id: outsiderId,
    })
  })

  test("remote thread visibility applies limits after filtering unreadable threads", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const hiddenThreadIds = Array.from({ length: 1_001 }, (_value, index) =>
      Ids.ThreadId.make(`thread_remote_filter_${index.toString().padStart(4, "0")}`),
    )
    const visibleThreadId = Ids.ThreadId.make("thread_remote_filter_z_visible")
    const visibleWorkspaceId = Ids.WorkspaceId.make("workspace_remote_filter_visible")

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const remote = yield* RemoteControl.Service
        yield* Effect.forEach(
          hiddenThreadIds,
          (hiddenThreadId) =>
            remote.createThread({
              thread_id: hiddenThreadId,
              workspace_id: workspaceId,
              user_id: ownerId,
            }),
          { discard: true },
        )
        yield* remote.createThread({
          thread_id: visibleThreadId,
          workspace_id: visibleWorkspaceId,
          user_id: outsiderId,
          authorization_user_id: outsiderId,
        })
        const listed = yield* remote.listThreads({ user_id: outsiderId, authorization_user_id: outsiderId, limit: 1 })
        const searched = yield* remote.searchThreads({
          query: "",
          user_id: outsiderId,
          authorization_user_id: outsiderId,
          limit: 1,
        })
        return { listed, searched }
      }),
    )

    expect(result.listed.map((summary) => summary.thread_id)).toEqual([visibleThreadId])
    expect(result.searched.map((item) => item.summary.thread_id)).toEqual([visibleThreadId])
  })

  test("remote authenticated search honors archived query filters before visibility prefiltering", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const archivedSearchThreadId = Ids.ThreadId.make("thread_remote_archived_search_filter")
    const archivedSearchTurnId = Ids.TurnId.make("turn_remote_archived_search_filter")

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const remote = yield* RemoteControl.Service
        yield* remote.createThread({
          thread_id: archivedSearchThreadId,
          workspace_id: workspaceId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        yield* appendProjected({
          id: Ids.EventId.make("event_remote_archived_search_message"),
          thread_id: archivedSearchThreadId,
          turn_id: archivedSearchTurnId,
          sequence: 2,
          version: 1,
          created_at: now,
          type: "message.added",
          data: {
            message: {
              id: Ids.MessageId.make("message_remote_archived_search"),
              thread_id: archivedSearchThreadId,
              turn_id: archivedSearchTurnId,
              role: "user",
              created_at: now,
              content: [{ type: "text", text: "needle archived remote search" }],
            },
          },
        })
        yield* remote.archiveThread({
          thread_id: archivedSearchThreadId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        return yield* remote.searchThreads({
          query: "needle archived:true",
          include_archived: false,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
      }),
    )

    expect(result.map((item) => item.summary.thread_id)).toEqual([archivedSearchThreadId])
  })

  test("remote thread visibility gates user writes", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const remote = yield* RemoteControl.Service
        yield* remote.createThread({
          thread_id: threadId,
          workspace_id: workspaceId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        const archiveError = yield* remote
          .archiveThread({ thread_id: threadId, user_id: outsiderId, authorization_user_id: outsiderId })
          .pipe(Effect.flip)
        const compactError = yield* remote
          .compactThread({ thread_id: threadId, user_id: outsiderId, authorization_user_id: outsiderId })
          .pipe(Effect.flip)
        const forkError = yield* remote
          .forkThread({ thread_id: threadId, user_id: outsiderId, authorization_user_id: outsiderId })
          .pipe(Effect.flip)
        const startError = yield* remote
          .startTurn({
            thread_id: threadId,
            workspace_id: workspaceId,
            user_id: outsiderId,
            authorization_user_id: outsiderId,
            content: "mutate private",
          })
          .pipe(Effect.flip)
        const interruptError = yield* remote
          .interruptTurn({
            thread_id: threadId,
            turn_id: Ids.TurnId.make("turn_remote_unauthorized"),
            user_id: outsiderId,
            authorization_user_id: outsiderId,
          })
          .pipe(Effect.flip)
        const opened = yield* remote.openThread({
          thread_id: threadId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        return { archiveError, compactError, forkError, startError, interruptError, opened }
      }),
    )

    for (const error of [
      result.archiveError,
      result.compactError,
      result.forkError,
      result.startError,
      result.interruptError,
    ]) {
      expect(error).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    }
    expect(result.opened.summary.archived).toBe(false)
    expect(result.opened.events.map((event) => event.type)).toEqual(["thread.created"])
  })

  test("remote authenticated creation records the trusted principal as thread owner", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const createThreadId = Ids.ThreadId.make("thread_remote_trusted_create")
    const turnThreadId = Ids.ThreadId.make("thread_remote_trusted_turn")
    const forkSourceThreadId = Ids.ThreadId.make("thread_remote_trusted_fork_source")

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const remote = yield* RemoteControl.Service
        const created = yield* remote.createThread({
          thread_id: createThreadId,
          workspace_id: workspaceId,
          user_id: ownerId,
          authorization_user_id: outsiderId,
        })
        const ownerOpenCreate = yield* remote
          .openThread({ thread_id: createThreadId, user_id: ownerId, authorization_user_id: ownerId })
          .pipe(Effect.flip)
        const outsiderOpenCreate = yield* remote.openThread({
          thread_id: createThreadId,
          user_id: ownerId,
          authorization_user_id: outsiderId,
        })

        yield* remote.startTurn({
          thread_id: turnThreadId,
          workspace_id: workspaceId,
          user_id: ownerId,
          authorization_user_id: outsiderId,
          content: "trusted creator",
        })
        yield* Effect.sleep("20 millis")
        const ownerOpenTurn = yield* remote
          .openThread({ thread_id: turnThreadId, user_id: ownerId, authorization_user_id: ownerId })
          .pipe(Effect.flip)
        const outsiderOpenTurn = yield* remote.openThread({
          thread_id: turnThreadId,
          user_id: ownerId,
          authorization_user_id: outsiderId,
        })

        yield* remote.createThread({
          thread_id: forkSourceThreadId,
          workspace_id: workspaceId,
          user_id: outsiderId,
          authorization_user_id: outsiderId,
        })
        const forked = yield* remote.forkThread({
          thread_id: forkSourceThreadId,
          user_id: ownerId,
          authorization_user_id: outsiderId,
        })
        const ownerOpenFork = yield* remote
          .openThread({ thread_id: forked.thread_id, user_id: ownerId, authorization_user_id: ownerId })
          .pipe(Effect.flip)
        const outsiderOpenFork = yield* remote.openThread({
          thread_id: forked.thread_id,
          user_id: ownerId,
          authorization_user_id: outsiderId,
        })

        return {
          created,
          ownerOpenCreate,
          outsiderOpenCreate,
          ownerOpenTurn,
          outsiderOpenTurn,
          forked,
          ownerOpenFork,
          outsiderOpenFork,
        }
      }),
    )

    expect(result.created.user_id).toBe(outsiderId)
    expect(result.ownerOpenCreate).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.outsiderOpenCreate.summary.user_id).toBe(outsiderId)
    expect(result.ownerOpenTurn).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.outsiderOpenTurn.summary.user_id).toBe(outsiderId)
    expect(result.forked.user_id).toBe(outsiderId)
    expect(result.ownerOpenFork).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.outsiderOpenFork.summary.user_id).toBe(outsiderId)
  })

  test("remote thread visibility gates artifacts and presence", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const artifact: Artifact.Artifact = {
      id: artifactId,
      thread_id: threadId,
      kind: "research",
      title: "Private artifact",
      content: { ok: true },
      created_at: now,
    }
    const storedArtifact = { ...artifact, workspace_id: workspaceId }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const remote = yield* RemoteControl.Service
        yield* remote.createThread({
          thread_id: threadId,
          workspace_id: workspaceId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        yield* ArtifactStore.put(artifact)
        const listError = yield* remote
          .listArtifacts({
            thread_id: threadId,
            kind: "research",
            user_id: outsiderId,
            authorization_user_id: outsiderId,
          })
          .pipe(Effect.flip)
        const getError = yield* remote
          .getArtifact({
            artifact_id: artifactId,
            user_id: outsiderId,
            authorization_user_id: outsiderId,
          })
          .pipe(Effect.flip)
        const presenceError = yield* remote
          .setThreadPresence({
            thread_id: threadId,
            user_id: outsiderId,
            state: "typing",
            authorization_user_id: outsiderId,
          })
          .pipe(Effect.flip)
        const ownerArtifacts = yield* remote.listArtifacts({
          thread_id: threadId,
          kind: "research",
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        const ownerArtifact = yield* remote.getArtifact({
          artifact_id: artifactId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        return { listError, getError, presenceError, ownerArtifacts, ownerArtifact }
      }),
    )

    expect(result.listError).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.getError).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.presenceError).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
    expect(result.ownerArtifacts.map((item) => item.id)).toEqual([artifactId])
    expect(result.ownerArtifact).toEqual(storedArtifact)
  })

  test("remote thread event subscriptions stop when visibility is revoked", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const remote = yield* RemoteControl.Service
        yield* remote.createThread({
          thread_id: threadId,
          workspace_id: workspaceId,
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        yield* remote.setThreadVisibility({
          thread_id: threadId,
          visibility: "unlisted",
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        const outsiderSubscription = remote
          .subscribeThreadEvents({
            thread_id: threadId,
            user_id: outsiderId,
            authorization_user_id: outsiderId,
            after_sequence: 2,
          })
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("2 seconds"), Effect.flip, Effect.forkChild)
        const fiber = yield* outsiderSubscription
        yield* remote.setThreadVisibility({
          thread_id: threadId,
          visibility: "private",
          user_id: ownerId,
          authorization_user_id: ownerId,
        })
        const subscriptionError = yield* Fiber.join(fiber)
        return { subscriptionError }
      }),
    )

    expect(result.subscriptionError).toBeInstanceOf(WorkspaceAccess.WorkspaceAccessDenied)
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
    const streamedPromise = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: ideThreadId }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    await Effect.runPromise(
      client.startTurn({ thread_id: ideThreadId, workspace_id: workspaceId, content: "use my editor context" }),
    )
    const streamed = await streamedPromise
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

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}
