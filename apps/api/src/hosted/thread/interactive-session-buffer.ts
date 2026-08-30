import { Clock, DateTime, Deferred, Effect, Queue, type Scope } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { executeInteractiveCommand, type InteractiveInvocation } from "@rika/product/interactive-command"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import { ThreadId as HostedThreadId, type OwnerId } from "@rika/product/hosted-model"
import { isDurableThreadEvent, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import type { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import { ThreadId } from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import type { HostedThreadApplicationError, HostedInteractiveBatch } from "./application"

export interface PendingInteractiveInvocation extends InteractiveInvocation {
  readonly events: Array<InteractiveEvent>
  readonly completed: Deferred.Deferred<HostedInteractiveBatch, ProductOperation.OperationUnavailable>
}

type MutableHostedInteractiveBatch = { -readonly [Key in keyof HostedInteractiveBatch]: HostedInteractiveBatch[Key] }

export interface HostedInteractiveSession {
  readonly queue: Queue.Queue<PendingInteractiveInvocation, ProductOperation.OperationUnavailable>
  readonly ready: Deferred.Deferred<void, ProductOperation.OperationUnavailable>
  readonly executorKind: HostedThreadSnapshot["executorKind"]
  session: InteractiveSession | undefined
  invocation: PendingInteractiveInvocation | undefined
}

interface PendingBackgroundEvent {
  readonly ownerId: OwnerId
  readonly threadId: HostedThreadId
  readonly event: InteractiveEvent
  readonly snapshot?: HostedThreadSnapshot
  readonly persisted: Deferred.Deferred<void, HostedThreadApplicationError>
}

const pendingAuthorizations = (
  threadId: HostedThreadId,
  view: ThreadView.ThreadViewSnapshot,
  checkpoint: (turnId: string) => ExecutionProjection.Checkpoint | undefined,
): HostedThreadSnapshot["pendingAuthorizations"] | undefined => {
  const pending: Array<HostedThreadSnapshot["pendingAuthorizations"][number]> = []
  for (const turn of view.turns) {
    const currentCheckpoint = checkpoint(String(turn.turn.id))
    for (const unit of turn.units) {
      if (
        unit.content._tag !== "Block" ||
        unit.content.block._tag !== "AuthorizationCard" ||
        unit.content.block.status !== "pending"
      )
        continue
      if (currentCheckpoint === undefined) return undefined
      pending.push({
        threadId,
        turnId: turn.turn.id,
        authorizationId: unit.content.block.id,
        operation: unit.content.block.operation,
        capability: unit.content.block.capability,
        input: unit.content.block.input,
        inputTruncated: unit.content.block.inputTruncated,
        checkpoint: currentCheckpoint,
      })
    }
  }
  return pending
}

const sessionSnapshot = (
  executorKind: HostedThreadSnapshot["executorKind"],
  threadId: HostedThreadId,
  session: InteractiveSession,
): HostedThreadSnapshot | undefined => {
  const view = session.currentView()
  if (view === undefined) return undefined
  const authorizations = pendingAuthorizations(threadId, view, session.projectionCheckpoint)
  return authorizations === undefined ? undefined : { executorKind, view, pendingAuthorizations: authorizations }
}

export const interactiveSessionSnapshot = { pendingAuthorizations, sessionSnapshot }

export const interactiveSessionBuffer = Effect.fn("HostedThreadApplication.interactiveSessionBuffer")(
  function* (options: {
    readonly store: ThreadProtocolStore["Service"]
    readonly ownerScope: Scope.Scope
    readonly withProjectionAdmission: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    readonly applicationFailure: (error: { readonly message: string }) => HostedThreadApplicationError
  }) {
    const sessions = new Map<string, HostedInteractiveSession>()
    const projectionTails = new Map<string, Deferred.Deferred<void, HostedThreadApplicationError>>()
    const backgroundEvents = yield* Queue.unbounded<PendingBackgroundEvent>()
    const awaitProjection = (key: string): Effect.Effect<void, HostedThreadApplicationError> =>
      Effect.suspend(() => {
        const current = projectionTails.get(key)
        return current === undefined ? Effect.void : Deferred.await(current).pipe(Effect.andThen(awaitProjection(key)))
      })
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          const current = yield* Queue.take(backgroundEvents)
          const key = `${current.ownerId}:${current.threadId}`
          const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          const result = yield* options
            .withProjectionAdmission(
              key,
              Effect.gen(function* () {
                const input = {
                  ownerId: current.ownerId,
                  threadId: current.threadId,
                  events: [current.event],
                  createdAt,
                } satisfies Parameters<typeof options.store.appendEvents>[0]
                if (current.snapshot !== undefined) Object.assign(input, { snapshot: current.snapshot })
                yield* options.store.appendEvents(input)
              }),
            )
            .pipe(Effect.mapError(options.applicationFailure), Effect.result)
          if (result._tag === "Success") yield* Deferred.succeed(current.persisted, undefined)
          else yield* Deferred.fail(current.persisted, result.failure)
          if (projectionTails.get(key) === current.persisted) projectionTails.delete(key)
        }
      }),
      options.ownerScope,
    )
    const runInteractive = (
      ownerId: OwnerId,
      input: Extract<ProductOperation.Input, { readonly _tag: "Interactive" }>,
      session: InteractiveSession,
    ) => {
      const threadId = ThreadId.make(input.threadId!)
      const hostedThreadId = HostedThreadId.make(input.threadId!)
      const key = `${ownerId}:${threadId}`
      const state = sessions.get(key)!
      return Effect.scoped(
        Effect.gen(function* () {
          state.session = session
          yield* Effect.forkScoped(
            session
              .events((event) => {
                const invocation = state.invocation
                if (invocation === undefined) {
                  if (event._tag === "ThreadViewSnapshot" && event.snapshot.thread.id === threadId)
                    Deferred.doneUnsafe(state.ready, Effect.void)
                  else if (event._tag === "ExecutionFailed")
                    Deferred.doneUnsafe(
                      state.ready,
                      Effect.fail(
                        ProductOperation.OperationUnavailable.make({
                          operation: "InteractiveSession.selectThread",
                          message: event.failure.message,
                        }),
                      ),
                    )
                  if (isDurableThreadEvent(event)) {
                    const persisted = Deferred.makeUnsafe<void, HostedThreadApplicationError>()
                    projectionTails.set(key, persisted)
                    const snapshot = sessionSnapshot(state.executorKind, hostedThreadId, session)
                    const pending = {
                      ownerId,
                      threadId: hostedThreadId,
                      event,
                      persisted,
                    } satisfies PendingBackgroundEvent
                    if (snapshot !== undefined) Object.assign(pending, { snapshot })
                    Queue.offerUnsafe(backgroundEvents, pending)
                  }
                } else invocation.events.push(event)
              })
              .pipe(Effect.tapError((error) => Deferred.fail(state.ready, error))),
          )
          yield* session.selectThread(input.threadId!)
          yield* Deferred.await(state.ready)
          while (true) {
            const invocation = yield* Queue.take(state.queue)
            yield* Effect.gen(function* () {
              state.invocation = invocation
              const result = yield* executeInteractiveCommand(session, invocation).pipe(Effect.result)
              yield* Effect.yieldNow
              state.invocation = undefined
              const snapshot = sessionSnapshot(state.executorKind, hostedThreadId, session)
              if (snapshot === undefined)
                return yield* ProductOperation.OperationUnavailable.make({
                  operation: "InteractiveSession",
                  message: "Thread checkpoint is unavailable",
                })
              const batch: MutableHostedInteractiveBatch = { events: invocation.events, snapshot }
              if (result._tag === "Failure") batch.failure = result.failure
              yield* Deferred.succeed(invocation.completed, batch)
            }).pipe(
              Effect.catch((error) => Deferred.fail(invocation.completed, error)),
              Effect.ensuring(Effect.sync(() => (state.invocation = undefined))),
            )
          }
        }),
      )
    }
    return { sessions, awaitProjection, runInteractive }
  },
)
