import type { Interface as Controller } from "@rika/e2b-executor/controller"
import * as HostedObservability from "@rika/product/hosted-observability"
import {
  redactAccess,
  type AccessWire,
  type MachineOutcome,
  type MachineRequest,
} from "@rika/remote-execution/protocol"
import { Cause, Clock, DateTime, Deferred, Effect, Exit, Option, Ref, Scope, type Semaphore } from "effect"
import {
  GatewayError,
  type ExecuteInput,
  type ExecutionResult,
  type LifecycleStore,
  type OperationIdentity,
  type PreparationStore,
} from "./contract"
import { gatewayProtocol } from "./protocol"
import type { GatewaySession, PendingOperation } from "./rpc/model"
import { persistNativeOutcome, runNativeTool } from "./native-tool"

type Session = GatewaySession
type Pending = PendingOperation

export interface GatewayExecutionDependencies {
  readonly controller: Controller
  readonly lifecycle: LifecycleStore
  readonly preparation: PreparationStore
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly pending: Ref.Ref<Map<string, Pending>>
  readonly quiescing: Ref.Ref<Set<string>>
  readonly admission: Semaphore.Semaphore
  readonly awaitSession: (assignmentId: string) => Effect.Effect<Session>
  readonly grant: (session: Session, operationKey: string) => Effect.Effect<void, GatewayError>
  readonly machineIdFor: (operationKey: string, attempt: number) => Effect.Effect<string, GatewayError>
  readonly invokeMachine: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
  ) => Effect.Effect<MachineOutcome, GatewayError>
  readonly cancelMachine: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
    deadlineAt: string,
  ) => Effect.Effect<MachineOutcome, GatewayError>
  readonly scope: Scope.Scope
}

const { accessFailure, expired, key, sameAccess } = gatewayProtocol

export const gatewayExecutionFactory = (dependencies: GatewayExecutionDependencies) => {
  const { controller, lifecycle, preparation, sessions, pending, quiescing, admission, awaitSession, grant } =
    dependencies

  const durableResult = Effect.fn("ExecutorGateway.durableResult")(function* (
    durable: Effect.Success<ReturnType<LifecycleStore["inspect"]>>,
    access?: AccessWire,
  ): Effect.fn.Return<ExecutionResult | undefined, GatewayError> {
    if (durable.state !== "completed" && durable.state !== "unknown") return undefined
    if (durable.response === undefined || durable.outcome === undefined)
      return yield* GatewayError.make({ kind: "transport", message: "Persisted executor terminal is incomplete" })
    return access === undefined
      ? { response: durable.response, outcome: durable.outcome }
      : { access, response: durable.response, outcome: durable.outcome }
  })

  const retireOperation = Effect.fn("ExecutorGateway.retireOperation")(function* (
    pendingKey: string,
    operation: Pick<Pending, "result">,
  ) {
    yield* Ref.update(pending, (current) => {
      if (current.get(pendingKey)?.result !== operation.result) return current
      const next = new Map(current)
      next.delete(pendingKey)
      return next
    })
  })

  const resolveDeadline = (request: OperationIdentity) =>
    lifecycle.resolveDeadline(request).pipe(
      Effect.tap((resolution) => {
        if (resolution._tag !== "Resolved") return Effect.void
        const correlation = {
          threadId: request.threadId,
          turnId: request.turnId,
          runId: request.runId,
          operationId: request.operationKey,
        }
        if (resolution.result.outcome === "unknown") return HostedObservability.unknownOutcome(correlation)
        let outcome: "success" | "interrupted" | "failure" = "failure"
        if (resolution.result.outcome === "completed") outcome = "success"
        if (resolution.result.outcome === "cancelled") outcome = "interrupted"
        return HostedObservability.event("terminal", outcome, correlation)
      }),
      Effect.map((resolution) => resolution.result),
    )

  const awaitSettlement = (
    request: ExecuteInput,
    result?: Deferred.Deferred<ExecutionResult, GatewayError>,
  ): Effect.Effect<ExecutionResult, GatewayError> =>
    Effect.gen(function* () {
      const remaining =
        DateTime.toEpochMillis(DateTime.makeUnsafe(request.deadlineAt)) - (yield* Clock.currentTimeMillis)
      if (remaining > 0 && result !== undefined) {
        const completed = yield* Deferred.await(result).pipe(Effect.timeoutOption(remaining))
        if (Option.isSome(completed)) return completed.value
      } else if (remaining > 0) yield* Effect.sleep(remaining)
      const durable = yield* lifecycle.inspect(request)
      const terminal = yield* durableResult(durable)
      if (terminal !== undefined) return terminal
      if (result !== undefined) {
        const settling = yield* Deferred.await(result).pipe(Effect.timeoutOption("1 second"))
        if (Option.isSome(settling)) return settling.value
      }
      return yield* resolveDeadline(request)
    })

  const makePending = (
    request: ExecuteInput,
    session: Session,
    result: Deferred.Deferred<ExecutionResult, GatewayError>,
  ): Pending => ({
    assignmentId: request.assignmentId,
    operationKey: request.operationKey,
    attempt: request.attempt,
    request,
    socket: session.socket,
    access: session.access,
    result,
    waiters: 1,
  })

  const settledPending = (request: ExecuteInput, session: Session, result: ExecutionResult) =>
    Deferred.make<ExecutionResult, GatewayError>().pipe(
      Effect.tap((deferred) => Deferred.succeed(deferred, result)),
      Effect.map((deferred) => makePending(request, session, deferred)),
    )

  const existingAdmission = Effect.fn("ExecutorGateway.existingAdmission")(function* (
    request: ExecuteInput,
    session: Session,
  ) {
    const durable = yield* lifecycle.inspect(request)
    const restored = yield* durableResult(durable, session.access)
    if (restored !== undefined) return yield* settledPending(request, session, restored)
    const fence = session.access.fence
    if (
      durable.state === "dispatched" &&
      (durable.dispatchedGeneration !== fence.assignmentGeneration ||
        durable.dispatchedExecutorInstanceId !== fence.executorId ||
        durable.dispatchedProcessIncarnation !== fence.processIncarnation)
    )
      return yield* settledPending(request, session, yield* resolveDeadline(request))
    return undefined
  })

  const dispatchAdmission = Effect.fn("ExecutorGateway.dispatchAdmission")(function* (
    request: ExecuteInput,
    session: Session,
    pendingKey: string,
  ) {
    yield* lifecycle.dispatch(request, session.access)
    const known = (yield* Ref.get(pending)).get(pendingKey)
    if (known !== undefined && known.socket === session.socket && sameAccess(known.access, session.access)) {
      yield* Ref.update(pending, (current) =>
        new Map(current).set(pendingKey, { ...known, waiters: known.waiters + 1 }),
      )
      return known
    }
    if (known !== undefined) {
      yield* Ref.update(
        pending,
        (current) => new Map([...current].filter(([, value]) => value.result !== known.result)),
      )
      yield* Deferred.fail(
        known.result,
        GatewayError.make({
          kind: "disconnected",
          message: "Executor connection was replaced before returning a result",
        }),
      )
    }
    const created = makePending(request, session, yield* Deferred.make<ExecutionResult, GatewayError>())
    yield* Ref.update(pending, (current) => new Map(current).set(pendingKey, created))
    yield* runNativeTool({
      operation: created,
      lifecycle,
      machineIdFor: dependencies.machineIdFor,
      invoke: dependencies.invokeMachine,
    }).pipe(Effect.forkIn(dependencies.scope))
    return created
  })

  const admit = Effect.fn("ExecutorGateway.admit")(function* (request: ExecuteInput, pendingKey: string) {
    const session = (yield* Ref.get(sessions)).get(request.assignmentId)
    if (session === undefined || !session.ready)
      return yield* GatewayError.make({ kind: "disconnected", message: "Executor workspace is not ready" })
    if ((yield* Ref.get(quiescing)).has(request.assignmentId))
      return yield* GatewayError.make({ kind: "fenced", message: "Executor is quiescing" })
    if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
    yield* controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
    yield* preparation.ready(session.access)
    yield* grant(session, request.operationKey)
    return (yield* existingAdmission(request, session)) ?? (yield* dispatchAdmission(request, session, pendingKey))
  })

  const releaseWaiter = (pendingKey: string, operation: Pending) =>
    admission.withPermits(1)(
      Ref.modify(pending, (current) => {
        const known = current.get(pendingKey)
        if (known?.result !== operation.result) return [false, current] as const
        if (known.waiters > 1)
          return [false, new Map(current).set(pendingKey, { ...known, waiters: known.waiters - 1 })] as const
        return [true, current] as const
      }).pipe(Effect.flatMap((retire) => (retire ? retireOperation(pendingKey, operation) : Effect.void))),
    )

  const execute = Effect.fn("ExecutorGateway.execute")(function* (input: ExecuteInput) {
    const window = yield* lifecycle.prepare(input)
    const request = { ...input, admittedAt: window.admittedAt, deadlineAt: window.deadlineAt }
    const replay = yield* lifecycle.inspect(request).pipe(Effect.flatMap((durable) => durableResult(durable)))
    if (replay !== undefined) return replay
    const remaining = DateTime.toEpochMillis(DateTime.makeUnsafe(request.deadlineAt)) - (yield* Clock.currentTimeMillis)
    if (
      remaining <= 0 ||
      Option.isNone(yield* awaitSession(request.assignmentId).pipe(Effect.timeoutOption(remaining)))
    )
      return yield* awaitSettlement(request)
    const pendingKey = key(request.assignmentId, request.operationKey, request.attempt)
    const operation = yield* admission.withPermits(1)(admit(request, pendingKey))
    return yield* awaitSettlement(request, operation.result).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : releaseWaiter(pendingKey, operation),
      ),
    )
  })

  const cancel = Effect.fn("ExecutorGateway.cancel")(function* (input: OperationIdentity) {
    const resolution = yield* lifecycle.cancel(input)
    if (resolution._tag !== "Dispatched") return resolution.result
    const cancellationDeadlineAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(resolution.deadlineAt))
    const pendingKey = key(input.assignmentId, input.operationKey, input.attempt)
    const settle = (terminal: ExecutionResult) =>
      Effect.gen(function* () {
        const operation = (yield* Ref.get(pending)).get(pendingKey)
        if (operation !== undefined) yield* Deferred.succeed(operation.result, terminal)
        return terminal
      })
    const resolveUnknown = () => resolveDeadline(input).pipe(Effect.flatMap(settle))
    const waitAndRetry = (remaining: number) => Effect.sleep(Math.min(100, remaining)).pipe(Effect.andThen(reconcile))
    const reconcile = (): Effect.Effect<ExecutionResult, GatewayError> =>
      Effect.gen(function* () {
        const durable = yield* lifecycle.inspect(input)
        const terminal = yield* durableResult(durable)
        if (terminal !== undefined) return yield* settle(terminal)
        const now = yield* Clock.currentTimeMillis
        const remaining = Math.max(0, cancellationDeadlineAtMillis - now)
        if (remaining === 0) return yield* resolveUnknown()
        const session = (yield* Ref.get(sessions)).get(input.assignmentId)
        if (session === undefined || !session.ready) return yield* waitAndRetry(remaining)
        const fence = session.access.fence
        if (
          durable.state !== "dispatched" ||
          durable.dispatchedGeneration !== fence.assignmentGeneration ||
          durable.dispatchedExecutorInstanceId !== fence.executorId ||
          durable.dispatchedProcessIncarnation !== fence.processIncarnation
        )
          return yield* resolveUnknown()
        const validated = yield* controller
          .validateAccess(redactAccess(session.access))
          .pipe(Effect.mapError(accessFailure), Effect.result)
        if (validated._tag === "Failure")
          return validated.failure.kind === "fenced" ? yield* resolveUnknown() : yield* waitAndRetry(remaining)
        const cancelled = yield* dependencies
          .cancelMachine(
            input.assignmentId,
            input.operationKey,
            input.attempt,
            yield* dependencies.machineIdFor(input.operationKey, input.attempt),
            input.machineRequest,
            resolution.deadlineAt,
          )
          .pipe(
            Effect.flatMap((outcome) => persistNativeOutcome(lifecycle, session.access, input, outcome)),
            Effect.result,
          )
        if (cancelled._tag === "Success") return yield* settle(cancelled.success)
        return cancelled.failure.kind === "fenced" ? yield* resolveUnknown() : yield* waitAndRetry(remaining)
      })
    return yield* reconcile()
  })

  return { execute, cancel }
}
