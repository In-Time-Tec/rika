import type { AssignmentKey, ControllerError, Interface as ControllerService } from "@rika/e2b-executor/controller"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import type { AuthenticatedPrincipal } from "../hosted/product"
import type { RunnerAdmission } from "../runner/executor"
import type { RunnerGateway } from "../runner/gateway"
import { Context, Duration, Effect, Function } from "effect"
import type { ExecutionResult, Gateway, GatewayError, OperationIdentity } from "./gateway"

export interface Runtime {
  readonly controller: ControllerService
  readonly gateway: Gateway
  readonly runnerGateway: RunnerGateway
  readonly admitRunner: (input: {
    readonly threadId: string
    readonly workspaceFingerprint: string
    readonly principal: AuthenticatedPrincipal
    readonly executorUrl: string
  }) => Effect.Effect<RunnerAdmission, ControllerError>
  readonly admitRun: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly workspaceId: string
  }) => Effect.Effect<void, ControllerError>
  readonly run: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly runId: string
    readonly sessionId: string
    readonly workspaceId: string
    readonly toolCallId: string
    readonly operationKey: string
    readonly code: string
    readonly rootRunId: string
    readonly attempt: number
    readonly replayPolicy: "pure" | "provider-idempotent" | "never"
    readonly admittedAt: string | null
    readonly deadlineAt: string
    readonly authority: Context.Context<ExecutorRuntime.CapturedServices>
  }) => Effect.Effect<
    {
      readonly access?: import("@rika/remote-execution/protocol").AccessWire
      readonly response: import("@rika/remote-execution/protocol").CellResponse
      readonly outcome: "completed" | "failed" | "cancelled" | "unknown"
      readonly eventPersisted: boolean
    },
    ControllerError | GatewayError
  >
  readonly cancel: (
    input: Omit<OperationIdentity, "assignmentId">,
  ) => Effect.Effect<ExecutionResult, ControllerError | GatewayError>
  readonly ready: Effect.Effect<void, ControllerError>
  readonly pause: (key: AssignmentKey) => Effect.Effect<void, ControllerError | GatewayError>
  readonly resume: (key: AssignmentKey) => Effect.Effect<void, ControllerError>
  readonly replace: (key: AssignmentKey) => Effect.Effect<void, ControllerError>
}

export class Executor extends Context.Service<Executor, Runtime>()("@rika/api/executor/contract/Executor") {}

export const orphanReaper: {
  (interval: Duration.Input): <A, R>(cleanup: Effect.Effect<A, never, R>) => Effect.Effect<never, never, R>
  <A, R>(cleanup: Effect.Effect<A, never, R>, interval: Duration.Input): Effect.Effect<never, never, R>
} = Function.dual(2, <A, R>(cleanup: Effect.Effect<A, never, R>, interval: Duration.Input) => {
  const cycle = cleanup.pipe(Effect.asVoid, Effect.andThen(Effect.sleep(interval)))
  return cycle.pipe(Effect.forever)
})
