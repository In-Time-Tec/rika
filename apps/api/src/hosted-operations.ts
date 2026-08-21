import { Context, Crypto, Effect, Layer, LayerMap, Schema } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionSessionLifecycle from "@rika/product/execution-session-lifecycle"
import * as GoalService from "@rika/product/goal-service"
import type { OwnerId } from "@rika/product/hosted-model"
import * as ProductOperation from "@rika/product/product-operation"
import * as ProductOperationService from "@rika/product/product-operation-service"
import { ThreadId, type Thread } from "@rika/product/thread-record"
import * as ThreadRepository from "@rika/product/thread-repository"
import { TurnId } from "@rika/product/turn-record"
import * as ProductRepositories from "@rika/product-store/postgres-product-repositories"

export class HostedOperationsError extends Schema.TaggedError<HostedOperationsError>()("HostedOperationsError", {
  message: Schema.String,
}) {}

export interface HostedOperationsService {
  readonly run: (
    ownerId: OwnerId,
    input: ProductOperation.Input,
  ) => Effect.Effect<void, HostedOperationsError | ProductOperation.OperationUnavailable>
  readonly thread: (ownerId: OwnerId, threadId: ThreadId) => Effect.Effect<Thread | undefined, HostedOperationsError>
}

export class HostedOperations extends Context.Service<HostedOperations, HostedOperationsService>()(
  "@rika/api/hosted-operations/HostedOperations",
) {}

const ownerLayer = (ownerId: OwnerId) => {
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
        makeThreadId: crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(ThreadId.make)),
        makeTurnId: crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(TurnId.make)),
      })
      return Layer.merge(operations, Layer.succeedContext(repositoryContext)).pipe(
        Layer.catchCause((cause) =>
          Layer.effectContext(Effect.fail(HostedOperationsError.make({ message: String(cause) }))),
        ),
      )
    }),
  )
}

export const layer = Layer.effect(
  HostedOperations,
  Effect.gen(function* () {
    const owners = yield* LayerMap.make(ownerLayer)
    return HostedOperations.of({
      run: (ownerId, input) =>
        Effect.scoped(
          owners
            .contextEffect(ownerId)
            .pipe(Effect.flatMap((context) => Context.get(context, ProductOperationService.Service).run(input))),
        ),
      thread: (ownerId, threadId) =>
        Effect.scoped(
          owners.contextEffect(ownerId).pipe(
            Effect.flatMap((context) => Context.get(context, ThreadRepository.Service).get(threadId)),
            Effect.mapError((error) =>
              Schema.is(HostedOperationsError)(error) ? error : HostedOperationsError.make({ message: String(error) }),
            ),
          ),
        ),
    })
  }),
)
