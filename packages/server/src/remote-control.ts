import { AgentLoop, CompactionService, ThreadService, WorkspaceAccess, WorkspaceIdentity } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { OrbManager } from "@rika/orb"
import { ArtifactStore, Database, OrbStore, ProjectStore, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Artifact, Common, Event, Ide, Ids, Orb, Remote } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import * as OrbMirror from "./orb-mirror"
import * as PresenceHub from "./presence-hub"
import * as ThreadLive from "./thread-live"
import * as TurnInterruption from "./turn-interruption"

export class RemoteControlError extends Schema.TaggedErrorClass<RemoteControlError>()("RemoteControlError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
  active_user_id: Schema.optional(Ids.UserId),
}) {}

export type RunError =
  | RemoteControlError
  | AgentLoop.RunError
  | CompactionService.RunError
  | ThreadService.Error
  | ArtifactStore.ArtifactStoreError
  | Database.DatabaseError
  | OrbStore.OrbStoreError
  | OrbManager.OrbProvisionError
  | ProjectStore.ProjectStoreError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError
  | IdeBridge.IdeBridgeError
  | OrbMirror.RunError
  | WorkspaceAccess.RunError

export interface Interface {
  readonly backendHealth: (url: string) => Effect.Effect<Remote.BackendHealth, RunError>
  readonly createThread: (input: Remote.CreateThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly createOrbThread: (input: Remote.CreateOrbThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly listOrbs: () => Effect.Effect<ReadonlyArray<Remote.OrbSummary>, RunError>
  readonly getOrbByThread: (threadId: Ids.ThreadId) => Effect.Effect<Remote.OrbSummary, RunError>
  readonly pauseOrb: (orbId: Ids.OrbId) => Effect.Effect<Remote.OrbSummary, RunError>
  readonly resumeOrb: (orbId: Ids.OrbId) => Effect.Effect<Remote.OrbSummary, RunError>
  readonly killOrb: (orbId: Ids.OrbId) => Effect.Effect<Remote.OrbSummary, RunError>
  readonly listProjects: () => Effect.Effect<ReadonlyArray<Remote.ProjectSummary>, RunError>
  readonly createProject: (input: Remote.CreateProjectRequest) => Effect.Effect<Remote.ProjectDetail, RunError>
  readonly getProject: (projectId: Ids.ProjectId) => Effect.Effect<Remote.ProjectDetail, RunError>
  readonly updateProject: (
    projectId: Ids.ProjectId,
    input: Remote.UpdateProjectRequest,
  ) => Effect.Effect<Remote.ProjectDetail, RunError>
  readonly setProjectSecret: (
    projectId: Ids.ProjectId,
    name: string,
    input: Remote.SetProjectSecretRequest,
  ) => Effect.Effect<Remote.ProjectDetail, RunError>
  readonly deleteProjectSecret: (
    projectId: Ids.ProjectId,
    name: string,
  ) => Effect.Effect<Remote.ProjectDetail, RunError>
  readonly listThreads: (
    input?: Remote.ListThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSummary>, RunError>
  readonly openThread: (input: Remote.OpenThreadRequest) => Effect.Effect<Remote.ThreadRecord, RunError>
  readonly previewThread: (input: Remote.PreviewThreadRequest) => Effect.Effect<Remote.ThreadRecord, RunError>
  readonly archiveThread: (input: Remote.ArchiveThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly unarchiveThread: (input: Remote.ArchiveThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly compactThread: (input: Remote.CompactThreadRequest) => Effect.Effect<Event.ContextCompacted, RunError>
  readonly forkThread: (input: Remote.ForkThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly searchThreads: (
    input: Remote.SearchThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSearchResult>, RunError>
  readonly shareThread: (input: Remote.ShareThreadRequest) => Effect.Effect<Remote.ThreadExport, RunError>
  readonly referenceThread: (input: Remote.ReferenceThreadRequest) => Effect.Effect<Remote.ThreadReference, RunError>
  readonly subscribeThreadEvents: (input: Remote.SubscribeThreadEventsRequest) => Stream.Stream<Event.Event, RunError>
  readonly setThreadPresence: (input: Remote.SetThreadPresenceRequest) => Effect.Effect<Remote.PresenceFrame, RunError>
  readonly startTurn: (input: Remote.StartTurnRequest) => Effect.Effect<Remote.StartTurnResponse, RunError>
  readonly interruptTurn: (input: Remote.InterruptTurnRequest) => Effect.Effect<Event.TurnFailed, RunError>
  readonly listArtifacts: (
    input: Remote.ListArtifactsRequest,
  ) => Effect.Effect<ReadonlyArray<Artifact.Artifact>, RunError>
  readonly getArtifact: (input: Remote.GetArtifactRequest) => Effect.Effect<Artifact.Artifact, RunError>
  readonly connectIde: (input: Ide.ConnectRequest) => Effect.Effect<Ide.ConnectResponse, RunError>
  readonly disconnectIde: (input: Ide.DisconnectRequest) => Effect.Effect<Ide.Status, RunError>
  readonly updateIdeContext: (input: Ide.UpdateContextRequest) => Effect.Effect<Ide.Status, RunError>
  readonly ideStatus: () => Effect.Effect<Ide.Status, RunError>
  readonly openIdeFile: (input: Ide.OpenFileRequest) => Effect.Effect<Ide.OpenFileResult, RunError>
  readonly ideNavigationRequests: () => Effect.Effect<ReadonlyArray<Ide.OpenFileRequest>, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/server/RemoteControl") {}

export const layerWithLive = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop.Service
    const compaction = yield* CompactionService.Service
    const threads = yield* ThreadService.Service
    const artifacts = yield* ArtifactStore.Service
    const config = yield* Config.Service
    const idGenerator = yield* IdGenerator.Service
    const database = yield* Database.Service
    const eventLog = yield* ThreadEventLog.Service
    const projection = yield* ThreadProjection.Service
    const ideBridge = yield* IdeBridge.Service
    const workspaceAccess = yield* WorkspaceAccess.Service
    const live = yield* ThreadLive.Service
    const projects = yield* ProjectStore.Service
    const orbs = yield* OrbStore.Service
    const orbManager = yield* OrbManager.Service
    const orbMirror = yield* OrbMirror.Service
    const presence = yield* PresenceHub.Service
    const activeThreads = new Map<Ids.ThreadId, Ids.UserId | undefined>()
    const activeThreadsMutex = yield* Semaphore.make(1)
    const reserveThread = (threadId: Ids.ThreadId, userId?: Ids.UserId) =>
      activeThreadsMutex.withPermit(
        Effect.sync(() => {
          if (activeThreads.has(threadId)) {
            return { reserved: false as const, active_user_id: activeThreads.get(threadId) }
          }
          activeThreads.set(threadId, userId)
          return { reserved: true as const }
        }),
      )
    const releaseThread = (threadId: Ids.ThreadId) =>
      activeThreadsMutex.withPermit(
        Effect.sync(() => {
          activeThreads.delete(threadId)
        }),
      )
    const readLoggedEvents = (threadId: Ids.ThreadId, afterSequence: number) =>
      eventLog
        .readThread({ thread_id: threadId, after_sequence: afterSequence })
        .pipe(Effect.provideService(Database.Service, database))
    const latestLoggedSequence = (threadId: Ids.ThreadId) =>
      readLoggedEvents(threadId, 0).pipe(Effect.map((events) => events.at(-1)?.sequence ?? 0))
    const publishLoggedEvents = (threadId: Ids.ThreadId, afterSequence: number) =>
      readLoggedEvents(threadId, afterSequence).pipe(Effect.flatMap((events) => live.publishAll(events)))
    const resumePausedOrb = Effect.fn("RemoteControl.resumePausedOrb")(function* (threadId: Ids.ThreadId) {
      const orb = yield* orbs.getByThread(threadId)
      if (orb?.status !== "paused") return
      const resumed = yield* orbManager.resume(orb.orb_id)
      yield* orbMirror.mirror(resumed.orb_id)
    })
    const pauseRunningOrb = Effect.fn("RemoteControl.pauseRunningOrb")(function* (threadId: Ids.ThreadId) {
      const orb = yield* orbs.getByThread(threadId)
      if (orb?.status !== "running") return
      yield* orbManager.pause(orb.orb_id)
    })
    const reconcileInterruptedTurns = Effect.fn("RemoteControl.reconcileInterruptedTurns")(function* () {
      const events = yield* eventLog.readAll()
      const threadIds = [...new Set(events.map((event) => event.thread_id))]
      yield* Effect.forEach(
        threadIds,
        (threadId) =>
          TurnInterruption.appendIfLatestTurnOpen({
            thread_id: threadId,
            message: TurnInterruption.BackendRestartMessage,
            eventLog,
            projection,
            live,
          }),
        { discard: true },
      )
    })

    yield* reconcileInterruptedTurns().pipe(Effect.provideService(Database.Service, database))

    return Service.of({
      backendHealth: Effect.fn("RemoteControl.backendHealth")(function* (url: string) {
        const values = yield* config.get
        return {
          status: "healthy",
          url,
          workspace_root: values.workspace_root,
          data_dir: values.data_dir,
          backend_id: values.backend_id ?? "in-process",
          pid: process.pid,
          version: "0.0.0",
        }
      }),
      createThread: Effect.fn("RemoteControl.createThread")(function* (input: Remote.CreateThreadRequest) {
        const values = yield* config.get
        const workspaceId =
          input.workspace_id ??
          WorkspaceIdentity.resolveWorkspaceId({
            workspace_root: values.workspace_root,
            ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
          })
        const previousSequence = input.thread_id === undefined ? 0 : yield* latestLoggedSequence(input.thread_id)
        yield* workspaceAccess.ensureWorkspaceForCreate({
          workspace_id: workspaceId,
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
          action: "write",
        })
        const summary = yield* threads.create({
          ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
          workspace_id: workspaceId,
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
        })
        yield* publishLoggedEvents(summary.thread_id, previousSequence)
        return toRemoteSummary(summary)
      }),
      createOrbThread: Effect.fn("RemoteControl.createOrbThread")(function* (input: Remote.CreateOrbThreadRequest) {
        const values = yield* config.get
        const threadId = input.thread_id ?? Ids.ThreadId.make(yield* idGenerator.next("thread"))
        const orb = yield* orbManager.provisionForThread({
          thread_id: threadId,
          project_id: input.project_id,
          workspace_root: values.workspace_root,
        })
        return {
          thread_id: threadId,
          workspace_id: WorkspaceIdentity.resolveWorkspaceId({
            workspace_root: values.workspace_root,
            project_id: input.project_id,
          }),
          diff: { additions: 0, modifications: 0, deletions: 0 },
          orb_status: orb.status,
          archived: false,
          created_at: orb.created_at,
          updated_at: orb.last_active_at,
        }
      }),
      listOrbs: Effect.fn("RemoteControl.listOrbs")(function* () {
        const records = yield* orbs.list()
        return records.map(toOrbSummary)
      }),
      getOrbByThread: Effect.fn("RemoteControl.getOrbByThread")(function* (threadId: Ids.ThreadId) {
        const record = yield* orbs.getByThread(threadId)
        if (record === undefined) return yield* orbNotFound({ thread_id: threadId }, "getOrbByThread")
        return toOrbSummary(record)
      }),
      pauseOrb: Effect.fn("RemoteControl.pauseOrb")(function* (orbId: Ids.OrbId) {
        const record = yield* orbManager.pause(orbId)
        return toOrbSummary(record)
      }),
      resumeOrb: Effect.fn("RemoteControl.resumeOrb")(function* (orbId: Ids.OrbId) {
        const record = yield* orbManager.resume(orbId)
        return toOrbSummary(record)
      }),
      killOrb: Effect.fn("RemoteControl.killOrb")(function* (orbId: Ids.OrbId) {
        const record = yield* orbManager.kill(orbId)
        return toOrbSummary(record)
      }),
      listProjects: Effect.fn("RemoteControl.listProjects")(function* () {
        const records = yield* projects.list()
        return records.map(toProjectSummary)
      }),
      createProject: Effect.fn("RemoteControl.createProject")(function* (input: Remote.CreateProjectRequest) {
        const project = yield* projects.create({
          name: input.name,
          repo_origin: publicRepoOrigin(input.repo_origin),
          ...(input.default_branch === undefined ? {} : { default_branch: input.default_branch }),
          ...(input.template_id === undefined ? {} : { template_id: input.template_id }),
          ...(input.env === undefined ? {} : { env: input.env }),
        })
        return toProjectDetail(project)
      }),
      getProject: Effect.fn("RemoteControl.getProject")(function* (projectId: Ids.ProjectId) {
        const project = yield* projects.get(projectId)
        if (project === undefined) return yield* projectNotFound(projectId, "getProject")
        return toProjectDetail(project)
      }),
      updateProject: Effect.fn("RemoteControl.updateProject")(function* (
        projectId: Ids.ProjectId,
        input: Remote.UpdateProjectRequest,
      ) {
        const project = yield* projects.update(projectId, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.repo_origin === undefined ? {} : { repo_origin: publicRepoOrigin(input.repo_origin) }),
          ...(input.default_branch === undefined ? {} : { default_branch: input.default_branch }),
          ...(input.template_id === undefined ? {} : { template_id: input.template_id }),
          ...(input.env === undefined ? {} : { env: input.env }),
        })
        return toProjectDetail(project)
      }),
      setProjectSecret: Effect.fn("RemoteControl.setProjectSecret")(function* (
        projectId: Ids.ProjectId,
        name: string,
        input: Remote.SetProjectSecretRequest,
      ) {
        const project = yield* projects.setSecret(projectId, name, input.value)
        return toProjectDetail(project)
      }),
      deleteProjectSecret: Effect.fn("RemoteControl.deleteProjectSecret")(function* (
        projectId: Ids.ProjectId,
        name: string,
      ) {
        const project = yield* projects.unsetSecret(projectId, name)
        return toProjectDetail(project)
      }),
      listThreads: Effect.fn("RemoteControl.listThreads")(function* (input: Remote.ListThreadsRequest = {}) {
        const summaries = yield* threads.list({
          ...(input.include_archived === undefined ? {} : { include_archived: input.include_archived }),
          ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        return yield* Effect.forEach(summaries, (summary) => withOrbStatus(orbs, summary))
      }),
      openThread: Effect.fn("RemoteControl.openThread")(function* (input: Remote.OpenThreadRequest) {
        const record = yield* threads.open({ thread_id: input.thread_id })
        return { summary: yield* withOrbStatus(orbs, record.summary), events: record.events }
      }),
      previewThread: Effect.fn("RemoteControl.previewThread")(function* (input: Remote.PreviewThreadRequest) {
        const record = yield* threads.preview({
          thread_id: input.thread_id,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        return { summary: yield* withOrbStatus(orbs, record.summary), events: record.events }
      }),
      archiveThread: Effect.fn("RemoteControl.archiveThread")(function* (input: Remote.ArchiveThreadRequest) {
        const previousSequence = yield* latestLoggedSequence(input.thread_id)
        const summary = yield* threads.archive({ thread_id: input.thread_id })
        yield* pauseRunningOrb(input.thread_id)
        yield* publishLoggedEvents(input.thread_id, previousSequence)
        return yield* withOrbStatus(orbs, summary)
      }),
      unarchiveThread: Effect.fn("RemoteControl.unarchiveThread")(function* (input: Remote.ArchiveThreadRequest) {
        const previousSequence = yield* latestLoggedSequence(input.thread_id)
        const summary = yield* threads.unarchive({ thread_id: input.thread_id })
        yield* publishLoggedEvents(input.thread_id, previousSequence)
        return yield* withOrbStatus(orbs, summary)
      }),
      compactThread: Effect.fn("RemoteControl.compactThread")(function* (input: Remote.CompactThreadRequest) {
        const previousSequence = yield* latestLoggedSequence(input.thread_id)
        const reserved = yield* reserveThread(input.thread_id, input.user_id)
        if (!reserved.reserved) {
          return yield* new RemoteControlError({
            message: `Thread ${input.thread_id} already has active work`,
            operation: "compactThread",
            status: 409,
            ...(reserved.active_user_id === undefined ? {} : { active_user_id: reserved.active_user_id }),
          })
        }
        return yield* Effect.gen(function* () {
          const result = yield* compaction.compact({ thread_id: input.thread_id, trigger: "manual" })
          yield* publishLoggedEvents(input.thread_id, previousSequence)
          return result.event
        }).pipe(Effect.ensuring(releaseThread(input.thread_id)))
      }),
      forkThread: Effect.fn("RemoteControl.forkThread")(function* (input: Remote.ForkThreadRequest) {
        const reserved = yield* reserveThread(input.thread_id, input.user_id)
        if (!reserved.reserved) {
          return yield* new RemoteControlError({
            message: `Thread ${input.thread_id} already has active work`,
            operation: "forkThread",
            status: 409,
            ...(reserved.active_user_id === undefined ? {} : { active_user_id: reserved.active_user_id }),
          })
        }
        return yield* Effect.gen(function* () {
          const summary = yield* threads.fork(input)
          yield* publishLoggedEvents(summary.thread_id, 0)
          return yield* withOrbStatus(orbs, summary)
        }).pipe(Effect.ensuring(releaseThread(input.thread_id)))
      }),
      searchThreads: Effect.fn("RemoteControl.searchThreads")(function* (input: Remote.SearchThreadsRequest) {
        const results = yield* threads.search({
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.include_archived === undefined ? {} : { include_archived: input.include_archived }),
          ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
          ...(input.after === undefined ? {} : { after: input.after }),
          ...(input.before === undefined ? {} : { before: input.before }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        return yield* Effect.forEach(results, (result) =>
          withOrbStatus(orbs, result.summary).pipe(Effect.map((summary) => ({ ...result, summary }))),
        )
      }),
      shareThread: Effect.fn("RemoteControl.shareThread")(function* (input: Remote.ShareThreadRequest) {
        const exported = yield* threads.share({ thread_id: input.thread_id })
        return { ...exported, summary: yield* withOrbStatus(orbs, exported.summary) }
      }),
      referenceThread: Effect.fn("RemoteControl.referenceThread")(function* (input: Remote.ReferenceThreadRequest) {
        return yield* threads.reference(input)
      }),
      subscribeThreadEvents: (input: Remote.SubscribeThreadEventsRequest) =>
        live.subscribe({
          thread_id: input.thread_id,
          ...(input.after_sequence === undefined ? {} : { after_sequence: input.after_sequence }),
        }),
      setThreadPresence: Effect.fn("RemoteControl.setThreadPresence")(function* (
        input: Remote.SetThreadPresenceRequest,
      ) {
        return yield* presence.heartbeat(input)
      }),
      startTurn: Effect.fn("RemoteControl.startTurn")(function* (input: Remote.StartTurnRequest) {
        const values = yield* config.get
        const currentIdeContext = yield* ideBridge.currentContext()
        const workspaceId =
          input.workspace_id ??
          WorkspaceIdentity.resolveWorkspaceId({
            workspace_root: values.workspace_root,
            ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
          })
        yield* resumePausedOrb(input.thread_id)
        const reserved = yield* reserveThread(input.thread_id, input.user_id)
        if (!reserved.reserved) {
          return yield* new RemoteControlError({
            message: `Thread ${input.thread_id} already has an active turn`,
            operation: "startTurn",
            status: 409,
            ...(reserved.active_user_id === undefined ? {} : { active_user_id: reserved.active_user_id }),
          })
        }
        const ideContext = input.ide_context ?? Option.getOrUndefined(currentIdeContext)
        yield* agentLoop
          .streamTurn({
            thread_id: input.thread_id,
            workspace_id: workspaceId,
            content: input.content,
            ...(input.content_parts === undefined ? {} : { content_parts: input.content_parts }),
            ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.fast_mode === undefined ? {} : { fast_mode: input.fast_mode }),
            ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
            ...(ideContext === undefined ? {} : { ide_context: ideContext }),
            ...(input.tool_access === undefined ? {} : { tool_access: input.tool_access }),
          })
          .pipe(
            Stream.runForEach((event) => live.publish(event)),
            Effect.catch(() => Effect.void),
            Effect.ensuring(releaseThread(input.thread_id)),
            Effect.forkDetach,
          )
        return { thread_id: input.thread_id, accepted: true }
      }),
      interruptTurn: Effect.fn("RemoteControl.interruptTurn")(function* (input: Remote.InterruptTurnRequest) {
        const failed = yield* agentLoop.cancelTurn(input)
        yield* live.publish(failed)
        return failed
      }),
      listArtifacts: Effect.fn("RemoteControl.listArtifacts")(function* (input: Remote.ListArtifactsRequest) {
        return yield* artifacts.list(input)
      }),
      getArtifact: Effect.fn("RemoteControl.getArtifact")(function* (input: Remote.GetArtifactRequest) {
        const artifact = yield* artifacts.get(input.artifact_id)
        if (Option.isSome(artifact)) {
          return artifact.value
        }
        return yield* new RemoteControlError({
          message: `Artifact ${input.artifact_id} was not found`,
          operation: "getArtifact",
          status: 404,
        })
      }),
      connectIde: Effect.fn("RemoteControl.connectIde")(function* (input: Ide.ConnectRequest) {
        return yield* ideBridge.connect(input)
      }),
      disconnectIde: Effect.fn("RemoteControl.disconnectIde")(function* (input: Ide.DisconnectRequest) {
        return yield* ideBridge.disconnect(input)
      }),
      updateIdeContext: Effect.fn("RemoteControl.updateIdeContext")(function* (input: Ide.UpdateContextRequest) {
        return yield* ideBridge.updateContext(input)
      }),
      ideStatus: Effect.fn("RemoteControl.ideStatus")(function* () {
        return yield* ideBridge.status()
      }),
      openIdeFile: Effect.fn("RemoteControl.openIdeFile")(function* (input: Ide.OpenFileRequest) {
        return yield* ideBridge.openFile(input)
      }),
      ideNavigationRequests: Effect.fn("RemoteControl.ideNavigationRequests")(function* () {
        return yield* ideBridge.navigationRequests()
      }),
    })
  }),
)

export const layer: Layer.Layer<
  Service,
  Database.DatabaseError | ThreadEventLog.ThreadEventLogError | ThreadProjection.ThreadProjectionError,
  | AgentLoop.Service
  | CompactionService.Service
  | ThreadService.Service
  | ArtifactStore.Service
  | Config.Service
  | IdGenerator.Service
  | Database.Service
  | ThreadEventLog.Service
  | ThreadProjection.Service
  | IdeBridge.Service
  | WorkspaceAccess.Service
  | ProjectStore.Service
  | OrbStore.Service
  | OrbManager.Service
  | OrbMirror.Service
  | Time.Service
> = layerWithLive.pipe(Layer.provideMerge(ThreadLive.layer), Layer.provideMerge(PresenceHub.layer))

export const createThread = Effect.fn("RemoteControl.createThread.call")(function* (input: Remote.CreateThreadRequest) {
  const service = yield* Service
  return yield* service.createThread(input)
})

export const createOrbThread = Effect.fn("RemoteControl.createOrbThread.call")(function* (
  input: Remote.CreateOrbThreadRequest,
) {
  const service = yield* Service
  return yield* service.createOrbThread(input)
})

export const listOrbs = Effect.fn("RemoteControl.listOrbs.call")(function* () {
  const service = yield* Service
  return yield* service.listOrbs()
})

export const getOrbByThread = Effect.fn("RemoteControl.getOrbByThread.call")(function* (threadId: Ids.ThreadId) {
  const service = yield* Service
  return yield* service.getOrbByThread(threadId)
})

export const pauseOrb = Effect.fn("RemoteControl.pauseOrb.call")(function* (orbId: Ids.OrbId) {
  const service = yield* Service
  return yield* service.pauseOrb(orbId)
})

export const resumeOrb = Effect.fn("RemoteControl.resumeOrb.call")(function* (orbId: Ids.OrbId) {
  const service = yield* Service
  return yield* service.resumeOrb(orbId)
})

export const killOrb = Effect.fn("RemoteControl.killOrb.call")(function* (orbId: Ids.OrbId) {
  const service = yield* Service
  return yield* service.killOrb(orbId)
})

export const listProjects = Effect.fn("RemoteControl.listProjects.call")(function* () {
  const service = yield* Service
  return yield* service.listProjects()
})

export const createProject = Effect.fn("RemoteControl.createProject.call")(function* (
  input: Remote.CreateProjectRequest,
) {
  const service = yield* Service
  return yield* service.createProject(input)
})

export const getProject = Effect.fn("RemoteControl.getProject.call")(function* (projectId: Ids.ProjectId) {
  const service = yield* Service
  return yield* service.getProject(projectId)
})

export const updateProject = Effect.fn("RemoteControl.updateProject.call")(function* (
  projectId: Ids.ProjectId,
  input: Remote.UpdateProjectRequest,
) {
  const service = yield* Service
  return yield* service.updateProject(projectId, input)
})

export const setProjectSecret = Effect.fn("RemoteControl.setProjectSecret.call")(function* (
  projectId: Ids.ProjectId,
  name: string,
  input: Remote.SetProjectSecretRequest,
) {
  const service = yield* Service
  return yield* service.setProjectSecret(projectId, name, input)
})

export const deleteProjectSecret = Effect.fn("RemoteControl.deleteProjectSecret.call")(function* (
  projectId: Ids.ProjectId,
  name: string,
) {
  const service = yield* Service
  return yield* service.deleteProjectSecret(projectId, name)
})

export const backendHealth = Effect.fn("RemoteControl.backendHealth.call")(function* (url: string) {
  const service = yield* Service
  return yield* service.backendHealth(url)
})

export const listThreads = Effect.fn("RemoteControl.listThreads.call")(function* (
  input: Remote.ListThreadsRequest = {},
) {
  const service = yield* Service
  return yield* service.listThreads(input)
})

export const openThread = Effect.fn("RemoteControl.openThread.call")(function* (input: Remote.OpenThreadRequest) {
  const service = yield* Service
  return yield* service.openThread(input)
})

export const previewThread = Effect.fn("RemoteControl.previewThread.call")(function* (
  input: Remote.PreviewThreadRequest,
) {
  const service = yield* Service
  return yield* service.previewThread(input)
})

export const archiveThread = Effect.fn("RemoteControl.archiveThread.call")(function* (
  input: Remote.ArchiveThreadRequest,
) {
  const service = yield* Service
  return yield* service.archiveThread(input)
})

export const unarchiveThread = Effect.fn("RemoteControl.unarchiveThread.call")(function* (
  input: Remote.ArchiveThreadRequest,
) {
  const service = yield* Service
  return yield* service.unarchiveThread(input)
})

export const compactThread = Effect.fn("RemoteControl.compactThread.call")(function* (
  input: Remote.CompactThreadRequest,
) {
  const service = yield* Service
  return yield* service.compactThread(input)
})

export const forkThread = Effect.fn("RemoteControl.forkThread.call")(function* (input: Remote.ForkThreadRequest) {
  const service = yield* Service
  return yield* service.forkThread(input)
})

export const searchThreads = Effect.fn("RemoteControl.searchThreads.call")(function* (
  input: Remote.SearchThreadsRequest,
) {
  const service = yield* Service
  return yield* service.searchThreads(input)
})

export const shareThread = Effect.fn("RemoteControl.shareThread.call")(function* (input: Remote.ShareThreadRequest) {
  const service = yield* Service
  return yield* service.shareThread(input)
})

export const referenceThread = Effect.fn("RemoteControl.referenceThread.call")(function* (
  input: Remote.ReferenceThreadRequest,
) {
  const service = yield* Service
  return yield* service.referenceThread(input)
})

export const subscribeThreadEvents = (input: Remote.SubscribeThreadEventsRequest) =>
  Stream.unwrap(Effect.map(Service, (service) => service.subscribeThreadEvents(input)))

export const setThreadPresence = Effect.fn("RemoteControl.setThreadPresence.call")(function* (
  input: Remote.SetThreadPresenceRequest,
) {
  const service = yield* Service
  return yield* service.setThreadPresence(input)
})

export const startTurn = Effect.fn("RemoteControl.startTurn.call")(function* (input: Remote.StartTurnRequest) {
  const service = yield* Service
  return yield* service.startTurn(input)
})

export const interruptTurn = Effect.fn("RemoteControl.interruptTurn.call")(function* (
  input: Remote.InterruptTurnRequest,
) {
  const service = yield* Service
  return yield* service.interruptTurn(input)
})

export const listArtifacts = Effect.fn("RemoteControl.listArtifacts.call")(function* (
  input: Remote.ListArtifactsRequest,
) {
  const service = yield* Service
  return yield* service.listArtifacts(input)
})

export const getArtifact = Effect.fn("RemoteControl.getArtifact.call")(function* (input: Remote.GetArtifactRequest) {
  const service = yield* Service
  return yield* service.getArtifact(input)
})

export const connectIde = Effect.fn("RemoteControl.connectIde.call")(function* (input: Ide.ConnectRequest) {
  const service = yield* Service
  return yield* service.connectIde(input)
})

export const disconnectIde = Effect.fn("RemoteControl.disconnectIde.call")(function* (input: Ide.DisconnectRequest) {
  const service = yield* Service
  return yield* service.disconnectIde(input)
})

export const updateIdeContext = Effect.fn("RemoteControl.updateIdeContext.call")(function* (
  input: Ide.UpdateContextRequest,
) {
  const service = yield* Service
  return yield* service.updateIdeContext(input)
})

export const ideStatus = Effect.fn("RemoteControl.ideStatus.call")(function* () {
  const service = yield* Service
  return yield* service.ideStatus()
})

export const openIdeFile = Effect.fn("RemoteControl.openIdeFile.call")(function* (input: Ide.OpenFileRequest) {
  const service = yield* Service
  return yield* service.openIdeFile(input)
})

export const ideNavigationRequests = Effect.fn("RemoteControl.ideNavigationRequests.call")(function* () {
  const service = yield* Service
  return yield* service.ideNavigationRequests()
})

export const errorToApi = (error: RunError): Remote.ApiError => ({
  error: {
    message: error instanceof Error ? error.message : String(error),
    code:
      error instanceof RemoteControlError
        ? error.operation
        : error instanceof WorkspaceAccess.WorkspaceAccessDenied
          ? "workspace_access_denied"
          : error instanceof Error
            ? error.name
            : "unknown",
    ...(error instanceof RemoteControlError ||
    error instanceof IdeBridge.IdeBridgeError ||
    error instanceof ThreadService.ThreadForkError ||
    error instanceof WorkspaceAccess.WorkspaceAccessDenied ||
    error instanceof WorkspaceAccess.WorkspaceAccessError
      ? {
          details: {
            status: statusFromError(error),
            ...(error instanceof RemoteControlError && error.active_user_id !== undefined
              ? { active_user_id: error.active_user_id }
              : {}),
          },
        }
      : {}),
  },
})

export const statusFromError = (error: RunError) => {
  if (error instanceof RemoteControlError || error instanceof IdeBridge.IdeBridgeError) return error.status
  if (error instanceof CompactionService.CompactionError) return statusFromCompactionError(error)
  if (error instanceof ThreadService.ThreadForkError) return error.reason === "turn_open" ? 409 : 404
  if (error instanceof OrbStore.OrbStoreError) return statusFromOrbStoreError(error)
  if (error instanceof OrbManager.OrbProvisionError) return statusFromOrbProvisionError(error)
  if (error instanceof ProjectStore.ProjectStoreError) return statusFromProjectStoreError(error)
  if (error instanceof WorkspaceAccess.WorkspaceAccessDenied) return 403
  if (error instanceof WorkspaceAccess.WorkspaceAccessError) return 404
  return 500
}

const toRemoteSummary = (summary: ThreadService.ThreadRecord["summary"]): Remote.ThreadSummary => ({
  thread_id: summary.thread_id,
  workspace_id: summary.workspace_id,
  ...(summary.user_id === undefined ? {} : { user_id: summary.user_id }),
  ...(summary.last_user_id === undefined ? {} : { last_user_id: summary.last_user_id }),
  ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
  ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
  diff: summary.diff,
  ...(summary.active_turn_id === undefined ? {} : { active_turn_id: summary.active_turn_id }),
  ...(summary.active_turn_status === undefined ? {} : { active_turn_status: summary.active_turn_status }),
  ...(summary.context_tokens === undefined ? {} : { context_tokens: summary.context_tokens }),
  ...(summary.context_window === undefined ? {} : { context_window: summary.context_window }),
  archived: summary.archived,
  created_at: Common.TimestampMillis.make(summary.created_at),
  updated_at: Common.TimestampMillis.make(summary.updated_at),
})

const withOrbStatus = Effect.fn("RemoteControl.withOrbStatus")(function* (
  orbs: OrbStore.Interface,
  summary: ThreadService.ThreadRecord["summary"],
) {
  const remote = toRemoteSummary(summary)
  const orb = yield* orbs.getByThread(summary.thread_id)
  return orb === undefined ? remote : { ...remote, orb_status: orb.status }
})

const toOrbSummary = (orb: Orb.OrbRecord): Remote.OrbSummary => ({
  orb_id: orb.orb_id,
  thread_id: orb.thread_id,
  project_id: orb.project_id,
  status: orb.status,
  base_commit: orb.base_commit,
  created_at: orb.created_at,
  last_active_at: orb.last_active_at,
})

const toProjectSummary = (project: Orb.ProjectRecord): Remote.ProjectSummary => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: publicRepoOrigin(project.repo_origin),
  default_branch: project.default_branch,
  template_id: project.template_id,
  env_keys: Object.keys(project.env).toSorted(),
  secret_names: project.secret_names,
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const toProjectDetail = (project: Orb.ProjectRecord): Remote.ProjectDetail => ({
  project_id: project.project_id,
  name: project.name,
  repo_origin: publicRepoOrigin(project.repo_origin),
  default_branch: project.default_branch,
  template_id: project.template_id,
  env: project.env,
  secret_names: project.secret_names,
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const publicRepoOrigin = (repoOrigin: string): string => {
  try {
    const url = new URL(repoOrigin)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return repoOrigin
  }
}

const statusFromOrbStoreError = (error: OrbStore.OrbStoreError) =>
  error.reason === "not_found" ? 404 : error.reason === "invalid_transition" ? 409 : 500

const statusFromProjectStoreError = (error: ProjectStore.ProjectStoreError) =>
  error.message.toLowerCase().includes("not found") ? 404 : 500

const statusFromCompactionError = (error: CompactionService.CompactionError) =>
  error.message.includes("does not exist") ? 404 : 500

const statusFromOrbProvisionError = (error: OrbManager.OrbProvisionError) => {
  const message = error.message.toLowerCase()
  if (message.includes("not found")) return 404
  if (message.includes("cannot resume from") || message.includes("invalid orb status transition")) return 409
  return 500
}

const orbNotFound = (input: { readonly orb_id?: Ids.OrbId; readonly thread_id?: Ids.ThreadId }, operation: string) =>
  new RemoteControlError({
    message:
      input.orb_id === undefined
        ? `Orb for thread ${input.thread_id} was not found`
        : `Orb ${input.orb_id} was not found`,
    operation,
    status: 404,
  })

const projectNotFound = (projectId: Ids.ProjectId, operation: string) =>
  new RemoteControlError({
    message: `Project ${projectId} was not found`,
    operation,
    status: 404,
  })
