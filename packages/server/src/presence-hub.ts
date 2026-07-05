import { SynchronizedMap, Time } from "@rika/core"
import { Common, Ids, Remote } from "@rika/schema"
import { Context, Effect, HashMap, Layer, Option, PubSub, Queue, Stream } from "effect"

const ttlMillis = 45_000
const sweepInterval = "1 second"

interface PresenceRecord {
  readonly state: Remote.PresenceState
  readonly last_seen: Common.TimestampMillis
}

interface ThreadState {
  readonly users: Map<Ids.UserId, PresenceRecord>
  readonly topic: PubSub.PubSub<Remote.PresenceFrame>
  subscribers: number
}

export interface Interface {
  readonly heartbeat: (input: Remote.SetThreadPresenceRequest) => Effect.Effect<Remote.PresenceFrame>
  readonly subscribe: (threadId: Ids.ThreadId) => Stream.Stream<Remote.PresenceFrame>
}

export class Service extends Context.Service<Service, Interface>()("@rika/server/PresenceHub") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const time = yield* Time.Service
    const scope = yield* Effect.scope
    const threads = yield* SynchronizedMap.make<Ids.ThreadId, ThreadState>()

    const expireAll = Effect.fn("PresenceHub.expireAll")(function* () {
      const now = yield* time.nowMillis
      yield* SynchronizedMap.modifyEffect(threads, (entries) =>
        Effect.gen(function* () {
          let next = entries
          for (const [threadId, state] of entries) {
            if (sweep(state, now)) yield* PubSub.publish(state.topic, snapshot(threadId, state)).pipe(Effect.asVoid)
            if (state.users.size > 0 || state.subscribers > 0) continue
            next = HashMap.remove(next, threadId)
            yield* PubSub.shutdown(state.topic).pipe(Effect.ignore)
          }
          return [undefined, next] as const
        }),
      )
    })

    yield* Effect.forkIn(Effect.forever(Effect.sleep(sweepInterval).pipe(Effect.andThen(expireAll))), scope)

    const stateFor = (entries: HashMap.HashMap<Ids.ThreadId, ThreadState>, threadId: Ids.ThreadId) =>
      Effect.gen(function* () {
        const existing = HashMap.get(entries, threadId)
        if (Option.isSome(existing)) return [existing.value, entries] as const
        const topic = yield* PubSub.sliding<Remote.PresenceFrame>(1)
        const state: ThreadState = { users: new Map(), topic, subscribers: 0 }
        return [state, HashMap.set(entries, threadId, state)] as const
      })

    const releaseSubscriber = (threadId: Ids.ThreadId, state: ThreadState) =>
      SynchronizedMap.modifyEffect(threads, (entries) =>
        Effect.gen(function* () {
          state.subscribers = Math.max(0, state.subscribers - 1)
          const current = HashMap.get(entries, threadId)
          if (state.users.size > 0 || state.subscribers > 0 || Option.isNone(current) || current.value !== state) {
            return [undefined, entries] as const
          }
          yield* PubSub.shutdown(state.topic).pipe(Effect.ignore)
          return [undefined, HashMap.remove(entries, threadId)] as const
        }),
      )

    const acquireSubscriber = (threadId: Ids.ThreadId) =>
      SynchronizedMap.modifyEffect(threads, (entries) =>
        Effect.gen(function* () {
          const [state, next] = yield* stateFor(entries, threadId)
          state.subscribers += 1
          return [state, next] as const
        }),
      )

    const heartbeat = Effect.fn("PresenceHub.heartbeat")(function* (input: Remote.SetThreadPresenceRequest) {
      const now = yield* time.nowMillis
      return yield* SynchronizedMap.modifyEffect(threads, (entries) =>
        Effect.gen(function* () {
          const [state, next] = yield* stateFor(entries, input.thread_id)
          sweep(state, now)
          state.users.set(input.user_id, { state: input.state, last_seen: now })
          const frame = snapshot(input.thread_id, state)
          yield* PubSub.publish(state.topic, frame).pipe(Effect.asVoid)
          return [frame, next] as const
        }),
      )
    })

    return Service.of({
      heartbeat,
      subscribe: (threadId: Ids.ThreadId) =>
        Stream.callback<Remote.PresenceFrame>(
          (queue) =>
            Effect.gen(function* () {
              const state = yield* Effect.acquireRelease(acquireSubscriber(threadId), (acquired) =>
                releaseSubscriber(threadId, acquired),
              )
              const now = yield* time.nowMillis
              const result = yield* SynchronizedMap.modifyEffect(threads, (entries) =>
                Effect.gen(function* () {
                  const expired = sweep(state, now)
                  const subscription = yield* PubSub.subscribe(state.topic)
                  const frame = snapshot(threadId, state)
                  if (expired) yield* PubSub.publish(state.topic, frame).pipe(Effect.asVoid)
                  return [{ subscription, frame }, entries] as const
                }),
              )
              yield* Queue.offer(queue, result.frame).pipe(Effect.asVoid)
              yield* Effect.forever(
                PubSub.take(result.subscription).pipe(
                  Effect.flatMap((frame) => Queue.offer(queue, frame).pipe(Effect.asVoid)),
                ),
              ).pipe(Effect.ensuring(Queue.end(queue).pipe(Effect.ignore)), Effect.forkScoped)
            }),
          { bufferSize: 1, strategy: "sliding" },
        ),
    })
  }),
)

export const heartbeat = Effect.fn("PresenceHub.heartbeat.call")(function* (input: Remote.SetThreadPresenceRequest) {
  const service = yield* Service
  return yield* service.heartbeat(input)
})

export const subscribe = (threadId: Ids.ThreadId) =>
  Stream.unwrap(Effect.map(Service, (service) => service.subscribe(threadId)))

const sweep = (state: ThreadState, now: Common.TimestampMillis) => {
  let expired = false
  for (const [userId, record] of state.users.entries()) {
    if (now - record.last_seen <= ttlMillis) continue
    state.users.delete(userId)
    expired = true
  }
  return expired
}

const snapshot = (threadId: Ids.ThreadId, state: ThreadState): Remote.PresenceFrame => ({
  presence: {
    thread_id: threadId,
    users: [...state.users.entries()]
      .map(([user_id, record]) => ({ user_id, state: record.state, last_seen: record.last_seen }))
      .toSorted((left, right) => left.user_id.localeCompare(right.user_id)),
  },
})
