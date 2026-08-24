import { Console, Context, Effect } from "effect"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnRepository from "@rika/product/turn-repository"
import { OperationUnavailable } from "../contract/product"
import { Service } from "../contract/product-service"
import { makeProductOperationRun } from "./program"
import type { ProductOperationRuntimeState } from "../runtime/state"
import type { ProductOperationSchedule } from "./schedule"
import type { ProductLayerOptions } from "../foundation/options"
import type { ProductOperationRunFactory } from "./branches"
import type { Input } from "../contract/product"
import type { InteractiveEvent } from "../interactive/session-event"

export interface ProductOperationServiceInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly state: ProductOperationRuntimeState
  readonly schedule: ProductOperationSchedule
  readonly console: Console.Console
  readonly fileSystem: import("effect").FileSystem.FileSystem | undefined
  readonly path: import("effect").Path.Path | undefined
  readonly executionDependencies: ProductOperationRuntimeState["executionDependencies"]
  readonly stopActiveExecutionWorkWithProjection: ProductOperationRuntimeState["stopActiveExecutionWorkWithProjection"]
  readonly closeAdmissions: Effect.Effect<void>
  readonly unavailable: (input: Input, message?: string) => OperationUnavailable
  readonly operationError: typeof import("../error").operationError
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly encodeJson: (value: unknown) => string
  readonly runAuth: typeof import("../dispatch/authentication").run
  readonly queueMutationEvent: ProductOperationRuntimeState["queueMutationEvent"]
  readonly extensionOperations: typeof import("../contract/extension")
  readonly configOperations: typeof import("../contract/configuration")
  readonly notifyThreadSummaries: ProductOperationRuntimeState["notifyThreadSummaries"]
  readonly writeThread: (thread: import("@rika/product/thread-record").Thread) => Effect.Effect<void>
  readonly requireThread: (
    repository: import("@rika/product/thread-repository").Interface,
    id: string,
  ) => Effect.Effect<import("@rika/product/thread-record").Thread, import("../error").OperationError>
  readonly markdownExport: (
    thread: import("@rika/product/thread-record").Thread,
    turns: ReadonlyArray<import("@rika/product/turn-record").Turn>,
  ) => string
  readonly staleQueuedTurnsError: typeof import("../../thread/queue/pending-policy").staleQueuedTurnsError
  readonly queuedTurnPromoteMaxAgeMs: number
}

export const makeProductOperationService = (input: ProductOperationServiceInput) => {
  const { state, schedule, executionDependencies, stopActiveExecutionWorkWithProjection, closeAdmissions } = input
  const typedExecutionDependencies: Context.Context<ExecutionGateway.Service | TurnRepository.Service> =
    executionDependencies
  return Service.of({
    stopActiveExecutionWork: stopActiveExecutionWorkWithProjection.pipe(
      Effect.provide(typedExecutionDependencies),
      Effect.mapError((error: unknown) =>
        OperationUnavailable.make({ operation: "ExecutionShutdown", message: String(error) }),
      ),
    ),
    closeAdmissions,
    run: makeProductOperationRun({
      ...state,
      ...input,
      ...schedule,
      backend: state.acquiredBackend,
    } satisfies ProductOperationRunFactory),
  })
}
