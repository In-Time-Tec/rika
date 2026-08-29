import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Layer,
  LayerMap,
  Queue,
  RcMap,
  Schema,
  Semaphore,
} from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as GoalService from "@rika/product/goal-service"
import { ThreadId as HostedThreadId, type OwnerId } from "@rika/product/hosted-model"
import { executeInteractiveCommand, type InteractiveInvocation } from "@rika/product/interactive-command"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { makeThreadViewFeed } from "@rika/product/interactive-thread-view-feed"
import { operationError } from "@rika/product/operation-error"
import * as ProductOperation from "@rika/product/product-operation"
import * as ProductOperationService from "@rika/product/product-operation-service"
import { ThreadId, type Thread } from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import type { ThreadSummary } from "@rika/product/thread-summary"
import { TurnId, type Turn } from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { isDurableThreadEvent, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import * as ProductRepositories from "@rika/product-store/product-repositories"
import { identityKey } from "@rika/transcript/transcript-unit-identity"
import type { Unit } from "@rika/transcript/transcript-unit"
import { HostedModelRegistry } from "../environment/model-registry"

export class HostedThreadApplicationError extends Schema.TaggedError<HostedThreadApplicationError>()(
  "HostedThreadApplicationError",
  { message: Schema.String },
) {}

export interface HostedThreadApplicationService {
  readonly threads: (
    ownerId: OwnerId,
    projectId?: string,
  ) => Effect.Effect<ReadonlyArray<ThreadSummary>, HostedThreadApplicationError>
  readonly preview: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Unit>, HostedThreadApplicationError>
  readonly thread: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<Thread | undefined, HostedThreadApplicationError>
  readonly interactive: <A, E, R>(
    input: InteractiveInvocation & {
      readonly ownerId: OwnerId
      readonly threadId: ThreadId
    },
    persist: (batch: HostedInteractiveBatch) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, HostedThreadApplicationError | E, R>
  readonly snapshot: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<HostedThreadSnapshot, HostedThreadApplicationError>
  readonly projectionCommitted: (threadId: ThreadId) => Effect.Effect<void, HostedThreadApplicationError>
}

export class HostedThreadApplication extends Context.Service<HostedThreadApplication, HostedThreadApplicationService>()(
  "@rika/api/hosted/thread/application/HostedThreadApplication",
) {}

interface PendingInteractiveInvocation extends InteractiveInvocation {
  readonly events: Array<InteractiveEvent>
  readonly completed: Deferred.Deferred<HostedInteractiveBatch, ProductOperation.OperationUnavailable>
}

export interface HostedInteractiveBatch {
  readonly events: ReadonlyArray<InteractiveEvent>
  readonly snapshot: HostedThreadSnapshot
  readonly failure?: ProductOperation.OperationUnavailable
}

type MutableHostedInteractiveBatch = { -readonly [Key in keyof HostedInteractiveBatch]: HostedInteractiveBatch[Key] }

interface HostedInteractiveSession {
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

const promptUnit = (turn: Turn): Unit => {
  const key = identityKey("turn", turn.id, "user")
  return {
    key,
    turnId: String(turn.id),
    order: [{ sequence: -1, part: 0, key }],
    revision: 0,
    content: { _tag: "Entry", role: "user", text: turn.prompt },
  }
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

const ownerLayer = (
  ownerId: OwnerId,
  resolveExecutionRoute: NonNullable<
    Parameters<typeof ProductOperationService.productLayer>[0]["resolveExecutionRoute"]
  >,
  runInteractive: (
    input: Extract<ProductOperation.Input, { readonly _tag: "Interactive" }>,
    session: InteractiveSession,
  ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
) => {
  const repositories = ProductRepositories.layer(ownerId)
  return Layer.unwrap(
    Effect.gen(function* () {
      const repositoryContext = yield* Layer.build(repositories)
      const goals = Context.get(
        yield* Layer.build(GoalService.layer.pipe(Layer.provide(Layer.succeedContext(repositoryContext)))),
        GoalService.GoalService,
      )
      const crypto = yield* Crypto.Crypto
      const gateway = yield* ExecutionGateway.Service
      const lifecycle = yield* ExecutionSessionLifecycle.Service
      const operations = ProductOperationService.productLayer({
        goals,
        repositoryLayer: Layer.succeedContext(repositoryContext),
        turnRepositoryLayer: Layer.succeedContext(repositoryContext),
        threadSummaryRepositoryLayer: Layer.succeedContext(repositoryContext),
        transcriptRepositoryLayer: Layer.succeedContext(repositoryContext),
        backendLayer: Layer.succeed(ExecutionGateway.Service, gateway),
        executionProjectionOwner: "external",
        executionSessionLifecycleLayer: Layer.succeed(ExecutionSessionLifecycle.Service, lifecycle),
        defaultWorkspace: "hosted",
        resolveExecutionRoute,
        makeThreadId: crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(ThreadId.make)),
        makeTurnId: crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(TurnId.make)),
        interactive: runInteractive,
      })
      return Layer.merge(operations, Layer.succeedContext(repositoryContext)).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(Effect.fail(HostedThreadApplicationError.make({ message: String(cause) }))),
        ),
      )
    }),
  )
}

export const layer = Layer.effect(
  HostedThreadApplication,
  Effect.gen(function* () {
    const hosted = yield* HostedClientAuthority
    const store = yield* ThreadProtocolStore
    const modelRegistry = yield* HostedModelRegistry
    const ownerScope = yield* Effect.scope
    const projectionAdmissions = yield* RcMap.make({
      lookup: () => Semaphore.make(1),
    })
    const interactiveSessions = new Map<string, HostedInteractiveSession>()
    const projectionTails = new Map<string, Deferred.Deferred<void, HostedThreadApplicationError>>()
    const backgroundEvents = yield* Queue.unbounded<PendingBackgroundEvent>()
    const withProjectionAdmission = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        RcMap.get(projectionAdmissions, key).pipe(Effect.flatMap((admission) => admission.withPermits(1)(effect))),
      )
    const applicationFailure = (error: { readonly message: string }) =>
      HostedThreadApplicationError.make({
        message: error.message,
      })
    const awaitProjection = (key: string): Effect.Effect<void, HostedThreadApplicationError> =>
      Effect.suspend(() => {
        const current = projectionTails.get(key)
        return current === undefined ? Effect.void : Deferred.await(current).pipe(Effect.andThen(awaitProjection(key)))
      })
    const ownerRepositories = yield* LayerMap.make((ownerId: OwnerId) => ProductRepositories.layer(ownerId))
    const repositorySnapshot = Effect.fn("HostedThreadApplication.repositorySnapshot")(function* (
      ownerId: OwnerId,
      threadId: ThreadId,
    ) {
      return yield* Effect.scoped(
        ownerRepositories.contextEffect(ownerId).pipe(
          Effect.flatMap((context) =>
            Effect.gen(function* () {
              const threads = Context.get(context, ThreadRepository.Service)
              const turns = Context.get(context, TurnRepository.Service)
              const transcripts = Context.get(context, TranscriptRepository.Service)
              const thread = yield* threads.get(threadId)
              if (thread === undefined)
                return yield* HostedThreadApplicationError.make({ message: "Thread is unavailable" })
              const hostedThread = yield* hosted.readThread({ ownerId, threadId: HostedThreadId.make(threadId) })
              if (hostedThread === undefined)
                return yield* HostedThreadApplicationError.make({ message: "Thread is unavailable" })
              const queue = yield* turns.readQueue(threadId)
              const page = yield* transcripts.page(threadId, {
                limit: ThreadView.limits.patchItems,
                projectionVersion: ExecutionProjection.projectionVersion,
              })
              const active = yield* turns.findActive(threadId)
              const activeProjection = active === undefined ? undefined : yield* transcripts.get(active.id)
              const loadedAt = yield* Clock.currentTimeMillis
              const feed = makeThreadViewFeed(() => loadedAt)
              const loaded: Extract<Parameters<typeof feed.publish>[0], { readonly _tag: "SelectionLoaded" }> = {
                _tag: "SelectionLoaded",
                selectionEpoch: 0,
                activitySequence: 0,
                thread,
                entries: page.entries,
                hasOlder: page.hasOlder,
                hasNewer: page.hasNewer,
                usage: page.usage,
                queueRevision: queue.revision,
                queuedCount: queue.queuedCount,
                queue: queue.turns.map((turn) => ({ id: turn.id, prompt: turn.prompt, createdAt: turn.createdAt })),
                projectionCheckpoints:
                  activeProjection?.projectorCheckpoint === undefined
                    ? []
                    : [{ turnId: activeProjection.turn.id, checkpoint: activeProjection.projectorCheckpoint }],
              }
              if (page.oldestCursor !== undefined) Object.assign(loaded, { oldestCursor: page.oldestCursor })
              if (page.newestCursor !== undefined) Object.assign(loaded, { newestCursor: page.newestCursor })
              if (active !== undefined) Object.assign(loaded, { activeTurn: active })
              feed.publish(loaded)
              const view = feed.current()
              if (view === undefined)
                return yield* HostedThreadApplicationError.make({ message: "Thread checkpoint is invalid" })
              const authorizations = pendingAuthorizations(HostedThreadId.make(threadId), view, (turnId) =>
                activeProjection !== undefined && turnId === String(activeProjection.turn.id)
                  ? activeProjection.projectorCheckpoint
                  : undefined,
              )
              if (authorizations === undefined)
                return yield* HostedThreadApplicationError.make({
                  message: "Pending authorization has no durable execution checkpoint",
                })
              return {
                executorKind: hostedThread.executorKind,
                view,
                pendingAuthorizations: authorizations,
              }
            }).pipe(Effect.provide(context)),
          ),
          Effect.mapError((error) =>
            Schema.is(HostedThreadApplicationError)(error) ? error : applicationFailure(error),
          ),
        ),
      )
    })
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          const current = yield* Queue.take(backgroundEvents)
          const key = `${current.ownerId}:${current.threadId}`
          const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          const result = yield* withProjectionAdmission(
            key,
            Effect.gen(function* () {
              const input = {
                ownerId: current.ownerId,
                threadId: current.threadId,
                events: [current.event],
                createdAt,
              } satisfies Parameters<typeof store.appendEvents>[0]
              if (current.snapshot !== undefined) Object.assign(input, { snapshot: current.snapshot })
              yield* store.appendEvents(input)
            }),
          ).pipe(Effect.mapError(applicationFailure), Effect.result)
          if (result._tag === "Success") yield* Deferred.succeed(current.persisted, undefined)
          else yield* Deferred.fail(current.persisted, result.failure)
          if (projectionTails.get(key) === current.persisted) projectionTails.delete(key)
        }
      }),
      ownerScope,
    )
    const currentSnapshot = Effect.fn("HostedThreadApplication.currentSnapshot")(function* (
      ownerId: OwnerId,
      threadId: ThreadId,
    ) {
      const key = `${ownerId}:${threadId}`
      yield* awaitProjection(key)
      const state = interactiveSessions.get(key)
      const current =
        state?.session === undefined
          ? undefined
          : sessionSnapshot(state.executorKind, HostedThreadId.make(threadId), state.session)
      if (current !== undefined) return current
      return yield* repositorySnapshot(ownerId, threadId)
    })
    const runInteractive = (
      ownerId: OwnerId,
      input: Extract<ProductOperation.Input, { readonly _tag: "Interactive" }>,
      session: InteractiveSession,
    ) => {
      const threadId = ThreadId.make(input.threadId!)
      const hostedThreadId = HostedThreadId.make(input.threadId!)
      const state = interactiveSessions.get(`${ownerId}:${threadId}`)!
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
                    projectionTails.set(`${ownerId}:${threadId}`, persisted)
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
              const batch: MutableHostedInteractiveBatch = {
                events: invocation.events,
                snapshot,
              }
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
    const owners = yield* LayerMap.make((ownerId: OwnerId) =>
      ownerLayer(
        ownerId,
        (mode) =>
          modelRegistry.resolve(ownerId, mode).pipe(Effect.mapError((error) => operationError(error.message, error))),
        (input, session) => runInteractive(ownerId, input, session),
      ),
    )
    return HostedThreadApplication.of({
      threads: (ownerId, projectId) =>
        Effect.scoped(
          ownerRepositories.contextEffect(ownerId).pipe(
            Effect.flatMap((context) => Context.get(context, ThreadSummaryRepository.Service).list()),
            Effect.flatMap((summaries) =>
              projectId === undefined
                ? Effect.succeed(summaries)
                : Effect.filter(summaries, (summary) =>
                    hosted
                      .readThread({ ownerId, threadId: HostedThreadId.make(summary.id) })
                      .pipe(Effect.map((thread) => String(thread?.projectId) === projectId)),
                  ),
            ),
            Effect.mapError((error) => HostedThreadApplicationError.make({ message: String(error) })),
          ),
        ),
      preview: (ownerId, threadId) =>
        Effect.scoped(
          ownerRepositories.contextEffect(ownerId).pipe(
            Effect.flatMap((context) =>
              Effect.gen(function* () {
                const threads = Context.get(context, ThreadRepository.Service)
                const turns = Context.get(context, TurnRepository.Service)
                const transcripts = Context.get(context, TranscriptRepository.Service)
                const thread = yield* threads.get(threadId)
                if (thread === undefined)
                  return yield* HostedThreadApplicationError.make({ message: "Thread is unavailable" })
                const recent = yield* turns.listRecentNonqueued(thread.id, 4)
                const units = yield* Effect.forEach(recent, (turn) =>
                  transcripts.get(turn.id).pipe(
                    Effect.map((projection) => projection?.units ?? [promptUnit(turn)]),
                    Effect.orElseSucceed(() => [promptUnit(turn)]),
                  ),
                )
                return units.flat()
              }),
            ),
            Effect.mapError((error) =>
              Schema.is(HostedThreadApplicationError)(error)
                ? error
                : HostedThreadApplicationError.make({ message: String(error) }),
            ),
          ),
        ),
      thread: (ownerId, threadId) =>
        Effect.scoped(
          ownerRepositories.contextEffect(ownerId).pipe(
            Effect.flatMap((context) => Context.get(context, ThreadRepository.Service).get(threadId)),
            Effect.mapError((error) =>
              Schema.is(HostedThreadApplicationError)(error)
                ? error
                : HostedThreadApplicationError.make({ message: String(error) }),
            ),
          ),
        ),
      interactive: (input, persist) =>
        Effect.gen(function* () {
          const key = `${input.ownerId}:${input.threadId}`
          const initialSnapshot = yield* currentSnapshot(input.ownerId, input.threadId)
          return yield* withProjectionAdmission(
            key,
            Effect.gen(function* () {
              const batch = yield* Effect.scoped(
                owners.contextEffect(input.ownerId).pipe(
                  Effect.flatMap((context) =>
                    Effect.gen(function* () {
                      let state = interactiveSessions.get(key)
                      if (state === undefined) {
                        state = {
                          queue: yield* Queue.unbounded<
                            PendingInteractiveInvocation,
                            ProductOperation.OperationUnavailable
                          >(),
                          ready: yield* Deferred.make<void, ProductOperation.OperationUnavailable>(),
                          executorKind: initialSnapshot.executorKind,
                          session: undefined,
                          invocation: undefined,
                        }
                        interactiveSessions.set(key, state)
                        const current = state
                        yield* Effect.forkIn(
                          Context.get(context, ProductOperationService.Service)
                            .run({
                              _tag: "Interactive",
                              prompt: [],
                              threadId: input.threadId,
                              ephemeral: false,
                            })
                            .pipe(
                              Effect.catch((error) =>
                                Deferred.fail(current.ready, error).pipe(
                                  Effect.andThen(Queue.fail(current.queue, error)),
                                  Effect.asVoid,
                                ),
                              ),
                              Effect.ensuring(Effect.sync(() => interactiveSessions.delete(key))),
                            ),
                          ownerScope,
                        )
                        yield* Deferred.await(state.ready)
                      }
                      const invocation: PendingInteractiveInvocation = {
                        commandId: input.commandId,
                        turnId: input.turnId,
                        command: input.command,
                        events: [],
                        completed: yield* Deferred.make<
                          HostedInteractiveBatch,
                          ProductOperation.OperationUnavailable
                        >(),
                      }
                      yield* Queue.offer(state.queue, invocation)
                      return yield* Deferred.await(invocation.completed)
                    }),
                  ),
                ),
              ).pipe(
                Effect.catch((error) =>
                  Schema.is(ProductOperation.OperationUnavailable)(error)
                    ? Effect.succeed({ events: [], snapshot: initialSnapshot, failure: error })
                    : Effect.fail(Schema.is(HostedThreadApplicationError)(error) ? error : applicationFailure(error)),
                ),
              )
              return yield* persist(batch)
            }),
          )
        }),
      snapshot: currentSnapshot,
      projectionCommitted: (threadId) =>
        Effect.gen(function* () {
          const hostedThread = yield* hosted.findThread(HostedThreadId.make(threadId))
          if (hostedThread === undefined)
            return yield* HostedThreadApplicationError.make({ message: "Thread is unavailable" })
          const snapshot = yield* repositorySnapshot(hostedThread.ownerId, threadId)
          yield* store.appendEvents({
            ownerId: hostedThread.ownerId,
            threadId: HostedThreadId.make(threadId),
            events: [{ _tag: "ThreadViewSnapshot", snapshot: snapshot.view }],
            snapshot,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          })
        }).pipe(Effect.mapError(applicationFailure)),
    })
  }),
)
