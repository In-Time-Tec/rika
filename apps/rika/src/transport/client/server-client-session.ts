import * as InteractiveSession from "@rika/product/interactive-session"
import * as InteractiveEvent from "@rika/product/interactive-event"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import * as ProductOperation from "@rika/product/product-operation"
import * as ServerService from "@rika/product/server-service"
import { Deferred, Effect, Queue } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { json } from "@rika/server/server-protocol"
import type { PhysicalFeed } from "./server-client-feed"

type SessionOptions = {
  readonly feed: PhysicalFeed
  readonly closed: Deferred.Deferred<void>
  readonly invoke: (command: InteractiveCommand) => Effect.Effect<void, ProductOperation.OperationUnavailable>
  readonly write: (frame: string | Socket.CloseEvent) => Effect.Effect<void, ServerService.ServerServiceError>
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
                Effect.sync(() => dispatch(queued.event)).pipe(
                  Effect.andThen(traceEvent(queued.event, dispatchedDeltas)),
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
                  } satisfies ServerService.ClientMessage),
                ).pipe(Effect.mapError((error) => unavailable(error.message))),
              )
              if (queued.sequence % 1_024 === 0)
                yield* Effect.logInfo("server.feed.ack_consumed").pipe(
                  Effect.annotateLogs("rika.server.feed.sequence", queued.sequence),
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
          Deferred.await(closed).pipe(Effect.andThen(Effect.fail(unavailable("Server connection closed")))),
        )
      }),
    submit: (prompt, mode, promptParts, modelTuning, submissionId) =>
      invoke({
        _tag: "Submit",
        prompt,
        ...(mode === undefined ? {} : { mode }),
        ...(promptParts === undefined ? {} : { promptParts }),
        ...(modelTuning === undefined ? {} : { modelTuning }),
        ...(submissionId === undefined ? {} : { submissionId }),
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
    steer: (text, turnId) => invoke({ _tag: "Steer", text, ...(turnId === undefined ? {} : { turnId }) }),
    approveAuthorization: (turnId, authorizationId) =>
      invoke({ _tag: "ApproveAuthorization", turnId, authorizationId }),
    denyAuthorization: (turnId, authorizationId) => invoke({ _tag: "DenyAuthorization", turnId, authorizationId }),
    interruptAndSend: (prompt) => invoke({ _tag: "InterruptAndSend", prompt }),
    cancel: invoke({ _tag: "Cancel" }),
    quit: invoke({ _tag: "Quit" }),
    newThread: invoke({ _tag: "NewThread" }),
    selectThread: (threadId) => invoke({ _tag: "SelectThread", threadId }),
    readQueue: (threadId) => invoke({ _tag: "ReadQueue", threadId }),
    previewThread: (threadId) => invoke({ _tag: "PreviewThread", threadId }),
    reopenThread: invoke({ _tag: "ReopenThread" }),
  }
}
