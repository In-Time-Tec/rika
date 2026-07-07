import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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
import { Provider, Router } from "@rika/llm"
import { OrbManager } from "@rika/orb"
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
import { Common, Ids, Remote } from "@rika/schema"
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect"
import { HttpServer, OrbMirror, PresenceHub, RemoteControl } from "@rika/server"
import {
  ChangedDraft,
  ChangedDraftMode,
  ChangedThreadSearchQuery,
  ClickedInterrupt,
  ClickedKillOrb,
  ClickedPauseOrb,
  ClickedResumeOrb,
  ConfirmedKillOrb,
  SubmittedDraft,
  ChangedNewProjectEnvKey,
  ChangedNewProjectEnvValue,
  ChangedNewProjectField,
  ChangedProjectEnvValue,
  ChangedProjectSecretField,
  ClickedProject,
  ClickedProjects,
  GotDeleteSecretDialogMessage,
  GotKillOrbDialogMessage,
  ReceivedPresence,
  SubmittedNewProject,
  SubmittedProjectSecret,
  SubmittedProjectSettings,
  eventRows,
  init,
  initialModel,
  subscriptions,
  update,
} from "../src/app"
import { CompletedCloseDialog, CompletedShowDialog } from "../src/components/ui/alert-dialog"
import type { AppCommand, AppMessage, Model } from "../src/app"
import { orbTerminalRegistryLayer } from "../src/orb-terminal"
import { pierreTreeRegistryLayer } from "../src/pierre-tree"

const webResourcesLayer = Layer.mergeAll(orbTerminalRegistryLayer, pierreTreeRegistryLayer)

const threadId = Ids.ThreadId.make("thread_web_e2e_sync")
const orbThreadId = Ids.ThreadId.make("thread_web_orb_controls")
const workspaceId = Ids.WorkspaceId.make("workspace_web_e2e_sync")
const now = Common.TimestampMillis.make(2_000_000_000_000)

describe("web local sync e2e", () => {
  test("one submitted turn updates two remote clients and the Foldkit web app over the real HTTP server", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      const firstTerminal = client(handle.url)
      const secondTerminal = client(handle.url)
      const webApiBaseUrl = handle.url

      await Effect.runPromise(firstTerminal.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      let webModel = await openWebModel(webApiBaseUrl)
      expect(webModel.last_sequence).toBe(1)

      const terminalOneEvents = collectTurn(firstTerminal, webModel.last_sequence)
      const terminalTwoEvents = collectTurn(secondTerminal, webModel.last_sequence)
      const webMessages = collectWebMessages(webModel)

      const accepted = await Effect.runPromise(
        firstTerminal.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "sync every client" }),
      )
      const [firstEvents, secondEvents, messages] = await Promise.all([
        terminalOneEvents,
        terminalTwoEvents,
        webMessages,
      ])

      for (const message of messages) {
        ;[webModel] = update(webModel, message)
      }

      const firstTypes = firstEvents.map((event) => event.type)
      const secondTypes = secondEvents.map((event) => event.type)
      const webEvents = webModel.events.filter((event) => event.sequence > 1)

      expect(accepted).toEqual({ thread_id: threadId, accepted: true })
      expect(firstTypes).toEqual(secondTypes)
      expect(webEvents.map((event) => event.type)).toEqual(firstTypes)
      expect(webEvents.map((event) => event.sequence)).toEqual(firstEvents.map((event) => event.sequence))
      expect(firstTypes).toContain("message.added")
      expect(firstEvents.at(-1)).toMatchObject({ type: "turn.completed" })
      expect(webModel.pending_turn).toBe(false)
      expect(
        eventRows(webModel.events)
          .map((row) => (row.kind === "pierre-diff" ? row.diff.file_name : row.body))
          .join("\n"),
      ).toContain("remote hello")

      const beforeSubmitSequences = webModel.events.map((event) => event.sequence)
      ;[webModel] = update(webModel, ChangedDraft({ value: "submitted from web" }))
      const [submittedModel, commands] = update(webModel, SubmittedDraft())

      expect(submittedModel.events.map((event) => event.sequence)).toEqual(beforeSubmitSequences)
      expect(submittedModel.pending_turn).toBe(true)
      expect(commands.map((command) => command.name)).toEqual(["StartTurn"])
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
    }
  })

  test("presence heartbeats and typing state sync over thread event subscriptions", async () => {
    let currentTime = now
    const timeLayer = Layer.succeed(Time.Service, Time.Service.of({ nowMillis: Effect.sync(() => currentTime) }))
    const runtime = ManagedRuntime.make(makeLayer(timeLayer))
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      const firstUserId = Ids.UserId.make("user_web_presence_first")
      const secondUserId = Ids.UserId.make("user_web_presence_second")
      const firstTerminal = client(handle.url, firstUserId)
      const secondTerminal = client(handle.url, secondUserId)
      const firstSnapshots: Array<Remote.PresenceFrame["presence"]> = []
      const secondSnapshots: Array<Remote.PresenceFrame["presence"]> = []

      await Effect.runPromise(firstTerminal.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      await runtime.runPromise(
        WorkspaceStore.putMembership({
          workspace_id: workspaceId,
          user_id: secondUserId,
          role: "member",
          created_at: now,
        }),
      )
      await Effect.runPromise(firstTerminal.setThreadVisibility(threadId, "workspace"))
      const firstFiber = Effect.runFork(
        firstTerminal
          .subscribeThreadEvents({ thread_id: threadId, onPresence: (snapshot) => firstSnapshots.push(snapshot) })
          .pipe(Stream.runDrain),
      )
      const secondFiber = Effect.runFork(
        secondTerminal
          .subscribeThreadEvents({ thread_id: threadId, onPresence: (snapshot) => secondSnapshots.push(snapshot) })
          .pipe(Stream.runDrain),
      )

      try {
        await waitFor(
          () =>
            hasPresence(firstSnapshots, secondUserId, "active") && hasPresence(secondSnapshots, firstUserId, "active"),
        )
        await Effect.runPromise(
          secondTerminal.setThreadPresence({ thread_id: threadId, user_id: secondUserId, state: "typing" }),
        )
        await waitFor(() => hasPresence(firstSnapshots, secondUserId, "typing"))
        const [webModel] = update(
          initialModel({ api_base_url: handle.url, user_id: firstUserId }),
          ReceivedPresence({ presence: lastSnapshot(firstSnapshots)! }),
        )
        expect(webModel.presence).toContainEqual({
          user_id: secondUserId,
          state: "typing",
          last_seen: now,
        })
        currentTime = Common.TimestampMillis.make(now + 46_000)
        await waitFor(() => lastSnapshot(firstSnapshots)?.users.length === 0)
      } finally {
        await Promise.all([
          Effect.runPromise(Fiber.interrupt(firstFiber)),
          Effect.runPromise(Fiber.interrupt(secondFiber)),
        ])
      }
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
    }
  })

  test("orb controls load badge state and drive OrbStore lifecycle through the HTTP server", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      const api = client(handle.url)
      const project = await Effect.runPromise(
        api.createProject({ name: "web-orb", repo_origin: "https://github.com/example/rika.git" }),
      )
      await Effect.runPromise(api.createThread({ thread_id: orbThreadId, project_id: project.project_id }))
      const created = await Effect.runPromise(
        api.createOrbThread({ thread_id: orbThreadId, project_id: project.project_id, mode: "smart" }),
      )

      let webModel = await openWebModel(handle.url, orbThreadId)
      expect(created.orb_status).toBe("running")
      expect(webModel.selected_orb?.status).toBe("running")
      expect(webModel.threads.find((thread) => thread.thread_id === orbThreadId)?.orb_status).toBe("running")

      const [pausing, pauseCommands] = update(webModel, ClickedPauseOrb())
      webModel = await runCommands(pausing, pauseCommands)
      const paused = requireSelectedOrb(webModel)
      const pausedStored = await runtime.runPromise(OrbStore.get(paused.orb_id))
      expect(pauseCommands.map((command) => command.name)).toEqual(["PauseSelectedOrb"])
      expect(paused.status).toBe("paused")
      expect(pausedStored?.status).toBe("paused")
      expect(webModel.threads.find((thread) => thread.thread_id === orbThreadId)?.orb_status).toBe("paused")

      const [resuming, resumeCommands] = update(webModel, ClickedResumeOrb())
      webModel = await runCommands(resuming, resumeCommands)
      const resumed = requireSelectedOrb(webModel)
      const resumedStored = await runtime.runPromise(OrbStore.get(resumed.orb_id))
      expect(resumeCommands.map((command) => command.name)).toEqual(["ResumeSelectedOrb"])
      expect(resumed.status).toBe("running")
      expect(resumedStored?.status).toBe("running")

      const [confirmingKill, firstKillCommands] = update(webModel, ClickedKillOrb())
      const preKill = await runtime.runPromise(OrbStore.get(resumed.orb_id))
      expect(firstKillCommands.map((command) => command.name)).toEqual(["ShowDialog"])
      expect(confirmingKill.confirm_kill_orb_id).toBe(resumed.orb_id)
      expect(preKill?.status).toBe("running")

      const [killing, killCommands] = update(confirmingKill, ConfirmedKillOrb())
      webModel = await runCommands(killing, killCommands)
      const killed = requireSelectedOrb(webModel)
      const killedStored = await runtime.runPromise(OrbStore.get(killed.orb_id))
      expect(killCommands.map((command) => command.name)).toEqual(["KillSelectedOrb", "CloseDialog"])
      expect(killed.status).toBe("killed")
      expect(killedStored?.status).toBe("killed")
      expect(webModel.threads.find((thread) => thread.thread_id === orbThreadId)?.orb_status).toBe("killed")
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
    }
  })

  test("mode selection round-trips through the durable turn.started event", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      const api = client(handle.url)
      await Effect.runPromise(api.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      let webModel = await openWebModel(handle.url)

      const webMessages = collectWebMessages(webModel)
      ;[webModel] = update(webModel, ChangedDraft({ value: "use a deeper mode" }))
      ;[webModel] = update(webModel, ChangedDraftMode({ value: "deep2" }))
      const [submitted, commands] = update(webModel, SubmittedDraft())
      webModel = await runCommands(submitted, commands)
      const messages = await webMessages
      for (const message of messages) {
        ;[webModel] = update(webModel, message)
      }

      const started = webModel.events.find(isTurnStartedEvent)
      expect(started?.data.mode).toBe("deep2")
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
    }
  })

  test("web sidebar search loads matching fixture threads through the HTTP server", async () => {
    const searchMatchThreadId = Ids.ThreadId.make("thread_web_search_match")
    const searchMissThreadId = Ids.ThreadId.make("thread_web_search_miss")
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      const api = client(handle.url)
      await Effect.runPromise(api.createThread({ thread_id: searchMatchThreadId, workspace_id: workspaceId }))
      await Effect.runPromise(api.createThread({ thread_id: searchMissThreadId, workspace_id: workspaceId }))
      const matchEvents = collectTurnForThread(api, searchMatchThreadId, 1)
      await Effect.runPromise(
        api.startTurn({
          thread_id: searchMatchThreadId,
          workspace_id: workspaceId,
          content: "neural cache index",
        }),
      )
      await matchEvents
      const missEvents = collectTurnForThread(api, searchMissThreadId, 1)
      await Effect.runPromise(
        api.startTurn({
          thread_id: searchMissThreadId,
          workspace_id: workspaceId,
          content: "unrelated settings",
        }),
      )
      await missEvents

      let webModel = await openWebModel(handle.url, searchMatchThreadId)
      const [searching, commands] = update(webModel, ChangedThreadSearchQuery({ value: "neural", now }))
      webModel = await runCommands(searching, commands)

      expect(commands.map((command) => command.name)).toEqual(["SearchThreads"])
      expect(webModel.threads.map((thread) => thread.thread_id)).toEqual([searchMatchThreadId])
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
    }
  })

  test("interrupt stops the active web turn and hides the Stop action after the terminal event", async () => {
    const runtime = ManagedRuntime.make(makeLayer(Time.fixedLayer(now), slowProviderRegistryLayer()))
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      const api = client(handle.url)
      await Effect.runPromise(api.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      let webModel = await openWebModel(handle.url)

      const startedMessages = collectWebMessagesUntil(webModel, isTurnStartedMessage)
      await Effect.runPromise(api.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "wait" }))
      for (const message of await startedMessages) {
        ;[webModel] = update(webModel, message)
      }

      const turnId = webModel.events.find(isTurnStartedEvent)?.turn_id
      expect(turnId).toBeDefined()

      const [interrupting, commands] = update(webModel, ClickedInterrupt())
      expect(commands.map((command) => command.name)).toEqual(["InterruptTurn"])
      const terminalMessages = collectWebMessages(interrupting)
      webModel = await runCommands(interrupting, commands)
      for (const message of await terminalMessages) {
        ;[webModel] = update(webModel, message)
      }

      const failed = webModel.events.filter(isTurnFailedEvent).find((event) => event.turn_id === turnId)
      const [, afterTerminalCommands] = update(webModel, ClickedInterrupt())
      expect(failed?.data.error.kind).toBe("cancelled")
      expect(afterTerminalCommands).toEqual([])
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
    }
  })

  test("projects settings round-trip env values and write-only secrets through the web model", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-web-projects-"))
    const runtime = ManagedRuntime.make(makeLayer(Time.fixedLayer(now), undefined, dataDir))
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      let webModel = await runCommands(...init({ api_base_url: handle.url }))
      const [projectsView, loadCommands] = update(webModel, ClickedProjects())
      webModel = await runCommands(projectsView, loadCommands)
      ;[webModel] = update(webModel, ChangedNewProjectField({ field: "name", value: "demo" }))
      ;[webModel] = update(
        webModel,
        ChangedNewProjectField({ field: "repo_origin", value: "https://github.com/example/rika.git" }),
      )
      ;[webModel] = update(webModel, ChangedNewProjectEnvKey({ value: "NODE_ENV" }))
      ;[webModel] = update(webModel, ChangedNewProjectEnvValue({ value: "development" }))
      const [creating, createCommands] = update(webModel, SubmittedNewProject())
      webModel = await runCommands(creating, createCommands)
      const projectId = webModel.selected_project_id
      if (projectId === undefined) throw new Error("expected created project")
      ;[webModel] = update(webModel, ChangedProjectEnvValue({ key: "NODE_ENV", value: "test" }))
      const [saving, saveCommands] = update(webModel, SubmittedProjectSettings())
      webModel = await runCommands(saving, saveCommands)
      ;[webModel] = update(webModel, ChangedProjectSecretField({ field: "name", value: "OPENAI_API_KEY" }))
      ;[webModel] = update(webModel, ChangedProjectSecretField({ field: "value", value: "secret-value" }))
      const [settingSecret, secretCommands] = update(webModel, SubmittedProjectSecret())
      webModel = await runCommands(settingSecret, secretCommands)

      const [reloading, reloadCommands] = update(webModel, ClickedProject({ project_id: projectId }))
      webModel = await runCommands(reloading, reloadCommands)
      const api = client(handle.url)
      const listed = await Effect.runPromise(api.listProjects())
      const detail = await Effect.runPromise(api.getProject(projectId))

      expect(webModel.selected_project?.env).toEqual({ NODE_ENV: "test" })
      expect(webModel.selected_project?.secret_names).toEqual(["OPENAI_API_KEY"])
      expect(webModel.project_secret_value).toBe("")
      expect(listed[0]).toMatchObject({ env_keys: ["NODE_ENV"], secret_names: ["OPENAI_API_KEY"] })
      expect(JSON.stringify(listed)).not.toContain("test")
      expect(detail.env).toEqual({ NODE_ENV: "test" })
      expect(JSON.stringify(detail)).not.toContain("secret-value")
      expect(JSON.stringify(webModel)).not.toContain("secret-value")
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
      await rm(dataDir, { force: true, recursive: true })
    }
  })
})

const makeLayer = (
  timeLayer: Layer.Layer<Time.Service> = Time.fixedLayer(now),
  providerRegistryLayer: Layer.Layer<Provider.Registry> = Provider.fakeRegistryLayer([
    { name: "anthropic", responses: ["remote hello", "web hello"] },
    { name: "openai", responses: ["remote hello", "web hello"] },
  ]),
  dataDir = "/workspace/rika-web-e2e/.rika",
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-web-e2e",
    data_dir: dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
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
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(providerRegistryLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    threadLayer,
    workspaceAccessLayer,
    ContextResolver.fakeLayer({ entries: [], rendered: "", total_chars: 0 }),
    SkillRegistry.emptyLayer,
    ToolExecutor.fakeLayer({}).pipe(Layer.provideMerge(diagnosticsLayer)),
    redactorLayer,
    diagnosticsLayer,
    llmLayer,
    IdeBridge.layer,
    unusedCompactionLayer(),
    fakeOrbManagerLayer().pipe(Layer.provideMerge(migratedStorageLayer)),
    fakeOrbMirrorLayer(),
  )
  const presenceLayer = PresenceHub.layer.pipe(Layer.provideMerge(timeLayer))
  const agentLayer = AgentLoop.layer.pipe(Layer.provideMerge(agentBase))
  const remoteLayer = RemoteControl.layer.pipe(
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(agentBase),
    Layer.provideMerge(presenceLayer),
  )
  const httpLayer = HttpServer.layer.pipe(
    Layer.provideMerge(remoteLayer),
    Layer.provideMerge(presenceLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  return Layer.mergeAll(agentBase, agentLayer, remoteLayer, httpLayer)
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

const fakeOrbManagerLayer = () =>
  Layer.effect(
    OrbManager.Service,
    Effect.map(OrbStore.Service, (orbs) =>
      OrbManager.Service.of({
        provisionForThread: (input) =>
          orbs.create({ thread_id: input.thread_id, project_id: input.project_id, base_commit: "abc123" }).pipe(
            Effect.flatMap((record) => orbs.setStatus(record.orb_id, "running")),
            Effect.mapError((error) => toOrbProvisionError("provision", undefined, error)),
          ),
        pause: (orbId) =>
          orbs.setStatus(orbId, "paused").pipe(Effect.mapError((error) => toOrbProvisionError("pause", orbId, error))),
        resume: (orbId) =>
          orbs
            .setStatus(orbId, "running")
            .pipe(Effect.mapError((error) => toOrbProvisionError("resume", orbId, error))),
        kill: (orbId) =>
          orbs.setStatus(orbId, "killed").pipe(Effect.mapError((error) => toOrbProvisionError("kill", orbId, error))),
        forceKill: (orbId) =>
          orbs
            .setStatus(orbId, "killed")
            .pipe(Effect.mapError((error) => toOrbProvisionError("forceKill", orbId, error))),
      }),
    ),
  )

const fakeOrbMirrorLayer = () =>
  Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: () => Effect.void,
      flush: () => Effect.void,
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )

const client = (baseUrl: string, userId?: Ids.UserId) =>
  Client.make(Client.fetchTransport({ base_url: baseUrl, ...(userId === undefined ? {} : { user_id: userId }) }))

const openWebModel = async (apiBaseUrl: string, selectedThreadId: Ids.ThreadId = threadId): Promise<Model> => {
  const [model, commands] = init({ api_base_url: apiBaseUrl, thread_id: selectedThreadId })
  return runCommands(model, commands)
}

const runCommands = async (initial: Model, initialCommands: ReadonlyArray<AppCommand>): Promise<Model> => {
  let model = initial
  const queue = [...initialCommands]
  while (queue.length > 0) {
    const command = queue.shift()
    if (command === undefined) continue
    if (command.name === "ShowDialog" || command.name === "CloseDialog") {
      const childMessage = command.name === "ShowDialog" ? CompletedShowDialog() : CompletedCloseDialog()
      const parentMessage =
        command.args?.id === "delete-secret-dialog"
          ? GotDeleteSecretDialogMessage({ message: childMessage })
          : GotKillOrbDialogMessage({ message: childMessage })
      const [next, commands] = update(model, parentMessage)
      model = next
      queue.push(...commands)
      continue
    }
    const message = await Effect.runPromise(command.effect.pipe(Effect.provide(webResourcesLayer)))
    const [next, commands] = update(model, message)
    model = next
    queue.push(...commands)
  }
  return model
}

const requireSelectedOrb = (model: Model) => {
  if (model.selected_orb === undefined) throw new Error("expected selected orb")
  return model.selected_orb
}

const toOrbProvisionError = (step: string, orbId: Ids.OrbId | undefined, error: unknown) =>
  new OrbManager.OrbProvisionError({
    message: error instanceof Error ? error.message : String(error),
    step,
    ...(orbId === undefined ? {} : { orb_id: orbId }),
  })

const collectTurn = (sdk: Client.Interface, afterSequence: number) => collectTurnForThread(sdk, threadId, afterSequence)

const collectTurnForThread = (sdk: Client.Interface, targetThreadId: Ids.ThreadId, afterSequence: number) =>
  Effect.runPromise(
    sdk.subscribeThreadEvents({ thread_id: targetThreadId, after_sequence: afterSequence }).pipe(
      Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    ),
  )

const collectWebMessages = (model: Model) => {
  return collectWebMessagesUntil(model, isTerminalTurnMessage)
}

const collectWebMessagesUntil = (model: Model, predicate: (message: AppMessage) => boolean) => {
  const threadEvents = subscriptions.threadEvents
  return Effect.runPromise(
    threadEvents
      .dependenciesToStream(threadEvents.modelToDependencies(model))
      .pipe(Stream.takeUntil(predicate), Stream.runCollect, Effect.timeout("5 seconds")),
  )
}

const isTurnStartedMessage = (message: AppMessage) =>
  message._tag === "ReceivedThreadEvent" && message.event.type === "turn.started"

const isTerminalTurnMessage = (message: AppMessage) =>
  message._tag === "ReceivedThreadEvent" &&
  (message.event.type === "turn.completed" || message.event.type === "turn.failed")

type WebEvent = Model["events"][number]

const isTurnStartedEvent = (event: WebEvent): event is Extract<WebEvent, { readonly type: "turn.started" }> =>
  event.type === "turn.started"

const isTurnFailedEvent = (event: WebEvent): event is Extract<WebEvent, { readonly type: "turn.failed" }> =>
  event.type === "turn.failed"

const slowProviderRegistryLayer = () =>
  Provider.registryLayerFromProviders([slowProvider("anthropic"), slowProvider("openai")])

const slowProvider = (name: Provider.ProviderName): Provider.Interface => {
  const response = {
    provider: name,
    model: "slow-model",
    content: "slow response",
    finish_reason: "stop" as const,
  }
  return {
    name,
    complete: () => Effect.succeed(response),
    completeStructured: () => Effect.die("slow provider structured completion is not used"),
    stream: () =>
      Stream.fromIterable<Provider.StreamEvent>([
        { type: "response.started", provider: name, model: "slow-model" },
      ]).pipe(Stream.concat(Stream.never)),
  }
}

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for condition")
}

const hasPresence = (
  snapshots: ReadonlyArray<Remote.PresenceFrame["presence"]>,
  userId: Ids.UserId,
  state: Remote.PresenceState,
) => snapshots.some((snapshot) => snapshot.users.some((user) => user.user_id === userId && user.state === state))

const lastSnapshot = (snapshots: ReadonlyArray<Remote.PresenceFrame["presence"]>) => snapshots.at(-1)
