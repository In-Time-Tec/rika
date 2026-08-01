import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as InteractiveFeedOverflow from "@rika/product/resident-interactive-feed"
import * as ResidentService from "@rika/product/resident-service"
import { Deferred, Effect, Fiber, Function, Queue, Ref, Schema, Semaphore } from "effect"
import type { Crypto as CryptoShape } from "effect/Crypto"
import type { ResidentRoute, ResidentSession } from "./resident-host-types"
import { json } from "../protocol/resident-protocol"
import { serverMessageFrames } from "../protocol/resident-message-codec"

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
  readonly routes: Ref.Ref<Map<string, ResidentRoute>>
}

export const makeInteractiveRouter = (context: RouterContext): InteractiveRouter => {
  const { crypto, options, requestByInput, routes } = context
  const interactive = Effect.fn("ResidentTransport.interactive")(function* (
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
      | { readonly _tag: "Event"; readonly event: InteractiveEvent.InteractiveEvent }
      | { readonly _tag: "Replay"; readonly afterSequence: number }
      | { readonly _tag: "Overflow" }
    >(options.outboundCapacity)
    const inFlightCapacity = Math.min(options.outboundCapacity, interactiveFeedInFlightCapacity)
    const sendPermits = yield* Queue.bounded<void>(inFlightCapacity)
    for (let index = 0; index < inFlightCapacity; index += 1) yield* Queue.offer(sendPermits, undefined)
    const feedAdmission = yield* Semaphore.make(1)
    const replayWindow = new Map<
      number,
      { readonly frames: ReadonlyArray<string>; readonly detail: boolean; readonly barrier: boolean }
    >()
    const barrierAcknowledgements = new Map<number, Deferred.Deferred<void>>()
    const commands = new Map<number, Deferred.Deferred<void>>()
    const commandReleases = new Map<number, Effect.Effect<void>>()
    const commandQueue = yield* Queue.bounded<{
      readonly sequence: number
      readonly cancelled: Deferred.Deferred<void>
      readonly effect: Effect.Effect<void, ProductOperation.OperationUnavailable | ResidentService.ResidentServiceError>
    }>(options.outboundCapacity)
    let nextCommandSequence = 1
    let nextSequence = 1
    let acknowledgedThrough = 0
    let highestSent = 0
    let replayFloor = 1
    let outstandingDetails = 0
    let selectedThreadId: string | undefined
    let selectionEpoch = 0
    let overflow: InteractiveFeedOverflow.State | undefined
    let sentDetails = 0
    const rememberSelection = (event: InteractiveEvent.InteractiveEvent) => {
      let threadId: string | undefined
      if (event._tag === "SelectionLoaded") threadId = String(event.thread.id)
      else if ("threadId" in event && event.threadId !== undefined) threadId = String(event.threadId)
      if (threadId !== undefined) selectedThreadId = threadId
      if ("selectionEpoch" in event) selectionEpoch = event.selectionEpoch
      return threadId
    }
    const remember = (state: InteractiveFeedOverflow.State, event: InteractiveEvent.InteractiveEvent) => {
      rememberSelection(event)
      InteractiveFeedOverflow.remember(state, event)
    }
    const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
      if (overflow !== undefined) {
        remember(overflow, event)
        return
      }
      if (outstandingDetails >= options.outboundCapacity || !Queue.offerUnsafe(feed, { _tag: "Event", event })) {
        overflow = InteractiveFeedOverflow.make()
        remember(overflow, event)
        Queue.offerUnsafe(feed, { _tag: "Overflow" })
        return
      }
      outstandingDetails += 1
      rememberSelection(event)
    }
    const recoveryEvents = (state: InteractiveFeedOverflow.State, reason: string) =>
      InteractiveFeedOverflow.events(state, selectionEpoch, reason)
    const genericRecovery = (reason: string) => {
      const state = InteractiveFeedOverflow.make()
      if (selectedThreadId !== undefined) {
        state.transcriptThreadIds.add(selectedThreadId)
        state.queueThreadIds.add(selectedThreadId)
      }
      return recoveryEvents(state, reason)
    }
    const sendNew = (
      makeMessage: (sequence: number) => ResidentService.ServerMessage,
      detail: boolean,
      barrier: boolean,
    ) =>
      Effect.gen(function* () {
        yield* Queue.take(sendPermits)
        const sequence = yield* feedAdmission.withPermits(1)(
          Effect.sync(() => {
            const current = nextSequence
            nextSequence += 1
            highestSent = current
            return current
          }),
        )
        const message = makeMessage(sequence)
        const frames = yield* Effect.try({
          try: () => serverMessageFrames(`${feedGeneration}:${sequence}`, message),
          catch: (error) =>
            ProductOperation.OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: String(error),
            }),
        })
        replayWindow.set(sequence, { frames, detail, barrier })
        if (barrier) replayFloor = sequence
        if (frames.length > 1)
          yield* Effect.logInfo("resident.feed.message_fragmented").pipe(
            Effect.annotateLogs({
              "rika.resident.feed.sequence": sequence,
              "rika.resident.feed.fragments": frames.length,
            }),
          )
        yield* route.sendFrames(frames)
        return sequence
      })
    const sendBarrier = (events: ReadonlyArray<InteractiveEvent.InteractiveEvent>) =>
      Effect.gen(function* () {
        const sequence = yield* sendNew(
          (messageSequence) => ({
            _tag: "interactive-feed-resync",
            connectionId: route.connectionId,
            requestId,
            sessionId,
            feedGeneration,
            sequence: messageSequence,
            events,
          }),
          false,
          true,
        )
        yield* Effect.logInfo("resident.feed.barrier_sent")
        const acknowledged = yield* Deferred.make<void>()
        const alreadyAcknowledged = yield* feedAdmission.withPermits(1)(
          Effect.sync(() => {
            if (acknowledgedThrough >= sequence) return true
            barrierAcknowledgements.set(sequence, acknowledged)
            return false
          }),
        )
        if (!alreadyAcknowledged) yield* Deferred.await(acknowledged)
      })
    const sender = Effect.gen(function* () {
      while (true) {
        const item = yield* Queue.take(feed)
        if (item._tag === "Event")
          yield* sendNew(
            (sequence) => ({
              _tag: "interactive-feed-event",
              connectionId: route.connectionId,
              requestId,
              sessionId,
              feedGeneration,
              sequence,
              event: item.event,
            }),
            true,
            false,
          )
        else if (item._tag === "Replay") {
          const outsideWindow = item.afterSequence < replayFloor - 1
          if (outsideWindow) {
            const retainedBarrier = replayWindow.get(replayFloor)
            if (retainedBarrier !== undefined && retainedBarrier.barrier)
              yield* route.sendFrames(retainedBarrier.frames)
            else
              yield* sendBarrier(
                genericRecovery("Resident replay request fell outside its bounded current-session window"),
              )
          } else
            for (const [sequence, frame] of replayWindow)
              if (sequence > item.afterSequence && sequence >= replayFloor) yield* route.sendFrames(frame.frames)
        }
        if (item._tag === "Event") {
          sentDetails += 1
          if (sentDetails % 1_024 === 0)
            yield* Effect.logInfo("resident.feed.detail_sent").pipe(
              Effect.annotateLogs({
                "rika.resident.feed.sent": sentDetails,
                "rika.resident.feed.queued": yield* Queue.size(feed),
                "rika.resident.feed.overflowed": overflow !== undefined,
              }),
            )
        }
        if ((yield* Queue.size(feed)) === 0 && overflow !== undefined) {
          const state = overflow
          const reason = state.criticalOverflowed
            ? "Resident event feed exceeded its bounded non-recoverable event capacity"
            : "Resident event feed exceeded its bounded current-session window"
          const events = recoveryEvents(state, reason)
          const barrierWindow = InteractiveFeedOverflow.make()
          overflow = barrierWindow
          yield* sendBarrier(state.criticalOverflowed ? [...events, ...genericRecovery(reason)] : events)
          if (state.criticalOverflowed)
            return yield* ProductOperation.OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: reason,
            })
          if (overflow === barrierWindow) {
            overflow = undefined
            for (const event of recoveryEvents(barrierWindow, reason)) dispatch(event)
          }
        }
      }
    })
    const acknowledge = (throughSequence: number) =>
      feedAdmission.withPermits(1)(
        Effect.gen(function* () {
          if (throughSequence <= acknowledgedThrough) return true
          if (throughSequence > highestSent) return false
          let released = 0
          for (const [sequence, frame] of replayWindow) {
            if (sequence > throughSequence) break
            replayWindow.delete(sequence)
            released += 1
            if (frame.detail) outstandingDetails -= 1
          }
          acknowledgedThrough = throughSequence
          for (const [sequence, acknowledged] of barrierAcknowledgements) {
            if (sequence > throughSequence) break
            barrierAcknowledgements.delete(sequence)
            yield* Deferred.succeed(acknowledged, undefined)
          }
          for (let index = 0; index < released; index += 1) yield* Queue.offer(sendPermits, undefined)
          return true
        }),
      )
    const residentSession: ResidentSession = {
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
      replay: (afterSequence) => Queue.offer(feed, { _tag: "Replay", afterSequence }).pipe(Effect.asVoid),
    }
    route.sessions.set(sessionId, residentSession)
    yield* route.send(
      json({
        _tag: "interactive-started",
        connectionId: route.connectionId,
        requestId,
        sessionId,
        feedGeneration,
        feedCapacity: options.outboundCapacity,
      } satisfies ResidentService.ServerMessage),
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
