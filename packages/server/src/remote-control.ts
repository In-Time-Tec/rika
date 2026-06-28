import { AgentLoop, ThreadService } from "@rika/agent"
import { Config } from "@rika/core"
import { ArtifactStore, Database } from "@rika/persistence"
import { Artifact, Common, Event, Ids, Remote } from "@rika/schema"
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
}

export class Service extends Context.Service<Service, Interface>()("@rika/server/RemoteControl") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop.Service
    const threads = yield* ThreadService.Service
    const artifacts = yield* ArtifactStore.Service
    const config = yield* Config.Service

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
            const workspaceId = input.workspace_id ?? Ids.WorkspaceId.make(values.workspace_root)
            return agentLoop.streamTurn({
              thread_id: input.thread_id,
              workspace_id: workspaceId,
              content: input.content,
              ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
              ...(input.mode === undefined ? {} : { mode: input.mode }),
              ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
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

export const errorToApi = (error: RunError): Remote.ApiError => ({
  error: {
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof RemoteControlError ? error.operation : error instanceof Error ? error.name : "unknown",
    ...(error instanceof RemoteControlError ? { details: { status: error.status } } : {}),
  },
})

export const statusFromError = (error: RunError) => (error instanceof RemoteControlError ? error.status : 500)

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
