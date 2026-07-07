import { AgentLoop, WorkspaceAccess } from "@rika/agent"
import { IdGenerator, Time } from "@rika/core"
import { Database, ThreadEventLog, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Event, Ids } from "@rika/schema"
import { Registry, State } from "@rivetkit/effect"
import { Effect, Layer } from "effect"
import {
  AcceptTurnPayload,
  EnsureThreadPayload,
  ThreadActor,
  ThreadActorActionError,
  ThreadActorError,
  ThreadActorSnapshot,
  ThreadActorState,
  ThreadIdPayload,
  VerifiedUserIdentity,
  emptyState,
  snapshotFromState,
  stateFromEvents,
} from "./thread-actor"

const identityUserId = (identity: VerifiedUserIdentity | undefined) => identity?.user_id

export const layer: Layer.Layer<
  never,
  never,
  | AgentLoop.Service
  | Database.Service
  | IdGenerator.Service
  | Registry.Registry
  | ThreadEventLog.Service
  | Time.Service
  | WorkspaceAccess.Service
> = ThreadActor.toLayer(
  Effect.fnUntraced(function* ({ state }) {
    const eventLog = yield* ThreadEventLog.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const agentLoop = yield* AgentLoop.Service
    const workspaceAccess = yield* WorkspaceAccess.Service

    const requireRead = (input: ThreadIdPayload) =>
      Effect.gen(function* () {
        const userId = identityUserId(input.identity)
        if (userId !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: userId, action: "read" })
        }
      })

    const replay = (input: ThreadIdPayload) =>
      Effect.gen(function* () {
        yield* requireRead(input)
        const events = yield* eventLog.readThread({ thread_id: input.thread_id })
        const next = stateFromEvents(input.thread_id, events)
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const appendAndProject = (event: Event.Event) =>
      Effect.gen(function* () {
        return yield* eventLog.appendAndProject(event)
      })

    const ensureThread = (input: EnsureThreadPayload) =>
      Effect.gen(function* () {
        const userId = identityUserId(input.identity)
        if (userId !== undefined) {
          yield* workspaceAccess.ensureWorkspaceForCreate({
            workspace_id: input.workspace_id,
            user_id: userId,
            action: "write",
          })
        }
        const currentEvents = yield* eventLog.readThread({ thread_id: input.thread_id })
        if (currentEvents.length > 0) {
          return yield* replay({
            thread_id: input.thread_id,
            ...(input.identity === undefined ? {} : { identity: input.identity }),
          })
        }

        const event = yield* makeThreadCreated(input, idGenerator, time)
        const appended = yield* appendAndProject(event)
        const next = stateFromEvents(input.thread_id, [appended])
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const acceptTurn = (input: AcceptTurnPayload) =>
      Effect.gen(function* () {
        const userId = identityUserId(input.identity)
        if (userId !== undefined) {
          yield* workspaceAccess.requireThread({ thread_id: input.thread_id, user_id: userId, action: "write" }).pipe(
            Effect.catchTag("WorkspaceAccessError", () =>
              workspaceAccess.ensureWorkspaceForCreate({
                workspace_id: input.workspace_id,
                user_id: userId,
                action: "write",
              }),
            ),
          )
        }
        yield* agentLoop.runTurn({
          thread_id: input.thread_id,
          workspace_id: input.workspace_id,
          ...(userId === undefined ? {} : { user_id: userId }),
          content: input.content,
          ...(input.content_parts === undefined ? {} : { content_parts: input.content_parts }),
        })
        const events = yield* eventLog.readThread({ thread_id: input.thread_id })
        const next = stateFromEvents(input.thread_id, events)
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    return ThreadActor.of({
      EnsureThread: ({ payload }) =>
        ensureThread(payload).pipe(Effect.mapError((cause) => toActionError(cause, "EnsureThread", payload.thread_id))),
      AcceptTurn: ({ payload }) =>
        acceptTurn(payload).pipe(Effect.mapError((cause) => toActionError(cause, "AcceptTurn", payload.thread_id))),
      ReplayThread: ({ payload }) =>
        replay(payload).pipe(Effect.mapError((cause) => toActionError(cause, "ReplayThread", payload.thread_id))),
      GetSnapshot: ({ payload }) =>
        replay(payload).pipe(Effect.mapError((cause) => toActionError(cause, "GetSnapshot", payload.thread_id))),
    })
  }),
  {
    state: {
      schema: ThreadActorState,
      initialValue: emptyState,
    },
    name: "Rika Thread Actor",
    icon: "comments",
  },
)

const makeThreadCreated = (
  input: EnsureThreadPayload,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.ThreadCreated> =>
  Effect.gen(function* () {
    const userId = input.identity?.user_id
    const createdAt = yield* time.nowMillis
    const eventId = Ids.EventId.make(yield* idGenerator.next("event"))
    const event: Event.ThreadCreated = {
      id: eventId,
      thread_id: input.thread_id,
      sequence: 1,
      version: 1,
      created_at: createdAt,
      type: "thread.created",
      data:
        userId === undefined
          ? { workspace_id: input.workspace_id }
          : { workspace_id: input.workspace_id, user_id: userId },
    }
    return event
  })

const toActionError = (cause: unknown, operation: string, threadId: Ids.ThreadId): ThreadActorError => {
  if (cause instanceof ThreadActorActionError) return cause
  if (cause instanceof WorkspaceAccess.WorkspaceAccessError) return cause
  if (cause instanceof WorkspaceAccess.WorkspaceAccessDenied) return cause
  if (cause instanceof ThreadEventLog.ThreadEventLogError) return cause
  if (cause instanceof AgentLoop.AgentLoopError) return cause
  if (cause instanceof Database.DatabaseError) return cause
  if (cause instanceof ThreadProjection.ThreadProjectionError) return cause
  if (cause instanceof WorkspaceStore.WorkspaceStoreError) return cause
  return new ThreadActorActionError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    thread_id: threadId,
  })
}

export const replaySnapshot: (
  threadId: Ids.ThreadId,
  identity?: VerifiedUserIdentity,
) => Effect.Effect<
  ThreadActorSnapshot,
  Database.DatabaseError | ThreadEventLog.ThreadEventLogError | WorkspaceAccess.RunError,
  Database.Service | ThreadEventLog.Service | WorkspaceAccess.Service
> = Effect.fn("ThreadActor.replaySnapshot")(function* (threadId: Ids.ThreadId, identity?: VerifiedUserIdentity) {
  if (identity !== undefined) {
    const workspaceAccess = yield* WorkspaceAccess.Service
    yield* workspaceAccess.requireThread({ thread_id: threadId, user_id: identity.user_id, action: "read" })
  }
  const eventLog = yield* ThreadEventLog.Service
  const events = yield* eventLog.readThread({ thread_id: threadId })
  return snapshotFromState(stateFromEvents(threadId, events), threadId)
})
