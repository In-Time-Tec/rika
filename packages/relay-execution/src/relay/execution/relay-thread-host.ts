import { ModelRegistry } from "@batonfx/core"
import { Client, Content, Ids, type Resident } from "@relayfx/sdk"
import { BackendError } from "@rika/product/execution-service"
import type { ThreadQueueWake } from "@rika/product/execution-request"
import { Cause, Crypto, Effect, Layer, PlatformError, Ref, Schema, Semaphore, Stream } from "effect"
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai"
import { hostSelection, waitToolName } from "./relay-thread-host-constants"
import { pendingQueueWakes } from "./relay-thread-host-queue"

export class PromoteTurnError extends Schema.TaggedErrorClass<PromoteTurnError>()("PromoteTurnError", {
  message: Schema.String,
}) {}

const PromoteTurnFailure = Schema.Struct({ _tag: Schema.tag("PromoteTurnError"), message: Schema.String })

export const promoteTurnTool = Tool.make("promote_turn", {
  description: "Claim and start every currently claimable queued Rika turn for a thread",
  parameters: Schema.Struct({ threadId: Schema.String, generation: Schema.Int }),
  success: Schema.Struct({ promoted: Schema.Finite }),
  failure: PromoteTurnFailure,
  failureMode: "return",
})

export const toolkit = Toolkit.make(promoteTurnTool)

export const handlerLayer = (registry: import("./relay-thread-host-registry").RegistryInterface) =>
  toolkit.toLayer({
    promote_turn: ({ threadId, generation }) =>
      registry.promote(threadId, generation).pipe(Effect.map((promoted) => ({ promoted }))),
  })

const usage = (): Response.Usage =>
  Response.Usage.make({
    inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  })

const finish = (reason: "stop" | "tool-calls"): Response.FinishPartEncoded => ({
  type: "finish",
  reason,
  usage: usage(),
  response: undefined,
})

const respond = (
  namespace: string,
  counter: Ref.Ref<number>,
  options: LanguageModel.ProviderOptions,
): Effect.Effect<Array<Response.PartEncoded>> =>
  Effect.gen(function* () {
    const request = yield* Ref.getAndUpdate(counter, (value) => value + 1)
    const wakes = pendingQueueWakes(options.prompt)
    if (wakes.length === 0)
      return [
        {
          type: "tool-call",
          id: `${namespace}-wait-${request}`,
          name: waitToolName,
          params: {},
          providerExecuted: false,
        },
        finish("tool-calls"),
      ]
    return [
      ...wakes.map(
        (wake, index): Response.PartEncoded => ({
          type: "tool-call",
          id: `${namespace}-promote-${request}-${index}`,
          name: "promote_turn",
          params: { threadId: wake.threadId, generation: wake.generation },
          providerExecuted: false,
        }),
      ),
      finish("tool-calls"),
    ]
  })

const toStreamParts = (parts: Array<Response.PartEncoded>): Array<Response.StreamPartEncoded> =>
  parts.flatMap((part): Array<Response.StreamPartEncoded> => {
    if (part.type !== "text") return [part as Response.StreamPartEncoded]
    const id = "thread-host-text"
    return [
      { type: "text-start", id },
      { type: "text-delta", id, delta: part.text },
      { type: "text-end", id },
    ]
  })

export const hostRegistration: Effect.Effect<ModelRegistry.Registration, PlatformError.PlatformError, Crypto.Crypto> =
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const namespace = yield* crypto.randomUUIDv4
    const counter = yield* Ref.make(0)
    const service = yield* LanguageModel.make({
      generateText: (options) => respond(namespace, counter, options),
      streamText: (options) =>
        Stream.unwrap(
          respond(namespace, counter, options).pipe(Effect.map((parts) => Stream.fromIterable(toStreamParts(parts)))),
        ),
    })
    return yield* ModelRegistry.registration({
      provider: hostSelection.provider,
      model: hostSelection.model,
      layer: Layer.succeed(LanguageModel.LanguageModel, service),
      toolJsonSchemaCompiler: (tool: Tool.Any) => Effect.succeed(Tool.getJsonSchema(tool)),
    })
  })

export const wakeThreadHost = (input: {
  readonly client: Client.Interface
  readonly addressId: Ids.AddressId
  readonly hostGate: Semaphore.Semaphore
  readonly hostInstance: (
    threadId: string,
    now: number,
  ) => Effect.Effect<Resident.Instance, Client.ClientError | Client.ExecutionNotFound>
  readonly awaitParkedHost: (
    threadId: string,
    instance: Resident.Instance,
    now: number,
  ) => Effect.Effect<Resident.Instance, Client.ClientError | Client.ExecutionNotFound>
  readonly failureKind: (cause: Cause.Cause<unknown>) => string
}) =>
  Effect.fn("ExecutionBackend.wakeThreadHost")(function* (wake: ThreadQueueWake) {
    yield* input.hostGate
      .withPermits(1)(
        Effect.gen(function* () {
          const created = yield* input.hostInstance(wake.threadId, wake.now)
          const instance = yield* input.awaitParkedHost(wake.threadId, created, wake.now)
          const notification = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
            kind: "queue-ready",
            thread_id: wake.threadId,
            wake_generation: wake.generation,
            queue_revision: wake.queueRevision,
          })
          yield* input.client.envelopes.send({
            from: input.addressId,
            to: instance.address_id,
            content: [Content.text(notification)],
            idempotency_key: `rika:queue-wake:${wake.threadId}:${wake.generation}`,
          })
        }),
      )
      .pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("thread_host.notification.failed").pipe(
                Effect.annotateLogs({
                  "rika.thread.id": wake.threadId,
                  "rika.queue.wake_generation": wake.generation,
                  "rika.queue.revision": wake.queueRevision,
                  "rika.failure.kind": input.failureKind(cause),
                }),
              ),
        ),
        Effect.mapError((cause) => BackendError.make({ message: String(cause) })),
      )
  })
