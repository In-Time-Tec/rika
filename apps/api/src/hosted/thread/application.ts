import { Clock, Context, Crypto, DateTime, Deferred, Effect, Layer, LayerMap, Queue, Schema, Semaphore } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as GoalService from "@rika/product/goal-service"
import { ThreadId as HostedThreadId, type OwnerId } from "@rika/product/hosted-model"
import { executeInteractiveCommand, type InteractiveCommand } from "@rika/product/interactive-command"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { InteractiveSession } from "@rika/product/interactive-session"
import { operationError } from "@rika/product/operation-error"
import * as ProductOperation from "@rika/product/product-operation"
import * as ProductOperationService from "@rika/product/product-operation-service"
import { ThreadId, type Thread } from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as ThreadRepository from "@rika/product/thread-repository"
import { TurnId, type Turn } from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { isDurableThreadEvent, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import { HostedStore } from "@rika/product/hosted-store"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import * as ProductRepositories from "@rika/product-store/product-repositories"
import { identityKey } from "@rika/transcript/transcript-unit-identity"
import { compareUnitOrder, encodeUnitOrder } from "@rika/transcript/transcript-unit-order"
import type { Unit } from "@rika/transcript/transcript-unit"
import { HostedModelRegistry } from "../environment/model-registry"
import { HostedPreviewBus } from "./previews"

export class HostedThreadApplicationError extends Schema.TaggedError<HostedThreadApplicationError>()(
  "HostedThreadApplicationError",
  { message: Schema.String },
) {}

export interface HostedThreadApplicationService {
  readonly thread: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<Thread | undefined, HostedThreadApplicationError>
  readonly interactive: <A, E, R>(
    input: {
      readonly ownerId: OwnerId
      readonly threadId: ThreadId
      readonly commandId: string
      readonly command: InteractiveCommand
    },
    persist: (batch: HostedInteractiveBatch) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, HostedThreadApplicationError | E, R>
  readonly snapshot: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<HostedThreadSnapshot, HostedThreadApplicationError>
}

export class HostedThreadApplication extends Context.Service<HostedThreadApplication, HostedThreadApplicationService>()(
  "@rika/api/hosted/thread/application/HostedThreadApplication",
) {}

interface InteractiveInvocation {
  readonly commandId: string
  readonly command: InteractiveCommand
  readonly events: Array<InteractiveEvent>
  readonly completed: Deferred.Deferred<HostedInteractiveBatch>
}

export interface HostedInteractiveBatch {
  readonly events: ReadonlyArray<InteractiveEvent>
  readonly snapshot: HostedThreadSnapshot
  readonly failure?: ProductOperation.OperationUnavailable
}

type MutableHostedInteractiveBatch = { -readonly [Key in keyof HostedInteractiveBatch]: HostedInteractiveBatch[Key] }

interface HostedInteractiveSession {
  readonly queue: Queue.Queue<InteractiveInvocation, ProductOperation.OperationUnavailable>
  readonly ready: Deferred.Deferred<void, ProductOperation.OperationUnavailable>
  invocation: InteractiveInvocation | undefined
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

const viewSource = (turns: ReadonlyArray<ThreadView.ThreadViewTurn>): ThreadView.ThreadViewSource => {
  const oldest = turns.find((turn) => turn.units.length > 0)
  const newest = turns.findLast((turn) => turn.units.length > 0)
  const oldestUnit = oldest?.units[0]
  const newestUnit = newest?.units.at(-1)
  const oldestCursor =
    oldest === undefined || oldestUnit === undefined
      ? undefined
      : { createdAt: oldest.turn.createdAt, turnId: oldest.turn.id, orderKey: encodeUnitOrder(oldestUnit.order) }
  const newestCursor =
    newest === undefined || newestUnit === undefined
      ? undefined
      : { createdAt: newest.turn.createdAt, turnId: newest.turn.id, orderKey: encodeUnitOrder(newestUnit.order) }
  if (oldestCursor === undefined)
    return newestCursor === undefined
      ? { projectionVersion: ExecutionProjection.projectionVersion }
      : { projectionVersion: ExecutionProjection.projectionVersion, newestCursor }
  return newestCursor === undefined
    ? { projectionVersion: ExecutionProjection.projectionVersion, oldestCursor }
    : { projectionVersion: ExecutionProjection.projectionVersion, oldestCursor, newestCursor }
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

const ownerLayer = (
  ownerId: OwnerId,
  currentInvocation: () => InteractiveInvocation,
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
        makeTurnId: Effect.sync(() => TurnId.make(currentInvocation().commandId)),
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
    const hosted = yield* HostedStore
    const store = yield* ThreadProtocolStore
    const modelRegistry = yield* HostedModelRegistry
    const previews = yield* HostedPreviewBus
    const ownerScope = yield* Effect.scope
    const invocations = new Map<OwnerId, InteractiveInvocation>()
    const interactiveAdmissions = new Map<OwnerId, Semaphore.Semaphore>()
    const projectionAdmissions = new Map<string, Semaphore.Semaphore>()
    const interactiveSessions = new Map<string, HostedInteractiveSession>()
    const projectionTails = new Map<string, Deferred.Deferred<void, HostedThreadApplicationError>>()
    const backgroundEvents = yield* Queue.unbounded<{
      readonly ownerId: OwnerId
      readonly threadId: HostedThreadId
      readonly event: InteractiveEvent
      readonly persisted: Deferred.Deferred<void, HostedThreadApplicationError>
    }>()
    const projectionAdmission = (key: string) => {
      const current = projectionAdmissions.get(key) ?? Semaphore.makeUnsafe(1)
      projectionAdmissions.set(key, current)
      return current
    }
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
                return yield* HostedThreadApplicationError.make({ message: "Hosted Thread is unavailable" })
              const allTurns = yield* turns.list(threadId)
              const queue = yield* turns.readQueue(threadId)
              const usage = yield* transcripts.usage(threadId)
              const projections = yield* Effect.all(
                allTurns.map((turn) => transcripts.get(turn.id)),
                { concurrency: "unbounded" },
              )
              const viewTurns: Array<ThreadView.ThreadViewTurn> = []
              for (let index = 0; index < allTurns.length; index += 1) {
                const turn = allTurns[index]!
                if (turn.status === "queued") continue
                const projection = projections[index]
                const units = [...(projection?.units ?? [])]
                if (units.length === 0) units.push(promptUnit(projection?.turn ?? turn))
                units.sort((left, right) => {
                  const order = compareUnitOrder(left.order, right.order)
                  return order === 0 ? left.key.localeCompare(right.key) : order
                })
                viewTurns.push({
                  turn: ThreadView.turnRecord(projection?.turn ?? turn),
                  units,
                  projectionRevision: projection?.revision ?? 0,
                  usage: projection?.state.usage ?? ExecutionProjection.emptyUsageState(),
                  pendingSteering: projection?.state.steering.pending ?? [],
                  settledSteering: projection?.state.steering.settled ?? [],
                })
              }
              viewTurns.sort((left, right) => {
                const createdAt = left.turn.createdAt - right.turn.createdAt
                return createdAt === 0 ? String(left.turn.id).localeCompare(String(right.turn.id)) : createdAt
              })
              const viewUsage: ThreadView.ThreadViewSnapshot["usage"] =
                usage.contextCapacity === undefined
                  ? { state: usage.usage }
                  : { state: usage.usage, contextCapacity: usage.contextCapacity }
              const view: ThreadView.ThreadViewSnapshot = {
                thread,
                revision: 0,
                source: viewSource(viewTurns),
                turns: viewTurns,
                pending: queue.turns.slice(0, ThreadView.limits.pending).map((turn) => ({
                  id: turn.id,
                  prompt: turn.prompt,
                  createdAt: turn.createdAt,
                })),
                hasOlder: false,
                hasNewer: false,
                usage: viewUsage,
              }
              const checkpoints = new Map(
                projections.flatMap((projection) =>
                  projection?.projectorCheckpoint === undefined
                    ? []
                    : [[String(projection.turn.id), projection.projectorCheckpoint] as const],
                ),
              )
              const authorizations = pendingAuthorizations(HostedThreadId.make(threadId), view, (turnId) =>
                checkpoints.get(turnId),
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
          const result = yield* projectionAdmission(key)
            .withPermits(1)(
              Effect.gen(function* () {
                const snapshot = yield* repositorySnapshot(current.ownerId, ThreadId.make(current.threadId))
                yield* store.appendEvents({
                  ownerId: current.ownerId,
                  threadId: current.threadId,
                  events: [current.event],
                  snapshot,
                  createdAt,
                })
              }),
            )
            .pipe(Effect.mapError(applicationFailure), Effect.result)
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
          yield* Effect.forkScoped(
            session
              .events((event) => {
                if (event._tag === "ExecutionModelPreviewChanged")
                  previews.publish({
                    ownerId,
                    threadId: hostedThreadId,
                    turnId: event.turnId,
                    preview: event.preview,
                  })
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
                    Queue.offerUnsafe(backgroundEvents, {
                      ownerId,
                      threadId: hostedThreadId,
                      event,
                      persisted,
                    })
                  }
                } else invocation.events.push(event)
              })
              .pipe(Effect.tapError((error) => Deferred.fail(state.ready, error))),
          )
          yield* session.selectThread(input.threadId!)
          yield* Deferred.await(state.ready)
          while (true) {
            const invocation = yield* Queue.take(state.queue)
            const admission = interactiveAdmissions.get(ownerId) ?? Semaphore.makeUnsafe(1)
            interactiveAdmissions.set(ownerId, admission)
            yield* admission.withPermits(1)(
              Effect.gen(function* () {
                invocations.set(ownerId, invocation)
                state.invocation = invocation
                const result = yield* executeInteractiveCommand(session, invocation.command).pipe(Effect.result)
                yield* Effect.yieldNow
                invocations.delete(ownerId)
                state.invocation = undefined
                const snapshot = yield* repositorySnapshot(ownerId, threadId).pipe(
                  Effect.mapError((error) =>
                    ProductOperation.OperationUnavailable.make({
                      operation: "InteractiveSession",
                      message: error.message,
                    }),
                  ),
                )
                const batch: MutableHostedInteractiveBatch = {
                  events: invocation.events,
                  snapshot,
                }
                if (result._tag === "Failure") batch.failure = result.failure
                yield* Deferred.succeed(invocation.completed, batch)
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    invocations.delete(ownerId)
                    state.invocation = undefined
                  }),
                ),
              ),
            )
          }
        }),
      )
    }
    const owners = yield* LayerMap.make((ownerId: OwnerId) =>
      ownerLayer(
        ownerId,
        () => {
          const invocation = invocations.get(ownerId)
          if (invocation === undefined) throw new Error("Hosted interactive invocation is unavailable")
          return invocation
        },
        (mode) =>
          modelRegistry.resolve(ownerId, mode).pipe(Effect.mapError((error) => operationError(error.message, error))),
        (input, session) => runInteractive(ownerId, input, session),
      ),
    )
    return HostedThreadApplication.of({
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
          return yield* projectionAdmission(key).withPermits(1)(
            Effect.gen(function* () {
              const batch = yield* Effect.scoped(
                owners.contextEffect(input.ownerId).pipe(
                  Effect.flatMap((context) =>
                    Effect.gen(function* () {
                      let state = interactiveSessions.get(key)
                      if (state === undefined) {
                        state = {
                          queue: yield* Queue.unbounded<InteractiveInvocation, ProductOperation.OperationUnavailable>(),
                          ready: yield* Deferred.make<void, ProductOperation.OperationUnavailable>(),
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
                      const invocation: InteractiveInvocation = {
                        commandId: input.commandId,
                        command: input.command,
                        events: [],
                        completed: yield* Deferred.make<HostedInteractiveBatch>(),
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
    })
  }),
)
