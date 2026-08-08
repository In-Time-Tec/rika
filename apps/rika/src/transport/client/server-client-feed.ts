import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import * as ServerFeed from "@rika/product/server-interactive-feed"
import * as ServerService from "@rika/product/server-service"
import { clientMessageFrames } from "@rika/server/server-message-codec"
import { Deferred, Effect, Function, Queue, Schema } from "effect"

const traceInteractiveEventImpl = (name: string, seen: Set<string>, event: InteractiveEvent.InteractiveEvent) => {
  if (event._tag !== "ThreadViewPatch") return Effect.void
  const key = `${event.patch.threadId}:${event.patch.revision}`
  if (seen.has(key)) return Effect.void
  seen.add(key)
  return Effect.logInfo(name).pipe(
    Effect.annotateLogs({
      "rika.thread.id": String(event.patch.threadId),
      "rika.thread_view.revision": event.patch.revision,
    }),
  )
}

export const traceInteractiveEvent: {
  (
    seen: Set<string>,
    event: InteractiveEvent.InteractiveEvent,
  ): (name: string) => ReturnType<typeof traceInteractiveEventImpl>
  (
    name: string,
    seen: Set<string>,
    event: InteractiveEvent.InteractiveEvent,
  ): ReturnType<typeof traceInteractiveEventImpl>
} = Function.dual(3, traceInteractiveEventImpl)

export type ClientRequest = {
  readonly done: Deferred.Deferred<void, ProductOperation.OperationUnavailable>
  readonly stdout?: (text: string) => Effect.Effect<void>
  readonly stderr?: (text: string) => Effect.Effect<void>
  readonly interactive?: (
    input: ServerFeed.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
  ) => Effect.Effect<void, ProductOperation.OperationUnavailable>
  readonly interactiveStarted?: Deferred.Deferred<{
    readonly sessionId: string
    readonly feedGeneration: string
    readonly session: InteractiveSession.InteractiveSession
  }>
  readonly input: ProductOperation.Input
  readonly commands: Map<number, Deferred.Deferred<void, ProductOperation.OperationUnavailable>>
  feed?: PhysicalFeed
}

export type InteractiveFeedFrame = Extract<ServerService.ServerMessage, { readonly _tag: "interactive-feed-event" }>

export type PhysicalFeed = {
  readonly sessionId: string
  readonly generation: string
  readonly frames: Queue.Queue<InteractiveFeedFrame>
  expectedSequence: number
  consumerAttached: boolean
}

export const makeClientMessageWriter =
  (
    write: (
      frame: string | import("effect/unstable/socket/Socket").CloseEvent,
    ) => Effect.Effect<void, ServerService.ServerServiceError>,
  ) =>
  (messageId: string, message: ServerService.ClientMessage) =>
    Effect.try({
      try: () => clientMessageFrames(messageId, message),
      catch: (error) =>
        Schema.is(ServerService.ServerServiceError)(error)
          ? error
          : ServerService.ServerServiceError.make({
              reason: "transport-failed",
              message: String(error),
            }),
    }).pipe(Effect.flatMap(Effect.forEach((frame) => write(frame), { discard: true })))

const makePhysicalFeedImpl = (sessionId: string, generation: string, capacity: number): Effect.Effect<PhysicalFeed> =>
  Effect.gen(function* () {
    return {
      sessionId,
      generation,
      frames: yield* Queue.bounded<InteractiveFeedFrame>(capacity),
      expectedSequence: 1,
      consumerAttached: false,
    }
  })

export const makePhysicalFeed: {
  (generation: string, capacity: number): (sessionId: string) => Effect.Effect<PhysicalFeed>
  (sessionId: string, generation: string, capacity: number): Effect.Effect<PhysicalFeed>
} = Function.dual(3, makePhysicalFeedImpl)
