import { Effect, Scope, Semaphore } from "effect"
import {
  ExecutorFenceError,
  sameBinding,
  sameWorkspacePolicy,
  type ExecutorTransportError,
  type WorkspaceBinding,
  type WorkspaceExecutorService,
} from "@rika/execution"

export interface RuntimeWorkspace {
  readonly executor: WorkspaceExecutorService
  readonly rebind: (
    binding: WorkspaceBinding,
  ) => Effect.Effect<void, ExecutorFenceError | ExecutorTransportError>
}

export const makeRuntimeWorkspace = Effect.fn("Rika.RuntimeWorkspace.make")(function* (options: {
  readonly initial: WorkspaceExecutorService
  readonly resolve: (
    binding: WorkspaceBinding,
  ) => Effect.Effect<WorkspaceExecutorService, ExecutorFenceError | ExecutorTransportError, Scope.Scope>
}): Effect.fn.Return<RuntimeWorkspace, never, Scope.Scope> {
  const scope = yield* Effect.scope
  const lock = yield* Semaphore.make(1)
  let current = options.initial
  const executor: WorkspaceExecutorService = {
    get binding() {
      return current.binding
    },
    handshake: (request) => Effect.suspend(() => current.handshake(request)),
    dispatch: (intent, input, evidence) => Effect.suspend(() => current.dispatch(intent, input, evidence)),
    receipt: (operationId) => Effect.suspend(() => current.receipt(operationId)),
    cancel: (operationId) => Effect.suspend(() => current.cancel(operationId)),
  }
  const rebind: RuntimeWorkspace["rebind"] = (binding) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (sameBinding(current.binding, binding)) return
        if (!sameWorkspacePolicy(current.binding, binding) || binding.generation <= current.binding.generation)
          return yield* ExecutorFenceError.make({
            reason: "generation",
            message: "Workspace recovery must retain its policy and advance its generation",
          })
        const resolved = yield* options.resolve(binding).pipe(Scope.provide(scope))
        if (!sameBinding(resolved.binding, binding))
          return yield* ExecutorFenceError.make({
            reason: "assignment",
            message: "Recovered Executor does not match the admitted workspace binding",
          })
        current = resolved
      }),
    )
  return { executor, rebind }
})
