import { AgentLoop, ThreadService, WorkspaceAccess } from "@rika/agent"
import { Config } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { ArtifactStore, Database, ThreadEventLog } from "@rika/persistence"
import { Artifact, Common, Event, Ide, Ids, Remote } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"

export class RemoteControlError extends Schema.TaggedErrorClass<RemoteControlError>()("RemoteControlError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
}) {}

export type RunError =
  | RemoteControlError
  | AgentLoop.RunError
  | ThreadService.Error
  | ArtifactStore.ArtifactStoreError
  | Database.DatabaseError
  | ThreadEventLog.ThreadEventLogError
  | IdeBridge.IdeBridgeError
  | WorkspaceAccess.RunError

export interface Interface {
  readonly backendHealth: (url: string) => Effect.Effect<Remote.BackendHealth, RunError>
  readonly createThread: (input: Remote.CreateThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly listThreads: (
    input?: Remote.ListThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSummary>, RunError>
  readonly openThread: (input: Remote.OpenThreadRequest) => Effect.Effect<Remote.ThreadRecord, RunError>
  readonly previewThread: (input: Remote.PreviewThreadRequest) => Effect.Effect<Remote.ThreadRecord, RunError>
  readonly archiveThread: (input: Remote.ArchiveThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly unarchiveThread: (input: Remote.ArchiveThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly searchThreads: (
    input: Remote.SearchThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSearchResult>, RunError>
  readonly shareThread: (input: Remote.ShareThreadRequest) => Effect.Effect<Remote.ThreadExport, RunError>
  readonly referenceThread: (input: Remote.ReferenceThreadRequest) => Effect.Effect<Remote.ThreadReference, RunError>
  readonly subscribeThreadEvents: (input: Remote.SubscribeThreadEventsRequest) => Stream.Stream<Event.Event, RunError>
  readonly startTurn: (input: Remote.StartTurnRequest) => Stream.Stream<Event.Event, RunError>
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop.Service
    const threads = yield* ThreadService.Service
    const artifacts = yield* ArtifactStore.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    const eventLog = yield* ThreadEventLog.Service
    const ideBridge = yield* IdeBridge.Service
    const workspaceAccess = yield* WorkspaceAccess.Service

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
        const workspaceId = input.workspace_id ?? Ids.WorkspaceId.make(values.workspace_root)
        yield* workspaceAccess.ensureWorkspaceForCreate({
          workspace_id: workspaceId,
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
          action: "write",
        })
        const summary = yield* threads.create({
          ...input,
          workspace_id: workspaceId,
        })
        return toRemoteSummary(summary)
      }),
      listThreads: Effect.fn("RemoteControl.listThreads")(function* (input: Remote.ListThreadsRequest = {}) {
        if (input.workspace_id !== undefined && input.user_id !== undefined) {
          yield* workspaceAccess.requireWorkspace({
            workspace_id: input.workspace_id,
            user_id: input.user_id,
            action: "read",
          })
        }
        const summaries = yield* threads.list(input)
        const readable = yield* workspaceAccess.filterReadableThreads(summaries, input.user_id)
        return readable.map(toRemoteSummary)
      }),
      openThread: Effect.fn("RemoteControl.openThread")(function* (input: Remote.OpenThreadRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "read" })
        }
        const record = yield* threads.open({ thread_id: input.thread_id })
        return { summary: toRemoteSummary(record.summary), events: record.events }
      }),
      previewThread: Effect.fn("RemoteControl.previewThread")(function* (input: Remote.PreviewThreadRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "read" })
        }
        const record = yield* threads.preview({
          thread_id: input.thread_id,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        return { summary: toRemoteSummary(record.summary), events: record.events }
      }),
      archiveThread: Effect.fn("RemoteControl.archiveThread")(function* (input: Remote.ArchiveThreadRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "write" })
        }
        return toRemoteSummary(yield* threads.archive({ thread_id: input.thread_id }))
      }),
      unarchiveThread: Effect.fn("RemoteControl.unarchiveThread")(function* (input: Remote.ArchiveThreadRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "write" })
        }
        return toRemoteSummary(yield* threads.unarchive({ thread_id: input.thread_id }))
      }),
      searchThreads: Effect.fn("RemoteControl.searchThreads")(function* (input: Remote.SearchThreadsRequest) {
        if (input.workspace_id !== undefined && input.user_id !== undefined) {
          yield* workspaceAccess.requireWorkspace({
            workspace_id: input.workspace_id,
            user_id: input.user_id,
            action: "read",
          })
        }
        const results = yield* threads.search(input)
        const summaries = results.map((result) => result.summary)
        const readable = yield* workspaceAccess.filterReadableThreads(summaries, input.user_id)
        const readableIds = new Set(readable.map((summary) => summary.thread_id))
        return results
          .filter((result) => readableIds.has(result.summary.thread_id))
          .map((result) => ({ ...result, summary: toRemoteSummary(result.summary) }))
      }),
      shareThread: Effect.fn("RemoteControl.shareThread")(function* (input: Remote.ShareThreadRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "read" })
        }
        const exported = yield* threads.share({ thread_id: input.thread_id })
        return { ...exported, summary: toRemoteSummary(exported.summary) }
      }),
      referenceThread: Effect.fn("RemoteControl.referenceThread")(function* (input: Remote.ReferenceThreadRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "read" })
        }
        return yield* threads.reference(input)
      }),
      subscribeThreadEvents: (input: Remote.SubscribeThreadEventsRequest) =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (input.user_id !== undefined) {
              yield* workspaceAccess.requireThread({
                thread_id: input.thread_id,
                user_id: input.user_id,
                action: "read",
              })
            }
            const events = yield* eventLog
              .readThread({
                thread_id: input.thread_id,
                ...(input.after_sequence === undefined ? {} : { after_sequence: input.after_sequence }),
              })
              .pipe(Effect.provideService(Database.Service, database))
            return Stream.fromIterable(events)
          }),
        ),
      startTurn: (input: Remote.StartTurnRequest) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const values = yield* config.get
            const currentIdeContext = yield* ideBridge.currentContext()
            const workspaceId = input.workspace_id ?? Ids.WorkspaceId.make(values.workspace_root)
            if (input.user_id !== undefined) {
              yield* workspaceAccess
                .requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "write" })
                .pipe(
                  Effect.catchTag("WorkspaceAccessError", () =>
                    workspaceAccess.ensureWorkspaceForCreate({
                      workspace_id: workspaceId,
                      user_id: input.user_id,
                      action: "write",
                    }),
                  ),
                )
            }
            const ideContext = input.ide_context ?? Option.getOrUndefined(currentIdeContext)
            return agentLoop.streamTurn({
              thread_id: input.thread_id,
              workspace_id: workspaceId,
              content: input.content,
              ...(input.content_parts === undefined ? {} : { content_parts: input.content_parts }),
              ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
              ...(input.mode === undefined ? {} : { mode: input.mode }),
              ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
              ...(ideContext === undefined ? {} : { ide_context: ideContext }),
            })
          }),
        ),
      interruptTurn: Effect.fn("RemoteControl.interruptTurn")(function* (input: Remote.InterruptTurnRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "write" })
        }
        return yield* agentLoop.cancelTurn(input)
      }),
      listArtifacts: Effect.fn("RemoteControl.listArtifacts")(function* (input: Remote.ListArtifactsRequest) {
        if (input.user_id !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "read" })
        }
        return yield* artifacts.list(input)
      }),
      getArtifact: Effect.fn("RemoteControl.getArtifact")(function* (input: Remote.GetArtifactRequest) {
        const artifact = yield* artifacts.get(input.artifact_id)
        if (Option.isSome(artifact)) {
          if (input.user_id !== undefined) {
            yield* workspaceAccess.requireThread({
              thread_id: artifact.value.thread_id,
              user_id: input.user_id,
              action: "read",
            })
          }
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

export const createThread = Effect.fn("RemoteControl.createThread.call")(function* (input: Remote.CreateThreadRequest) {
  const service = yield* Service
  return yield* service.createThread(input)
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

export const startTurn = (input: Remote.StartTurnRequest) =>
  Stream.unwrap(Effect.map(Service, (service) => service.startTurn(input)))

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
    error instanceof WorkspaceAccess.WorkspaceAccessDenied ||
    error instanceof WorkspaceAccess.WorkspaceAccessError
      ? { details: { status: statusFromError(error) } }
      : {}),
  },
})

export const statusFromError = (error: RunError) =>
  error instanceof RemoteControlError || error instanceof IdeBridge.IdeBridgeError
    ? error.status
    : error instanceof WorkspaceAccess.WorkspaceAccessDenied
      ? 403
      : error instanceof WorkspaceAccess.WorkspaceAccessError
        ? 404
        : 500

const toRemoteSummary = (summary: ThreadService.ThreadRecord["summary"]): Remote.ThreadSummary => ({
  thread_id: summary.thread_id,
  workspace_id: summary.workspace_id,
  ...(summary.user_id === undefined ? {} : { user_id: summary.user_id }),
  ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
  ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
  diff: summary.diff,
  ...(summary.active_turn_id === undefined ? {} : { active_turn_id: summary.active_turn_id }),
  ...(summary.active_turn_status === undefined ? {} : { active_turn_status: summary.active_turn_status }),
  archived: summary.archived,
  created_at: Common.TimestampMillis.make(summary.created_at),
  updated_at: Common.TimestampMillis.make(summary.updated_at),
})
