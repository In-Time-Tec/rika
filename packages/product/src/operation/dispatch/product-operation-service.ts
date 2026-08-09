import { Context, Effect, Ref, Semaphore } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnRepository from "@rika/product/turn-repository"
import { OperationUnavailable } from "../contract/product-operation"
import { Service } from "../contract/product-operation-service"
import { makeProductOperationRun } from "./product-operation-run"
import type { ProductOperationRuntimeState } from "./product-operation-runtime-state"
import type { ProductOperationSchedule } from "./product-operation-schedule"
import type { ProductLayerOptions } from "./product-operation-options"
import type { ProductOperationRunFactory } from "./product-operation-run-branches"
import type { Input } from "../contract/product-operation"
import type { InteractiveEvent } from "../interactive/interactive-runtime-event"

export interface ProductOperationServiceInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly state: ProductOperationRuntimeState
  readonly schedule: ProductOperationSchedule
  readonly fileSystem: import("effect").FileSystem.FileSystem | undefined
  readonly path: import("effect").Path.Path | undefined
  readonly executionDependencies: ProductOperationRuntimeState["executionDependencies"]
  readonly stopActiveExecutionWorkWithProjection: ProductOperationRuntimeState["stopActiveExecutionWorkWithProjection"]
  readonly replacementAdmission: Semaphore.Semaphore
  readonly replacementState: Ref.Ref<{ readonly closed: boolean; readonly active: number }>
  readonly unavailable: (input: Input, message?: string) => OperationUnavailable
  readonly operationError: typeof import("../operation-error").operationError
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly encodeJson: (value: unknown) => string
  readonly runAuth: typeof import("./authentication-operation-dispatch").run
  readonly queueMutationEvent: ProductOperationRuntimeState["queueMutationEvent"]
  readonly extensionOperations: typeof import("../contract/extension-operation")
  readonly configOperations: typeof import("../contract/configuration-operation")
  readonly notifyThreadSummaries: ProductOperationRuntimeState["notifyThreadSummaries"]
  readonly writeThread: (thread: import("@rika/product/thread-record").Thread) => Effect.Effect<void>
  readonly requireThread: (
    repository: import("@rika/product/thread-repository").Interface,
    id: string,
  ) => Effect.Effect<import("@rika/product/thread-record").Thread, import("../operation-error").OperationError>
  readonly markdownExport: (
    thread: import("@rika/product/thread-record").Thread,
    turns: ReadonlyArray<import("@rika/product/turn-record").Turn>,
  ) => string
  readonly staleQueuedTurnsError: typeof import("../../thread/queue/pending-turn-policy").staleQueuedTurnsError
  readonly queuedTurnPromoteMaxAgeMs: number
}

export const makeProductOperationService = (input: ProductOperationServiceInput) => {
  const {
    state,
    schedule,
    executionDependencies,
    stopActiveExecutionWorkWithProjection,
    replacementAdmission,
    replacementState,
  } = input
  const typedExecutionDependencies: Context.Context<ExecutionGateway.Service | TurnRepository.Service> =
    executionDependencies
  const hasActiveExecutionWork = Effect.gen(function* () {
    const turns = yield* TurnRepository.Service
    return (yield* turns.listNonterminal).some((turn) => turn.status !== "queued")
  })
  const typedReplacementAdmission: Semaphore.Semaphore = replacementAdmission
  const typedReplacementState: Ref.Ref<{ readonly closed: boolean; readonly active: number }> = replacementState
  return Service.of({
    hasActiveExecutionWork: hasActiveExecutionWork.pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.mapError((error: unknown) =>
        OperationUnavailable.make({ operation: "ServerReplacement", message: String(error) }),
      ),
    ),
    stopActiveExecutionWork: stopActiveExecutionWorkWithProjection.pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.mapError((error: unknown) =>
        OperationUnavailable.make({ operation: "ServerAbandonment", message: String(error) }),
      ),
    ),
    authorizeServerReplacement: typedReplacementAdmission.withPermits(1)(
      Effect.gen(function* () {
        const replacement = yield* Ref.get(typedReplacementState)
        if (replacement.closed) return "supersede" as const
        if (
          replacement.active > 0 ||
          (yield* hasActiveExecutionWork.pipe(Effect.provide(typedExecutionDependencies))) === true
        )
          return "defer" as const
        yield* Ref.set(typedReplacementState, { closed: true, active: 0 })
        return "supersede" as const
      }).pipe(
        Effect.mapError((error: unknown) =>
          OperationUnavailable.make({ operation: "ServerReplacement", message: String(error) }),
        ),
      ),
    ),
    run: makeProductOperationRun({
      ...state,
      ...input,
      ...schedule,
      backend: state.acquiredBackend,
    } satisfies ProductOperationRunFactory),
  })
}
