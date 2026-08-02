import * as InteractiveSession from "@rika/product/interactive-session"
import * as InteractiveEvent from "@rika/product/interactive-event"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import * as ProductOperation from "@rika/product/product-operation"
import * as ResidentService from "@rika/product/resident-service"
import { Deferred, Effect, Queue } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { json } from "../protocol/resident-protocol"
import type { PhysicalFeed } from "./resident-client-feed"

type SessionOptions = {
  readonly feed: PhysicalFeed
  readonly closed: Deferred.Deferred<void>
  readonly invoke: (command: InteractiveCommand) => Effect.Effect<void, ProductOperation.OperationUnavailable>
  readonly write: (frame: string | Socket.CloseEvent) => Effect.Effect<void, ResidentService.ResidentServiceError>
  readonly unavailable: (message: string) => ProductOperation.OperationUnavailable
  readonly traceEvent: (event: InteractiveEvent.InteractiveEvent, seen: Set<string>) => Effect.Effect<void>
}

export const makeInteractiveSession = (options: SessionOptions): InteractiveSession.InteractiveSession => {
  const { feed, closed, invoke, write, unavailable, traceEvent } = options
  const dispatchedDeltas = new Set<string>()
  return {
    events: (dispatch) =>
      Effect.suspend(() => {
        if (feed.consumerAttached)
          return Effect.fail(
            ProductOperation.OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: "Interactive session already has an event consumer",
            }),
          )
        feed.consumerAttached = true
        const consume = Effect.gen(function* () {
          while (true) {
            const frames = yield* Queue.takeAll(feed.frames)
            const batchTails = new Map<string, (typeof frames)[number]>()
            for (const queued of frames) {
              yield* Effect.uninterruptible(
                Effect.sync(() => {
                  if (queued._tag === "interactive-feed-event") dispatch(queued.event)
                  else for (const event of queued.events) dispatch(event)
                }).pipe(
                  Effect.andThen(
                    queued._tag === "interactive-feed-event" ? traceEvent(queued.event, dispatchedDeltas) : Effect.void,
                  ),
                ),
              )
              batchTails.set(
                `${queued.connectionId}\0${queued.requestId}\0${queued.sessionId}\0${queued.feedGeneration}`,
                queued,
              )
            }
            for (const queued of batchTails.values()) {
              yield* Effect.uninterruptible(
                write(
                  json({
                    _tag: "interactive-feed-ack",
                    connectionId: queued.connectionId,
                    requestId: queued.requestId,
                    sessionId: queued.sessionId,
                    feedGeneration: queued.feedGeneration,
                    throughSequence: queued.sequence,
                  } satisfies ResidentService.ClientMessage),
                ).pipe(Effect.mapError((error) => unavailable(error.message))),
              )
              if (queued.sequence % 1_024 === 0)
                yield* Effect.logInfo("resident.feed.ack_consumed").pipe(
                  Effect.annotateLogs("rika.resident.feed.sequence", queued.sequence),
                )
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              feed.consumerAttached = false
            }),
          ),
        )
        return Effect.raceFirst(
          consume,
          Deferred.await(closed).pipe(Effect.andThen(Effect.fail(unavailable("Resident connection closed")))),
        )
      }),
    submit: (prompt, mode, promptParts, modelTuning) =>
      invoke({
        _tag: "Submit",
        prompt,
        ...(mode === undefined ? {} : { mode }),
        ...(promptParts === undefined ? {} : { promptParts }),
        ...(modelTuning === undefined ? {} : { modelTuning }),
      }),
    shell: (threadId, command, incognito) =>
      invoke({
        _tag: "Shell",
        ...(threadId === undefined ? {} : { threadId }),
        command,
        incognito,
      }),
    editQueued: (turnId, prompt) => invoke({ _tag: "EditQueued", turnId, prompt }),
    dequeue: (turnId) => invoke({ _tag: "Dequeue", turnId }),
    steerQueued: (turnId, text) => invoke({ _tag: "SteerQueued", turnId, text }),
    steer: (text) => invoke({ _tag: "Steer", text }),
    interruptAndSend: (prompt) => invoke({ _tag: "InterruptAndSend", prompt }),
    cancel: invoke({ _tag: "Cancel" }),
    quit: invoke({ _tag: "Quit" }),
    newThread: invoke({ _tag: "NewThread" }),
    selectThread: (threadId, selectionEpoch) => invoke({ _tag: "SelectThread", threadId, selectionEpoch }),
    readQueue: (threadId) => invoke({ _tag: "ReadQueue", threadId }),
    loadOlder: (threadId, selectionEpoch, before, loadedKeys) =>
      invoke({ _tag: "LoadOlder", threadId, selectionEpoch, before, loadedKeys }),
    loadNewer: (threadId, selectionEpoch, after) => invoke({ _tag: "LoadNewer", threadId, selectionEpoch, after }),
    previewThread: (threadId) => invoke({ _tag: "PreviewThread", threadId }),
    reopenThread: (selectionEpoch) => invoke({ _tag: "ReopenThread", selectionEpoch }),
  }
}
