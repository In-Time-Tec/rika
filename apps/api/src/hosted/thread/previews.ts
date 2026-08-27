import * as ExecutionGateway from "@rika/product/execution-gateway"
import { ThreadId } from "@rika/product/hosted-model"
import * as Turn from "@rika/product/turn-record"
import { Context, Crypto, Data, Effect, Encoding, Layer, Queue, Redacted, Result, Schema } from "effect"
import { Client, type Notification } from "pg"

const previewChannel = "rika_thread_previews"
const subscriberCapacity = 64
const publisherCapacity = 256
const fragmentCharacters = 5_000
const reassemblyCapacity = 256

export interface HostedPreview {
  readonly threadId: ThreadId
  readonly turnId: Turn.TurnId
  readonly preview: ExecutionGateway.ModelPreviewEvent
}

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

const HostedPreviewSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: Turn.TurnId,
  preview: ExecutionGateway.ModelPreviewEvent,
})

const PreviewFragment = Schema.Struct({
  source: Schema.String,
  id: Schema.String,
  threadId: ThreadId,
  index: Schema.Int,
  count: Schema.Int,
  data: Schema.String,
})
type PreviewFragment = typeof PreviewFragment.Type
const encodePreview = Schema.encodeSync(Schema.fromJsonString(HostedPreviewSchema))
const decodePreview = Schema.decodeOption(Schema.fromJsonString(HostedPreviewSchema))
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
    message: cause instanceof Error ? cause.message : "Hosted preview transport failed",
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

interface Reassembly {
  readonly fragment: PreviewFragment
  readonly parts: Array<string | undefined>
}

const listenOnce = (
  databaseUrl: Redacted.Redacted<string>,
  source: string,
  receive: (fragment: PreviewFragment) => void,
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
      const reassembly = new Map<string, Reassembly>()
      const latest = new Map<string, string>()
      let sequence = 0
      const streamFor = (fragment: PreviewFragment) => `${fragment.source}:${fragment.threadId}`
      const discard = (id: string, fragment: PreviewFragment) => {
        reassembly.delete(id)
        const stream = streamFor(fragment)
        if (latest.get(stream) === id) latest.delete(stream)
      }
      const receive = (fragment: PreviewFragment) => {
        if (fragment.count < 1 || fragment.count > 16 || fragment.index < 0 || fragment.index >= fragment.count) return
        const stream = streamFor(fragment)
        if (!local.hasSubscribers(fragment.threadId)) {
          const stale = latest.get(stream)
          if (stale !== undefined) discard(stale, fragment)
          return
        }
        const previous = latest.get(stream)
        if (fragment.index === 0 && previous !== undefined && previous !== fragment.id) {
          reassembly.delete(previous)
          local.resetLocal(fragment.threadId)
        }
        latest.set(stream, fragment.id)
        let current = reassembly.get(fragment.id)
        if (current === undefined) {
          if (reassembly.size >= reassemblyCapacity) {
            const evictedKey = reassembly.keys().next().value!
            const evicted = reassembly.get(evictedKey)
            if (evicted !== undefined) {
              local.resetLocal(evicted.fragment.threadId)
              discard(evictedKey, evicted.fragment)
            }
          }
          current = { fragment, parts: Array.from({ length: fragment.count }) }
          reassembly.set(fragment.id, current)
        }
        if (current.fragment.count !== fragment.count || current.fragment.threadId !== fragment.threadId) {
          discard(fragment.id, fragment)
          local.resetLocal(fragment.threadId)
          return
        }
        current.parts[fragment.index] = fragment.data
        if (current.parts.some((part) => part === undefined)) return
        discard(fragment.id, fragment)
        const decoded = Result.getOrUndefined(Encoding.decodeBase64String(current.parts.join("")))
        if (decoded === undefined) {
          local.resetLocal(fragment.threadId)
          return
        }
        const preview = decodePreview(decoded)
        if (preview._tag === "Some" && preview.value.threadId === fragment.threadId) local.publishLocal(preview.value)
        else local.resetLocal(fragment.threadId)
      }
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
