import { AgentLoop, ThreadService } from "@rika/agent"
import { Config } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { ArtifactStore, Database } from "@rika/persistence"
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
  | IdeBridge.IdeBridgeError

export interface Interface {
  readonly createThread: (input: Remote.CreateThreadRequest) => Effect.Effect<Remote.ThreadSummary, RunError>
  readonly listThreads: (
    input?: Remote.ListThreadsRequest,
  ) => Effect.Effect<ReadonlyArray<Remote.ThreadSummary>, RunError>
  readonly openThread: (threadId: Ids.ThreadId) => Effect.Effect<Remote.ThreadRecord, RunError>
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
    const ideBridge = yield* IdeBridge.Service

    return Service.of({
      createThread: Effect.fn("RemoteControl.createThread")(function* (input: Remote.CreateThreadRequest) {
        const summary = yield* threads.create(input)
        return toRemoteSummary(summary)
      }),
      listThreads: Effect.fn("RemoteControl.listThreads")(function* (input: Remote.ListThreadsRequest = {}) {
        const summaries = yield* threads.list(input)
        return summaries.map(toRemoteSummary)
      }),
      openThread: Effect.fn("RemoteControl.openThread")(function* (threadId: Ids.ThreadId) {
        const record = yield* threads.open({ thread_id: threadId })
        return { summary: toRemoteSummary(record.summary), events: record.events }
      }),
      startTurn: (input: Remote.StartTurnRequest) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const values = yield* config.get
            const currentIdeContext = yield* ideBridge.currentContext()
            const workspaceId = input.workspace_id ?? Ids.WorkspaceId.make(values.workspace_root)
            const ideContext = input.ide_context ?? Option.getOrUndefined(currentIdeContext)
            return agentLoop.streamTurn({
              thread_id: input.thread_id,
              workspace_id: workspaceId,
              content: input.content,
              ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
              ...(input.mode === undefined ? {} : { mode: input.mode }),
              ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
              ...(ideContext === undefined ? {} : { ide_context: ideContext }),
            })
          }),
        ),
      interruptTurn: Effect.fn("RemoteControl.interruptTurn")(function* (input: Remote.InterruptTurnRequest) {
        return yield* agentLoop.cancelTurn(input)
      }),
      listArtifacts: Effect.fn("RemoteControl.listArtifacts")(function* (input: Remote.ListArtifactsRequest) {
        return yield* artifacts.list(input)
      }),
      getArtifact: Effect.fn("RemoteControl.getArtifact")(function* (input: Remote.GetArtifactRequest) {
        const artifact = yield* artifacts.get(input.artifact_id)
        if (Option.isSome(artifact)) return artifact.value
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

export const listThreads = Effect.fn("RemoteControl.listThreads.call")(function* (
  input: Remote.ListThreadsRequest = {},
) {
  const service = yield* Service
  return yield* service.listThreads(input)
})

export const openThread = Effect.fn("RemoteControl.openThread.call")(function* (threadId: Ids.ThreadId) {
  const service = yield* Service
  return yield* service.openThread(threadId)
})

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
    code: error instanceof RemoteControlError ? error.operation : error instanceof Error ? error.name : "unknown",
    ...(error instanceof RemoteControlError || error instanceof IdeBridge.IdeBridgeError
      ? { details: { status: error.status } }
      : {}),
  },
})

export const statusFromError = (error: RunError) =>
  error instanceof RemoteControlError || error instanceof IdeBridge.IdeBridgeError ? error.status : 500

const toRemoteSummary = (summary: ThreadService.ThreadRecord["summary"]): Remote.ThreadSummary => ({
  thread_id: summary.thread_id,
  workspace_id: summary.workspace_id,
  ...(summary.user_id === undefined ? {} : { user_id: summary.user_id }),
  ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
  ...(summary.active_turn_id === undefined ? {} : { active_turn_id: summary.active_turn_id }),
  ...(summary.active_turn_status === undefined ? {} : { active_turn_status: summary.active_turn_status }),
  archived: summary.archived,
  created_at: Common.TimestampMillis.make(summary.created_at),
  updated_at: Common.TimestampMillis.make(summary.updated_at),
})
