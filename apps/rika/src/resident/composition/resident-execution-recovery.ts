import * as Turn from "@rika/product/turn-record"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"
import * as ExecutionBackend from "@rika/product/execution-service"
import * as ExecutionRequest from "@rika/product/execution-request"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import * as RelayExecutionBackend from "@rika/relay-execution/relay-execution-layer"
import { Effect, Layer, Schema } from "effect"
import { provideLayerScoped } from "./resident-configuration-adapter"

export const resolveLegacyRouteForBackend =
  (options: {
    readonly resolveWorkspaceExecutionRoute: (
      mode: "low" | "medium" | "high" | "ultra",
      tuning: { readonly fastMode?: boolean } | undefined,
      workspace?: string,
    ) => Effect.Effect<ExecutionRouteSnapshot.ExecutionRoutePin, ExecutionBackend.BackendError, never>
    readonly repositories: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>
  }) =>
  (input: ExecutionRequest.StartInput) =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const thread = yield* threads.get(Thread.ThreadId.make(input.threadId))
      if (thread === undefined)
        return yield* ExecutionBackend.BackendError.make({
          message: `Thread ${input.threadId} does not exist for legacy route resolution`,
        })
      const resolved = yield* options.resolveWorkspaceExecutionRoute("medium", undefined, thread.workspace)
      return resolved
    }).pipe(
      provideLayerScoped(options.repositories),
      Effect.mapError((error) =>
        Schema.is(ExecutionBackend.BackendError)(error)
          ? error
          : ExecutionBackend.BackendError.make({ message: String(error) }),
      ),
    )

export const resolveExecutionWorkspace = Effect.fn("Main.resolveExecutionWorkspace")(function* (
  durableExecutionId: string,
  _defaultWorkspace: string,
  repositoryLayer: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>,
  turnRepositoryLayer: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>,
) {
  const program = Effect.gen(function* () {
    const turnId = RelayExecutionBackend.execution.turnIdFromExecutionId(durableExecutionId)
    const executionWorkspace = RelayExecutionBackend.execution.workspaceFromExecutionId(durableExecutionId)
    if (executionWorkspace !== undefined) return executionWorkspace
    if (turnId === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Execution ${durableExecutionId} is not attached to a Rika Turn`,
      })
    const turns = yield* TurnRepository.Service
    const turn = yield* turns.get(Turn.TurnId.make(turnId))
    if (turn === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Turn ${turnId} does not exist`,
      })
    const threads = yield* ThreadRepository.Service
    const thread = yield* threads.get(turn.threadId)
    if (thread === undefined)
      return yield* ExecutionBackend.BackendError.make({
        message: `Thread ${turn.threadId} does not exist`,
      })
    return thread.workspace
  })
  return yield* program.pipe(
    provideLayerScoped(Layer.merge(repositoryLayer, turnRepositoryLayer)),
    Effect.mapError((cause) =>
      Schema.is(ExecutionBackend.BackendError)(cause)
        ? cause
        : ExecutionBackend.BackendError.make({ message: String(cause) }),
    ),
  )
})
