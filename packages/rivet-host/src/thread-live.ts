import { AgentLoop, WorkspaceAccess } from "@rika/agent"
import { IdGenerator, Time } from "@rika/core"
import { Database, ThreadEventLog } from "@rika/persistence"
import { Event, Ids } from "@rika/schema"
import { Registry, State } from "@rivetkit/effect"
import { Effect, Layer } from "effect"
import {
  AcceptTurnPayload,
  EnsureThreadPayload,
  ThreadActor,
  ThreadActorActionError,
  ThreadActorSnapshot,
  ThreadActorState,
  ThreadIdPayload,
  emptyState,
  snapshotFromState,
  stateFromEvents,
} from "./thread-actor"

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

    const replay = (input: ThreadIdPayload) =>
      Effect.gen(function* () {
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
        if (input.user_id !== undefined) {
          yield* workspaceAccess.ensureWorkspaceForCreate({
            workspace_id: input.workspace_id,
            user_id: input.user_id,
            action: "write",
          })
        }
        const currentEvents = yield* eventLog.readThread({ thread_id: input.thread_id })
        if (currentEvents.length > 0) {
          return yield* replay({ thread_id: input.thread_id })
        }

        const event = yield* makeThreadCreated(input, idGenerator, time)
        const appended = yield* appendAndProject(event)
        const next = stateFromEvents(input.thread_id, [appended])
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const acceptTurn = (input: AcceptTurnPayload) =>
      Effect.gen(function* () {
        if (input.user_id !== undefined) {
          yield* workspaceAccess
            .requireThread({ thread_id: input.thread_id, user_id: input.user_id, action: "write" })
            .pipe(
              Effect.catchTag("WorkspaceAccessError", () =>
                workspaceAccess.ensureWorkspaceForCreate({
                  workspace_id: input.workspace_id,
                  user_id: input.user_id,
                  action: "write",
                }),
              ),
            )
        }
        yield* agentLoop.runTurn(input)
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
        input.user_id === undefined
          ? { workspace_id: input.workspace_id }
          : { workspace_id: input.workspace_id, user_id: input.user_id },
    }
    return event
  })

const toActionError = (cause: unknown, operation: string, threadId: Ids.ThreadId) => {
  if (cause instanceof ThreadActorActionError) return cause
  return new ThreadActorActionError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    thread_id: threadId,
  })
}

export const replaySnapshot: (
  threadId: Ids.ThreadId,
) => Effect.Effect<
  ThreadActorSnapshot,
  Database.DatabaseError | ThreadEventLog.ThreadEventLogError,
  Database.Service | ThreadEventLog.Service
> = Effect.fn("ThreadActor.replaySnapshot")(function* (threadId: Ids.ThreadId) {
  const eventLog = yield* ThreadEventLog.Service
  const events = yield* eventLog.readThread({ thread_id: threadId })
  return snapshotFromState(stateFromEvents(threadId, events), threadId)
})
