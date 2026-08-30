import { ThreadId } from "@rika/product/hosted-model"
import { Context, Crypto, Data, Effect, Encoding, Layer, Queue, Redacted, Schema } from "effect"
import { Client, type Notification } from "pg"
import {
  HostedPreviewSchema,
  PreviewFragment,
  projectPreviewFragments,
  type HostedPreview,
  type PreviewFragment as PreviewFragmentType,
} from "./preview-projection"

const previewChannel = "rika_thread_previews"
const subscriberCapacity = 64
const publisherCapacity = 256
const fragmentCharacters = 5_000
export type { HostedPreview } from "./preview-projection"

export type HostedPreviewDelivery =
  | { readonly _tag: "Preview"; readonly value: HostedPreview }
  | { readonly _tag: "Reset" }

export interface HostedPreviewSubscription {
  readonly take: Effect.Effect<HostedPreviewDelivery>
  readonly close: Effect.Effect<void>
}

export interface HostedPreviewBusService {
  readonly publish: (preview: HostedPreview) => void
  readonly subscribe: (threadId: ThreadId) => Effect.Effect<HostedPreviewSubscription>
}

interface Subscriber {
  readonly queue: Queue.Queue<HostedPreviewDelivery>
  overflowed: boolean
}

const subscriptionKey = (threadId: ThreadId) => String(threadId)

export const makeHostedPreviewBus = Effect.fn("HostedPreviewBus.make")(
  (forward: (preview: HostedPreview) => void = () => undefined) =>
    Effect.sync(() => {
      const subscribers = new Map<string, Set<Subscriber>>()
      const publishLocal = (preview: HostedPreview) => {
        const current = subscribers.get(subscriptionKey(preview.threadId))
        if (current === undefined) return
        for (const subscriber of current)
          if (!Queue.offerUnsafe(subscriber.queue, { _tag: "Preview", value: preview })) subscriber.overflowed = true
      }
      const resetLocal = (threadId: ThreadId) => {
        const current = subscribers.get(subscriptionKey(threadId))
        if (current === undefined) return
        for (const subscriber of current)
          if (!Queue.offerUnsafe(subscriber.queue, { _tag: "Reset" })) subscriber.overflowed = true
      }
      const bus = HostedPreviewBus.of({
        publish: (preview) => {
          publishLocal(preview)
          forward(preview)
        },
        subscribe: (threadId) =>
          Effect.gen(function* () {
            const key = subscriptionKey(threadId)
            const subscriber: Subscriber = {
              queue: yield* Queue.dropping<HostedPreviewDelivery>(subscriberCapacity),
              overflowed: false,
            }
            const current = subscribers.get(key) ?? new Set()
            current.add(subscriber)
            subscribers.set(key, current)
            return {
              take: Effect.suspend(() => {
                if (!subscriber.overflowed) return Queue.take(subscriber.queue)
                subscriber.overflowed = false
                return Queue.takeAll(subscriber.queue).pipe(Effect.as<HostedPreviewDelivery>({ _tag: "Reset" }))
              }),
              close: Effect.sync(() => {
                current.delete(subscriber)
                if (current.size === 0) subscribers.delete(key)
              }),
            }
          }),
      })
      return {
        bus,
        publishLocal,
        resetLocal,
        hasSubscribers: (threadId: ThreadId) => subscribers.has(subscriptionKey(threadId)),
      }
    }),
)

export class HostedPreviewBus extends Context.Service<HostedPreviewBus, HostedPreviewBusService>()(
  "@rika/api/hosted/thread/previews/HostedPreviewBus",
) {
  static readonly memoryLayer = Layer.effect(this, makeHostedPreviewBus().pipe(Effect.map((value) => value.bus)))
}

const encodePreview = Schema.encodeSync(Schema.fromJsonString(HostedPreviewSchema))
const encodeFragment = Schema.encodeSync(Schema.fromJsonString(PreviewFragment))
const decodeFragment = Schema.decodeOption(Schema.fromJsonString(PreviewFragment))

const fragments = (source: string, sequence: number, preview: HostedPreview): ReadonlyArray<string> => {
  const encoded = Encoding.encodeBase64(encodePreview(preview))
  const count = Math.ceil(encoded.length / fragmentCharacters)
  const id = `${source}:${sequence}`
  return Array.from({ length: count }, (_, index) =>
    encodeFragment({
      source,
      id,
      threadId: preview.threadId,
      index,
      count,
      data: encoded.slice(index * fragmentCharacters, (index + 1) * fragmentCharacters),
    }),
  )
}

class HostedPreviewTransportError extends Data.TaggedError("HostedPreviewTransportError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const transportFailure = (cause: unknown) =>
  new HostedPreviewTransportError({
    message: cause instanceof Error ? cause.message : "Thread preview transport failed",
    cause,
  })

const client = (databaseUrl: Redacted.Redacted<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => new Client({ connectionString: Redacted.value(databaseUrl) })).pipe(
      Effect.tap((connection) => Effect.tryPromise({ try: () => connection.connect(), catch: transportFailure })),
    ),
    (connection) => Effect.tryPromise(() => connection.end()).pipe(Effect.ignore),
  )

const publishOnce = (
  databaseUrl: Redacted.Redacted<string>,
  outgoing: Queue.Queue<HostedPreview>,
  source: string,
  nextSequence: () => number,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* client(databaseUrl)
      while (true) {
        const preview = yield* Queue.take(outgoing)
        for (const payload of fragments(source, nextSequence(), preview))
          yield* Effect.tryPromise({
            try: () => connection.query("SELECT pg_notify($1, $2)", [previewChannel, payload]),
            catch: transportFailure,
          })
      }
    }),
  )

const listenOnce = (
  databaseUrl: Redacted.Redacted<string>,
  source: string,
  receive: (fragment: PreviewFragmentType) => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* client(databaseUrl)
      yield* Effect.tryPromise({
        try: () => connection.query(`LISTEN ${previewChannel}`),
        catch: transportFailure,
      })
      yield* Effect.callback<void, HostedPreviewTransportError>((resume) => {
        let completed = false
        const notification = (message: Notification) => {
          if (message.channel !== previewChannel || message.payload === undefined) return
          const decoded = decodeFragment(message.payload)
          if (decoded._tag === "Some" && decoded.value.source !== source) receive(decoded.value)
        }
        const error = (cause: Error) => {
          if (completed) return
          completed = true
          resume(Effect.fail(transportFailure(cause)))
        }
        const end = () => {
          if (completed) return
          completed = true
          resume(Effect.void)
        }
        connection.on("notification", notification)
        connection.on("error", error)
        connection.once("end", end)
        return Effect.sync(() => {
          connection.off("notification", notification)
          connection.off("error", error)
          connection.off("end", end)
        })
      })
    }),
  )

const reconnect = (
  name: string,
  effect: Effect.Effect<void, HostedPreviewTransportError>,
  discard?: Effect.Effect<unknown>,
) =>
  effect.pipe(
    Effect.catch((cause) =>
      Effect.logError(name).pipe(
        Effect.annotateLogs("rika.error.message", cause.message),
        Effect.andThen(discard ?? Effect.void),
      ),
    ),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
  )

export const postgresHostedPreviewBusLayer = (options: { readonly databaseUrl: Redacted.Redacted<string> }) =>
  Layer.effect(
    HostedPreviewBus,
    Effect.gen(function* () {
      const ownerScope = yield* Effect.scope
      const crypto = yield* Crypto.Crypto
      const source = yield* crypto.randomUUIDv4
      const outgoing = yield* Queue.sliding<HostedPreview>(publisherCapacity)
      const local = yield* makeHostedPreviewBus((preview) => void Queue.offerUnsafe(outgoing, preview))
      let sequence = 0
      const receive = projectPreviewFragments(local)
      yield* reconnect(
        "hosted-preview-publisher.disconnected",
        publishOnce(options.databaseUrl, outgoing, source, () => (sequence += 1)),
        Queue.takeAll(outgoing),
      ).pipe(Effect.forkIn(ownerScope))
      yield* reconnect("hosted-preview-listener.disconnected", listenOnce(options.databaseUrl, source, receive)).pipe(
        Effect.forkIn(ownerScope),
      )
      return local.bus
    }),
  )
