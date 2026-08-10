import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as InteractiveFeedOverflow from "@rika/product/server-interactive-feed"
import * as ServerService from "@rika/product/server-service"
import { Deferred, Effect, Fiber, Function, Queue, Ref, Schema, Semaphore } from "effect"
import type { Crypto as CryptoShape } from "effect/Crypto"
import type { ServerRoute, ServerSession } from "./server-host-types"
import { json } from "../protocol/server-protocol"
import { serverMessageFrames } from "../protocol/server-message-codec"

export const interactiveFeedInFlightCapacity = 32

const routeKeyImpl = (connectionId: string, requestId: string): string => `${connectionId}\0${requestId}`
export const routeKey: {
  (requestId: string): (connectionId: string) => string
  (connectionId: string, requestId: string): string
} = Function.dual(2, routeKeyImpl)

export type InteractiveRouter = (
  input: InteractiveFeedOverflow.InteractiveInput,
  session: InteractiveSession.InteractiveSession,
) => Effect.Effect<void, ProductOperation.OperationUnavailable>

type RouterContext = {
  readonly crypto: CryptoShape
  readonly options: { readonly outboundCapacity: number }
  readonly requestByInput: WeakMap<object, { readonly requestId: string; readonly routeKey: string }>
  readonly routes: Ref.Ref<Map<string, ServerRoute>>
}

export const makeInteractiveRouter = (context: RouterContext): InteractiveRouter => {
  const { crypto, options, requestByInput, routes } = context
  const interactive = Effect.fn("ServerTransport.interactive")(function* (
    input: InteractiveFeedOverflow.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
  ) {
    const request = requestByInput.get(input)
    if (request === undefined)
      return yield* ProductOperation.OperationUnavailable.make({
        operation: "Interactive",
        message: "Missing interactive request",
      })
    const { requestId, routeKey: requestRouteKey } = request
    const route = (yield* Ref.get(routes)).get(requestRouteKey)
    if (route === undefined)
      return yield* ProductOperation.OperationUnavailable.make({
        operation: "Interactive",
        message: "Interactive client disconnected",
      })
    const sessionId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((error) =>
        ProductOperation.OperationUnavailable.make({ operation: "Interactive", message: String(error) }),
      ),
    )
    const feedGeneration = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((error) =>
        ProductOperation.OperationUnavailable.make({ operation: "Interactive", message: String(error) }),
      ),
    )
    const ended = yield* Deferred.make<void>()
    const feed = yield* Queue.bounded<
      { readonly _tag: "Event"; readonly event: InteractiveEvent.InteractiveEvent } | { readonly _tag: "Overflow" }
    >(options.outboundCapacity)
    const inFlightCapacity = Math.min(options.outboundCapacity, interactiveFeedInFlightCapacity)
    const sendPermits = yield* Queue.bounded<void>(inFlightCapacity)
    for (let index = 0; index < inFlightCapacity; index += 1) yield* Queue.offer(sendPermits, undefined)
    const feedAdmission = yield* Semaphore.make(1)
    const inFlight = new Map<number, boolean>()
    const commands = new Map<number, Deferred.Deferred<void>>()
    const commandReleases = new Map<number, Effect.Effect<void>>()
    const commandQueue = yield* Queue.bounded<{
      readonly sequence: number
      readonly cancelled: Deferred.Deferred<void>
      readonly effect: Effect.Effect<void, ProductOperation.OperationUnavailable | ServerService.ServerServiceError>
    }>(options.outboundCapacity)
    let nextCommandSequence = 1
    let nextSequence = 1
    let acknowledgedThrough = 0
    let highestSent = 0
    let outstandingDetails = 0
    let overflow: InteractiveFeedOverflow.State | undefined
    let sentDetails = 0
    const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
      if (overflow !== undefined) {
        InteractiveFeedOverflow.remember(overflow, event)
        return
      }
      if (outstandingDetails >= options.outboundCapacity || !Queue.offerUnsafe(feed, { _tag: "Event", event })) {
        overflow = InteractiveFeedOverflow.make()
        InteractiveFeedOverflow.remember(overflow, event)
        Queue.offerUnsafe(feed, { _tag: "Overflow" })
        return
      }
      outstandingDetails += 1
    }
    let sentBytes = 0
    const sendNew = (event: InteractiveEvent.InteractiveEvent, detail: boolean) =>
      Effect.gen(function* () {
        yield* Queue.take(sendPermits)
        const sequence = yield* feedAdmission.withPermits(1)(
          Effect.sync(() => {
            const current = nextSequence
            nextSequence += 1
            highestSent = current
            inFlight.set(current, detail)
            return current
          }),
        )
        const message: ServerService.ServerMessage = {
          _tag: "interactive-feed-event",
          connectionId: route.connectionId,
          requestId,
          sessionId,
          feedGeneration,
          sequence,
          event,
        }
        const frames = yield* Effect.try({
          try: () => serverMessageFrames(`${feedGeneration}:${sequence}`, message),
          catch: (error) =>
            ProductOperation.OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: String(error),
            }),
        })
        if (frames.length > 1)
          yield* Effect.logInfo("server.feed.message_fragmented").pipe(
            Effect.annotateLogs({
              "rika.server.feed.sequence": sequence,
              "rika.server.feed.fragments": frames.length,
            }),
          )
        sentBytes += frames.reduce((total, frame) => total + frame.length, 0)
        yield* route.sendFrames(frames)
      })
    const sender = Effect.gen(function* () {
      while (true) {
        const item = yield* Queue.take(feed)
        if (item._tag === "Event") {
          yield* sendNew(item.event, true)
          sentDetails += 1
          if (sentDetails % 1_024 === 0)
            yield* Effect.logInfo("server.feed.detail_sent").pipe(
              Effect.annotateLogs({
                "rika.server.feed.sent": sentDetails,
                "rika.server.feed.bytes": sentBytes,
                "rika.server.feed.queued": yield* Queue.size(feed),
                "rika.server.feed.overflowed": overflow !== undefined,
              }),
            )
        }
        if ((yield* Queue.size(feed)) === 0 && overflow !== undefined) {
          const state = overflow
          overflow = undefined
          const reason = state.criticalOverflowed
            ? "Server event feed exceeded its bounded non-recoverable event capacity"
            : "Server event feed exceeded its bounded current-session window"
          for (const event of InteractiveFeedOverflow.events(state)) yield* sendNew(event, false)
          if (state.criticalOverflowed)
            return yield* ProductOperation.OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: reason,
            })
        }
      }
    })
    const acknowledge = (throughSequence: number) =>
      feedAdmission.withPermits(1)(
        Effect.gen(function* () {
          if (throughSequence <= acknowledgedThrough) return true
          if (throughSequence > highestSent) return false
          let released = 0
          for (const [sequence, detail] of inFlight) {
            if (sequence > throughSequence) break
            inFlight.delete(sequence)
            released += 1
            if (detail) outstandingDetails -= 1
          }
          acknowledgedThrough = throughSequence
          for (let index = 0; index < released; index += 1) yield* Queue.offer(sendPermits, undefined)
          return true
        }),
      )
    const serverSession: ServerSession = {
      session,
      ended,
      feedGeneration,
      commands,
      commandReleases,
      commandQueue,
      acceptCommand: (sequence) => {
        if (sequence !== nextCommandSequence) return false
        nextCommandSequence += 1
        return true
      },
      acknowledge,
    }
    route.sessions.set(sessionId, serverSession)
    yield* route.send(
      json({
        _tag: "interactive-started",
        connectionId: route.connectionId,
        requestId,
        sessionId,
        feedGeneration,
        feedCapacity: options.outboundCapacity,
      } satisfies ServerService.ServerMessage),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const source = yield* Effect.forkChild(session.events(dispatch))
        const delivery = yield* Effect.forkChild(sender)
        const commandWorker = yield* Effect.forkChild(
          Effect.forever(
            Queue.take(commandQueue).pipe(
              Effect.orDie,
              Effect.flatMap((command) =>
                Effect.raceFirst(Deferred.await(command.cancelled), command.effect).pipe(
                  Effect.mapError((failure) =>
                    Schema.is(ProductOperation.OperationUnavailable)(failure)
                      ? failure
                      : ProductOperation.OperationUnavailable.make({
                          operation: "InteractiveSession.command",
                          message: failure.message,
                        }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (commands.get(command.sequence) === command.cancelled) commands.delete(command.sequence)
                    }),
                  ),
                ),
              ),
            ),
          ),
        )
        yield* Effect.raceFirst(
          Deferred.await(ended),
          Effect.raceFirst(Fiber.join(source), Effect.raceFirst(Fiber.join(delivery), Fiber.join(commandWorker))),
        )
      }),
    ).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          route.sessions.delete(sessionId)
          for (const command of commands.values()) yield* Deferred.succeed(command, undefined)
          for (const release of commandReleases.values()) yield* release
          commands.clear()
          commandReleases.clear()
          yield* Queue.shutdown(commandQueue)
          yield* Queue.shutdown(feed)
          yield* Queue.shutdown(sendPermits)
        }),
      ),
    )
  })
  return ((input, session) =>
    interactive(input, session).pipe(
      Effect.mapError((error) =>
        ProductOperation.OperationUnavailable.make({ operation: "Interactive", message: String(error) }),
      ),
      Effect.asVoid,
    )) as InteractiveRouter
}
