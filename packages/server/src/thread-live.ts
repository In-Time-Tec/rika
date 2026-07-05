import { Database, ThreadEventLog } from "@rika/persistence"
import { Event, Ids } from "@rika/schema"
import { Context, Effect, Layer, PubSub, Queue, Semaphore, Stream } from "effect"

export interface SubscribeInput {
  readonly thread_id: Ids.ThreadId
  readonly after_sequence?: number
}

export interface TopicLifecycle {
  readonly created?: (threadId: Ids.ThreadId, topic: PubSub.PubSub<Event.Event>) => Effect.Effect<void>
  readonly removed?: (threadId: Ids.ThreadId, topic: PubSub.PubSub<Event.Event>) => Effect.Effect<void>
}

interface TopicState {
  readonly topic: PubSub.PubSub<Event.Event>
  subscribers: number
}

export interface Interface {
  readonly publish: (event: Event.Event) => Effect.Effect<void>
  readonly publishAll: (events: ReadonlyArray<Event.Event>) => Effect.Effect<void>
  readonly subscribe: (
    input: SubscribeInput,
  ) => Stream.Stream<Event.Event, Database.DatabaseError | ThreadEventLog.ThreadEventLogError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/server/ThreadLive") {}

export const layerWithTopicLifecycle = (lifecycle: TopicLifecycle = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const eventLog = yield* ThreadEventLog.Service
      const topics = new Map<Ids.ThreadId, TopicState>()
      const mutex = yield* Semaphore.make(1)

      const stateFor = (threadId: Ids.ThreadId) =>
        Effect.gen(function* () {
          const existing = topics.get(threadId)
          if (existing !== undefined) return existing
          const topic = yield* PubSub.unbounded<Event.Event>()
          const state: TopicState = { topic, subscribers: 0 }
          topics.set(threadId, state)
          if (lifecycle.created !== undefined) yield* lifecycle.created(threadId, topic)
          return state
        })

      const acquireSubscriber = (threadId: Ids.ThreadId) =>
        mutex.withPermit(
          Effect.gen(function* () {
            const state = yield* stateFor(threadId)
            state.subscribers += 1
            const subscription = yield* PubSub.subscribe(state.topic)
            return { state, subscription }
          }),
        )

      const releaseSubscriber = (threadId: Ids.ThreadId, state: TopicState) =>
        mutex.withPermit(
          Effect.gen(function* () {
            state.subscribers = Math.max(0, state.subscribers - 1)
            if (state.subscribers > 0 || topics.get(threadId) !== state) return
            topics.delete(threadId)
            yield* PubSub.shutdown(state.topic).pipe(Effect.ignore)
            if (lifecycle.removed !== undefined) yield* lifecycle.removed(threadId, state.topic)
          }),
        )

      const publishToTopic = (event: Event.Event) =>
        mutex.withPermit(
          Effect.gen(function* () {
            const state = topics.get(event.thread_id)
            if (state === undefined) return
            yield* PubSub.publish(state.topic, event).pipe(Effect.asVoid)
          }),
        )

      const publish = Effect.fn("ThreadLive.publish")(function* (event: Event.Event) {
        yield* publishToTopic(event)
      })

      const readAfter = (threadId: Ids.ThreadId, afterSequence: number) =>
        eventLog
          .readThread({ thread_id: threadId, after_sequence: afterSequence })
          .pipe(Effect.provideService(Database.Service, database))

      return Service.of({
        publish,
        publishAll: Effect.fn("ThreadLive.publishAll")(function* (events: ReadonlyArray<Event.Event>) {
          yield* Effect.forEach(events, publish, { discard: true })
        }),
        subscribe: (input: SubscribeInput) =>
          Stream.callback<Event.Event, Database.DatabaseError | ThreadEventLog.ThreadEventLogError>(
            (queue) =>
              Effect.gen(function* () {
                const { subscription } = yield* Effect.acquireRelease(acquireSubscriber(input.thread_id), ({ state }) =>
                  releaseSubscriber(input.thread_id, state),
                )
                let lastSequence = input.after_sequence ?? 0
                const offer = (event: Event.Event) =>
                  Effect.gen(function* () {
                    if (event.thread_id !== input.thread_id || event.sequence <= lastSequence) return
                    lastSequence = event.sequence
                    yield* Queue.offer(queue, event).pipe(Effect.asVoid)
                  })
                const catchUp = yield* readAfter(input.thread_id, lastSequence)
                yield* Effect.forEach(catchUp, offer, { discard: true })
                yield* Effect.forever(
                  Effect.gen(function* () {
                    const event = yield* PubSub.take(subscription)
                    if (event.thread_id !== input.thread_id || event.sequence <= lastSequence) return
                    if (event.sequence > lastSequence + 1) {
                      const events = yield* readAfter(input.thread_id, lastSequence)
                      yield* Effect.forEach(events, offer, { discard: true })
                      return
                    }
                    yield* offer(event)
                  }),
                ).pipe(
                  Effect.catch((error) => Queue.fail(queue, error).pipe(Effect.asVoid)),
                  Effect.ensuring(Queue.end(queue).pipe(Effect.ignore)),
                  Effect.forkScoped,
                )
              }),
            { bufferSize: 64, strategy: "suspend" },
          ),
      })
    }),
  )

export const layer = layerWithTopicLifecycle()

export const publish = Effect.fn("ThreadLive.publish.call")(function* (event: Event.Event) {
  const service = yield* Service
  return yield* service.publish(event)
})

export const publishAll = Effect.fn("ThreadLive.publishAll.call")(function* (events: ReadonlyArray<Event.Event>) {
  const service = yield* Service
  return yield* service.publishAll(events)
})

export const subscribe = (input: SubscribeInput) =>
  Stream.unwrap(Effect.map(Service, (service) => service.subscribe(input)))
