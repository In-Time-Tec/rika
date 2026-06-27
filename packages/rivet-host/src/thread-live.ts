import { IdGenerator, Time } from "@rika/core"
import { Database, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Event, Ids, Message } from "@rika/schema"
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
  | Database.Service
  | IdGenerator.Service
  | Registry.Registry
  | ThreadEventLog.Service
  | ThreadProjection.Service
  | Time.Service
> = ThreadActor.toLayer(
  Effect.fnUntraced(function* ({ state }) {
    const eventLog = yield* ThreadEventLog.Service
    const projection = yield* ThreadProjection.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service

    const replay = (input: ThreadIdPayload) =>
      Effect.gen(function* () {
        const events = yield* eventLog.readThread({ thread_id: input.thread_id })
        const next = stateFromEvents(input.thread_id, events)
        yield* State.set(state, next).pipe(Effect.orDie)
        return snapshotFromState(next, input.thread_id)
      })

    const appendAndProject = (event: Event.Event) =>
      Effect.gen(function* () {
        const appended = yield* eventLog.append(event)
        yield* projection.apply(appended)
        return appended
      })

    const ensureThread = (input: EnsureThreadPayload) =>
      Effect.gen(function* () {
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
        const ensured = yield* ensureThread(input)
        const turnId = Ids.TurnId.make(yield* idGenerator.next("turn"))
        const started = yield* makeTurnStarted(input.thread_id, turnId, ensured.last_sequence + 1, idGenerator, time)
        const message = yield* makeMessageAdded(
          input.thread_id,
          turnId,
          input.content,
          ensured.last_sequence + 2,
          idGenerator,
          time,
        )
        const appendedStarted = yield* appendAndProject(started)
        const appendedMessage = yield* appendAndProject(message)
        const previousEvents = yield* eventLog.readThread({ thread_id: input.thread_id, limit: ensured.last_sequence })
        const next = stateFromEvents(input.thread_id, [...previousEvents, appendedStarted, appendedMessage])
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

const makeTurnStarted = (
  threadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  sequence: number,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.TurnStarted> =>
  Effect.gen(function* () {
    const createdAt = yield* time.nowMillis
    const eventId = Ids.EventId.make(yield* idGenerator.next("event"))
    const event: Event.TurnStarted = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence,
      version: 1,
      created_at: createdAt,
      type: "turn.started",
      data: {},
    }
    return event
  })

const makeMessageAdded = (
  threadId: Ids.ThreadId,
  turnId: Ids.TurnId,
  content: string,
  sequence: number,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
): Effect.Effect<Event.MessageAdded> =>
  Effect.gen(function* () {
    const createdAt = yield* time.nowMillis
    const messageId = Ids.MessageId.make(yield* idGenerator.next("message"))
    const eventId = Ids.EventId.make(yield* idGenerator.next("event"))
    const event: Event.MessageAdded = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence,
      version: 1,
      created_at: createdAt,
      type: "message.added",
      data: {
        message: Message.user({
          id: messageId,
          thread_id: threadId,
          turn_id: turnId,
          content,
          created_at: createdAt,
        }),
      },
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
