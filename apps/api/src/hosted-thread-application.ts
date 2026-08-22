import { Clock, Context, Crypto, DateTime, Deferred, Effect, Layer, LayerMap, Queue, Schema, Semaphore } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
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
import * as ThreadRepository from "@rika/product/thread-repository"
import { TurnId } from "@rika/product/turn-record"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import { isDurableThreadEvent, type HostedThreadSnapshot } from "@rika/product/client-protocol"
import { ThreadProtocolStore } from "@rika/product/thread-protocol-store"
import * as ProductRepositories from "@rika/product-store/postgres-product-repositories"
import { HostedModelRegistry } from "./hosted-model-registry"

export class HostedThreadApplicationError extends Schema.TaggedError<HostedThreadApplicationError>()(
  "HostedThreadApplicationError",
  { message: Schema.String },
) {}

export interface HostedThreadApplicationService {
  readonly thread: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<Thread | undefined, HostedThreadApplicationError>
  readonly interactive: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: string
    readonly command: InteractiveCommand
  }) => Effect.Effect<
    ReadonlyArray<InteractiveEvent>,
    HostedThreadApplicationError | ProductOperation.OperationUnavailable
  >
  readonly snapshot: (
    ownerId: OwnerId,
    threadId: ThreadId,
  ) => Effect.Effect<HostedThreadSnapshot, HostedThreadApplicationError>
}

export class HostedThreadApplication extends Context.Service<HostedThreadApplication, HostedThreadApplicationService>()(
  "@rika/api/hosted-thread-application/HostedThreadApplication",
) {}

interface InteractiveInvocation {
  readonly commandId: string
  readonly command: InteractiveCommand
  readonly events: Array<InteractiveEvent>
  readonly completed: Deferred.Deferred<ReadonlyArray<InteractiveEvent>, ProductOperation.OperationUnavailable>
}

interface HostedInteractiveSession {
  readonly queue: Queue.Queue<InteractiveInvocation, ProductOperation.OperationUnavailable>
  readonly ready: Deferred.Deferred<void, ProductOperation.OperationUnavailable>
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
    const store = yield* ThreadProtocolStore
    const modelRegistry = yield* HostedModelRegistry
    const ownerScope = yield* Effect.scope
    const invocations = new Map<OwnerId, InteractiveInvocation>()
    const interactiveAdmissions = new Map<OwnerId, Semaphore.Semaphore>()
    const interactiveSessions = new Map<string, HostedInteractiveSession>()
    const backgroundEvents = yield* Queue.unbounded<{
      readonly ownerId: OwnerId
      readonly threadId: HostedThreadId
      readonly event: InteractiveEvent
    }>()
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          const current = yield* Queue.take(backgroundEvents)
          const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          yield* store.appendEvents({ ...current, events: [current.event], createdAt })
        }
      }),
      ownerScope,
    )
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
          yield* Deferred.succeed(state.ready, undefined)
          yield* Effect.forkScoped(
            session.events((event) => {
              const invocation = invocations.get(ownerId)
              if (invocation === undefined) {
                if (isDurableThreadEvent(event))
                  Queue.offerUnsafe(backgroundEvents, { ownerId, threadId: hostedThreadId, event })
              } else invocation.events.push(event)
            }),
          )
          while (true) {
            const invocation = yield* Queue.take(state.queue)
            const admission = interactiveAdmissions.get(ownerId) ?? Semaphore.makeUnsafe(1)
            interactiveAdmissions.set(ownerId, admission)
            yield* admission.withPermits(1)(
              Effect.gen(function* () {
                invocations.set(ownerId, invocation)
                const result = yield* executeInteractiveCommand(session, invocation.command).pipe(Effect.result)
                yield* Effect.yieldNow
                invocations.delete(ownerId)
                if (result._tag === "Failure") yield* Deferred.fail(invocation.completed, result.failure)
                else yield* Deferred.succeed(invocation.completed, invocation.events)
              }).pipe(Effect.ensuring(Effect.sync(() => invocations.delete(ownerId)))),
            )
          }
        }),
      )
    }
    const ownerRepositories = yield* LayerMap.make((ownerId: OwnerId) => ProductRepositories.layer(ownerId))
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
      interactive: (input) =>
        Effect.scoped(
          owners.contextEffect(input.ownerId).pipe(
            Effect.flatMap((context) =>
              Effect.gen(function* () {
                const key = `${input.ownerId}:${input.threadId}`
                let state = interactiveSessions.get(key)
                if (state === undefined) {
                  state = {
                    queue: yield* Queue.unbounded<InteractiveInvocation, ProductOperation.OperationUnavailable>(),
                    ready: yield* Deferred.make<void, ProductOperation.OperationUnavailable>(),
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
                  completed: yield* Deferred.make<
                    ReadonlyArray<InteractiveEvent>,
                    ProductOperation.OperationUnavailable
                  >(),
                }
                yield* Queue.offer(state.queue, invocation)
                return yield* Deferred.await(invocation.completed)
              }),
            ),
            Effect.mapError((error) =>
              Schema.is(ProductOperation.OperationUnavailable)(error) || Schema.is(HostedThreadApplicationError)(error)
                ? error
                : HostedThreadApplicationError.make({ message: String(error) }),
            ),
          ),
        ),
      snapshot: (ownerId, threadId) =>
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
                const allTurns = yield* turns.list(threadId)
                const queue = yield* turns.readQueue(threadId)
                const projections = yield* Effect.all(
                  allTurns.map((turn) => transcripts.get(turn.id)),
                  { concurrency: "unbounded" },
                )
                const present = projections.filter((projection) => projection !== undefined)
                const pendingAuthorizations = present.flatMap((projection) => {
                  if (projection.projectorCheckpoint === undefined) return []
                  return projection.units.flatMap((unit) =>
                    unit.content._tag === "Block" &&
                    unit.content.block._tag === "AuthorizationCard" &&
                    unit.content.block.status === "pending"
                      ? [
                          {
                            threadId: HostedThreadId.make(threadId),
                            turnId: projection.turn.id,
                            authorizationId: unit.content.block.id,
                            operation: unit.content.block.operation,
                            capability: unit.content.block.capability,
                            input: unit.content.block.input,
                            inputTruncated: unit.content.block.inputTruncated,
                            checkpoint: projection.projectorCheckpoint!,
                          },
                        ]
                      : [],
                  )
                })
                return {
                  thread,
                  turns: allTurns,
                  units: present.flatMap((projection) => projection.units),
                  queue: { revision: queue.revision, turns: queue.turns },
                  pendingAuthorizations,
                }
              }).pipe(Effect.provide(context)),
            ),
            Effect.mapError((error) =>
              Schema.is(HostedThreadApplicationError)(error)
                ? error
                : HostedThreadApplicationError.make({ message: String(error) }),
            ),
          ),
        ),
    })
  }),
)
