import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import * as ResidentFeed from "@rika/product/resident-interactive-feed"
import * as ResidentService from "@rika/product/resident-service"
import { clientMessageFrames } from "../protocol/resident-message-codec"
import { Deferred, Effect, Queue, Schema } from "effect"

const tracedEventTypes = new Set([
  "model.reasoning.delta",
  "model.output.delta",
  "model.toolcall.delta",
  "tool.call.requested",
  "tool.result.received",
])

export const traceInteractiveEvent = (
  name: string,
  seenDeltas: Set<string>,
  event: InteractiveEvent.InteractiveEvent,
) => {
  if (
    event._tag !== "TranscriptProjectionPatched" ||
    event.origin._tag !== "Event" ||
    !tracedEventTypes.has(event.origin.type)
  )
    return Effect.void
  const delta = event.origin.type.endsWith(".delta")
  const key = `${event.rootTurnId}:${event.origin.type}`
  if (delta && seenDeltas.has(key)) return Effect.void
  if (delta) seenDeltas.add(key)
  return Effect.logInfo(name).pipe(
    Effect.annotateLogs({
      "rika.event.cursor": event.origin.cursor,
      "rika.event.type": event.origin.type,
      "rika.thread.id": String(event.threadId),
      "rika.turn.id": String(event.rootTurnId),
    }),
  )
}

export type ClientRequest = {
  readonly done: Deferred.Deferred<void, ProductOperation.OperationUnavailable>
  readonly stdout?: (text: string) => Effect.Effect<void>
  readonly stderr?: (text: string) => Effect.Effect<void>
  readonly interactive?: (
    input: ResidentFeed.InteractiveInput,
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

export type InteractiveFeedFrame = Extract<
  ResidentService.ServerMessage,
  { readonly _tag: "interactive-feed-event" | "interactive-feed-resync" }
>

export type PhysicalFeed = {
  readonly sessionId: string
  readonly generation: string
  readonly frames: Queue.Queue<InteractiveFeedFrame>
  expectedSequence: number
  replayRequestedAfter: number | undefined
  consumerAttached: boolean
}

export const makeClientMessageWriter =
  (
    write: (
      frame: string | import("effect/unstable/socket/Socket").CloseEvent,
    ) => Effect.Effect<void, ResidentService.ResidentServiceError>,
  ) =>
  (messageId: string, message: ResidentService.ClientMessage) =>
    Effect.try({
      try: () => clientMessageFrames(messageId, message),
      catch: (error) =>
        Schema.is(ResidentService.ResidentServiceError)(error)
          ? error
          : ResidentService.ResidentServiceError.make({
              reason: "transport-failed",
              message: String(error),
            }),
    }).pipe(Effect.flatMap(Effect.forEach((frame) => write(frame), { discard: true })))

export const makePhysicalFeed = (
  sessionId: string,
  generation: string,
  capacity: number,
): Effect.Effect<PhysicalFeed> =>
  Effect.gen(function* () {
    return {
      sessionId,
      generation,
      frames: yield* Queue.bounded<InteractiveFeedFrame>(capacity),
      expectedSequence: 1,
      replayRequestedAfter: undefined,
      consumerAttached: false,
    }
  })
