import type { Interface as Controller } from "@rika/e2b-executor/controller"
import * as HostedObservability from "@rika/product/hosted-observability"
import { CellTerminalSettlementGraceMillis } from "@rika/remote-execution/cells"
import {
  redactAccess,
  type AccessWire,
  type ApiMessage as ApiMessageValue,
  type CellLifecycleFrame,
  type CellResponse,
} from "@rika/remote-execution/protocol"
import { Cause, Clock, DateTime, Deferred, Effect, Exit, Option, Ref, Semaphore } from "effect"
import type {
  ExecuteInput,
  ExecutionResult,
  GatewayError,
  LifecycleStore,
  OperationIdentity,
  PreparationStore,
  Socket,
} from "./contract"
import { GatewayError as GatewayFailure } from "./contract"
import { gatewayProtocol } from "./protocol"
import type { BindingCall, GatewaySession, MachineCall, PendingOperation } from "./rpc/model"

type Session = GatewaySession
type Pending = PendingOperation
type Terminal = Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }>
type Hydrate = (request: ExecuteInput) => Effect.Effect<void, GatewayError>

export interface GatewayExecutionDependencies {
  readonly controller: Controller
  readonly lifecycle: LifecycleStore
  readonly preparation: PreparationStore
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly pending: Ref.Ref<Map<string, Pending>>
  readonly frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>
  readonly terminals: Ref.Ref<Map<string, Terminal>>
  readonly quiescing: Ref.Ref<Set<string>>
  readonly machineCalls: Ref.Ref<Map<string, MachineCall>>
  readonly machineLock: Semaphore.Semaphore
  readonly admission: Semaphore.Semaphore
  readonly awaitSession: (assignmentId: string) => Effect.Effect<Session>
  readonly grant: (session: Session, operationKey: string) => Effect.Effect<void, GatewayError>
  readonly hydrate: () => Hydrate
  readonly send: (socket: Socket, message: ApiMessageValue) => void
}

const { accessFailure, expired, key, sameAccess } = gatewayProtocol

export const gatewayExecutionFactory = (dependencies: GatewayExecutionDependencies) => {
  const {
    controller,
    lifecycle,
    preparation,
    sessions,
    pending,
    frames,
    terminals,
    quiescing,
    machineCalls,
    machineLock,
    admission,
    awaitSession,
    grant,
    hydrate,
    send,
  } = dependencies

  const durableResult = Effect.fn("ExecutorGateway.durableResult")(function* (
    durable: Effect.Success<ReturnType<LifecycleStore["inspect"]>>,
    access?: AccessWire,
  ): Effect.fn.Return<ExecutionResult | undefined, GatewayError> {
    if (durable.state !== "completed" && durable.state !== "unknown") return undefined
    if (durable.response === undefined || durable.outcome === undefined)
      return yield* GatewayFailure.make({ kind: "transport", message: "Persisted executor terminal is incomplete" })
    return access === undefined
      ? { response: durable.response, outcome: durable.outcome }
      : { access, response: durable.response, outcome: durable.outcome }
  })

  const sendCellExecute = (operation: Pending) =>
    Effect.try({
      try: () =>
        send(operation.socket, {
          _tag: "CellExecute",
          request: {
            access: operation.access,
            operationKey: operation.request.operationKey,
            workspaceId: operation.request.workspaceId,
            sessionId: operation.request.sessionId,
            threadId: operation.request.threadId,
            turnId: operation.request.turnId,
            runId: operation.request.runId,
            toolCallId: operation.request.toolCallId,
            code: operation.request.code,
            rootRunId: operation.request.rootRunId,
            attempt: operation.request.attempt,
            replayPolicy: operation.request.replayPolicy,
            admittedAt: operation.request.admittedAt,
            deadlineAt: operation.request.deadlineAt,
            bindings: operation.bindings.manifest,
          },
        }),
      catch: () => undefined,
    }).pipe(Effect.ignore)

  const retireOperation = Effect.fn("ExecutorGateway.retireOperation")(function* (
    pendingKey: string,
    operation: Pick<Pending, "assignmentId" | "operationKey" | "attempt" | "result">,
  ) {
    const retired = yield* Ref.modify(pending, (current) => {
      if (current.get(pendingKey)?.result !== operation.result) return [false, current] as const
      const next = new Map(current)
      next.delete(pendingKey)
      return [true, next] as const
    })
    if (!retired) return
    const prefix = `${operation.assignmentId}\u0000${operation.operationKey}\u0000${operation.attempt}\u0000`
    yield* Effect.all(
      [
        Ref.update(terminals, (current) => new Map([...current].filter(([entryKey]) => entryKey !== pendingKey))),
        Ref.update(frames, (current) => new Map([...current].filter(([entryKey]) => entryKey !== pendingKey))),
        machineLock.withPermits(1)(
          Ref.update(
            machineCalls,
            (current) => new Map([...current].filter(([callKey]) => !callKey.startsWith(prefix))),
          ),
        ),
      ],
      { discard: true },
    )
  })

  const complete = Effect.fn("ExecutorGateway.complete")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    response: CellResponse,
  ) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const pendingKey = key(access.fence.assignmentId, operationKey, attempt)
        const operation = (yield* Ref.get(pending)).get(pendingKey)
        if (operation?.socket !== socket || operation.attempt !== attempt || !sameAccess(operation.access, access))
          return
        const terminal = (yield* Ref.get(terminals)).get(pendingKey)
        if (terminal === undefined || !gatewayProtocol.equivalentResponse(terminal.response, response)) return
        const session = (yield* Ref.get(sessions)).get(access.fence.assignmentId)
        if (session?.socket !== socket || !sameAccess(session.access, operation.access)) return
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt)
          yield* Deferred.fail(operation.result, expired())
        else
          yield* controller.validateAccess(redactAccess(operation.access)).pipe(
            Effect.matchEffect({
              onFailure: (error) => Deferred.fail(operation.result, accessFailure(error)),
              onSuccess: () =>
                Deferred.succeed(operation.result, { access: operation.access, response, outcome: terminal.outcome }),
            }),
          )
        yield* retireOperation(pendingKey, operation)
      }),
    )
  })

  const settleCancelledOperation = Effect.fn("ExecutorGateway.settleCancelledOperation")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
  ) {
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Ref.modify(machineCalls, (current) => {
          const cancelled = [...current].filter(
            ([, call]) =>
              call.assignmentId === assignmentId && call.operationKey === operationKey && call.attempt === attempt,
          )
          return [
            cancelled.map(([, call]) => call.result),
            new Map([...current].filter(([entry]) => !cancelled.some(([cancelledKey]) => cancelledKey === entry))),
          ] as const
        }).pipe(
          Effect.flatMap((results) =>
            Effect.forEach(results, (result) => Deferred.succeed(result, { _tag: "Cancelled" }), { discard: true }),
          ),
        ),
      ),
    )
    const operation = (yield* Ref.get(pending)).get(key(assignmentId, operationKey, attempt))
    if (operation === undefined) return
    yield* Effect.forEach(
      [...(yield* Ref.get(operation.bindingCalls)).values()],
      (call) => Deferred.await(call.result),
      {
        concurrency: "unbounded",
        discard: true,
      },
    )
  })

  const resolveDeadline = (request: ExecuteInput) =>
    lifecycle.resolveDeadline(request).pipe(
      Effect.tap((resolution) => {
        if (resolution._tag !== "Resolved") return Effect.void
        const correlation = {
          threadId: request.threadId,
          turnId: request.turnId,
          runId: request.runId,
          operationId: request.operationKey,
          cellId: request.toolCallId,
        }
        if (resolution.result.outcome === "unknown") return HostedObservability.unknownOutcome(correlation)
        let outcome: "success" | "interrupted" | "failure" = "failure"
        if (resolution.result.outcome === "completed") outcome = "success"
        if (resolution.result.outcome === "cancelled") outcome = "interrupted"
        return HostedObservability.event("terminal", outcome, correlation)
      }),
      Effect.map((resolution) => resolution.result),
    )

  const sendCancel = (request: ExecuteInput) =>
    Ref.get(sessions).pipe(
      Effect.flatMap((current) => {
        const session = current.get(request.assignmentId)
        if (session === undefined || !session.ready) return Effect.void
        return Effect.try({
          try: () =>
            send(session.socket, {
              _tag: "CellCancel",
              access: session.access,
              operationKey: request.operationKey,
              attempt: request.attempt,
            }),
          catch: () => undefined,
        }).pipe(Effect.ignore)
      }),
    )

  const waitFor = (result: Deferred.Deferred<ExecutionResult, GatewayError> | undefined, millis: number) =>
    result === undefined
      ? Effect.sleep(millis).pipe(Effect.as(Option.none<ExecutionResult>()))
      : Deferred.await(result).pipe(Effect.timeoutOption(millis))

  const awaitSettlement = (
    request: ExecuteInput,
    result?: Deferred.Deferred<ExecutionResult, GatewayError>,
  ): Effect.Effect<ExecutionResult, GatewayError> =>
    Effect.gen(function* () {
      const deadline = DateTime.toEpochMillis(DateTime.makeUnsafe(request.deadlineAt))
      const now = yield* Clock.currentTimeMillis
      if (now < deadline) {
        const completed = yield* waitFor(result, deadline - now)
        return Option.isSome(completed) ? completed.value : yield* awaitSettlement(request, result)
      }
      const durable = yield* lifecycle.inspect(request)
      const terminal = yield* durableResult(durable)
      if (terminal !== undefined) return terminal
      if (durable.state !== "dispatched") return yield* resolveDeadline(request)
      const settlementRemaining = deadline + CellTerminalSettlementGraceMillis - now
      if (settlementRemaining <= 0) {
        const settled = yield* resolveDeadline(request)
        if (settled.outcome === "unknown") yield* sendCancel(request)
        return settled
      }
      const completed = yield* waitFor(result, Math.min(100, settlementRemaining))
      return Option.isSome(completed) ? completed.value : yield* awaitSettlement(request, result)
    })

  const makePending = Effect.fn("ExecutorGateway.makePending")(function* (
    request: ExecuteInput,
    session: Session,
    result: Deferred.Deferred<ExecutionResult, GatewayError>,
  ) {
    return {
      assignmentId: request.assignmentId,
      operationKey: request.operationKey,
      attempt: request.attempt,
      request,
      socket: session.socket,
      access: session.access,
      result,
      waiters: 1,
      bindings: request.bindings,
      bindingCalls: yield* Ref.make(new Map<string, BindingCall>()),
      bindingAccess: yield* Semaphore.make(1),
      nextMachineOrdinal: yield* Ref.make(0),
    } satisfies Pending
  })

  const settledPending = (request: ExecuteInput, session: Session, result: ExecutionResult) =>
    Deferred.make<ExecutionResult, GatewayError>().pipe(
      Effect.tap((deferred) => Deferred.succeed(deferred, result)),
      Effect.flatMap((deferred) => makePending(request, session, deferred)),
    )

  const existingAdmission = Effect.fn("ExecutorGateway.existingAdmission")(function* (
    request: ExecuteInput,
    session: Session,
    pendingKey: string,
  ) {
    const durable = yield* lifecycle.inspect(request)
    const restored = yield* durableResult(durable, session.access)
    if (restored !== undefined) return yield* settledPending(request, session, restored)
    if ((yield* Clock.currentTimeMillis) >= DateTime.toEpochMillis(DateTime.makeUnsafe(request.deadlineAt))) {
      const result =
        durable.state === "dispatched"
          ? yield* Deferred.make<ExecutionResult, GatewayError>()
          : yield* settledPending(request, session, yield* resolveDeadline(request)).pipe(
              Effect.map((operation) => operation.result),
            )
      return yield* makePending(request, session, result)
    }
    const terminal = (yield* Ref.get(terminals)).get(pendingKey)
    if (terminal !== undefined)
      return yield* settledPending(request, session, {
        access: session.access,
        response: terminal.response,
        outcome: terminal.outcome,
      })
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
        GatewayFailure.make({
          kind: "disconnected",
          message: "Executor connection was replaced before returning a result",
        }),
      )
    }
    const created = yield* makePending(request, session, yield* Deferred.make<ExecutionResult, GatewayError>())
    yield* Ref.update(pending, (current) => new Map(current).set(pendingKey, created))
    yield* sendCellExecute(created)
    return created
  })

  const admit = Effect.fn("ExecutorGateway.admit")(function* (request: ExecuteInput, pendingKey: string) {
    const session = (yield* Ref.get(sessions)).get(request.assignmentId)
    if (session === undefined || !session.ready)
      return yield* GatewayFailure.make({ kind: "disconnected", message: "Executor workspace is not ready" })
    if ((yield* Ref.get(quiescing)).has(request.assignmentId))
      return yield* GatewayFailure.make({ kind: "fenced", message: "Executor is quiescing" })
    if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
    yield* controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
    yield* preparation.ready(session.access)
    yield* grant(session, request.operationKey)
    yield* hydrate()(request)
    return (
      (yield* existingAdmission(request, session, pendingKey)) ??
      (yield* dispatchAdmission(request, session, pendingKey))
    )
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

  const execute: (input: ExecuteInput) => Effect.Effect<ExecutionResult, GatewayError> = Effect.fn(
    "ExecutorGateway.execute",
  )(function* (input) {
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
    const pendingKey = key(input.assignmentId, input.operationKey, input.attempt)
    const poll = (sentTo?: Socket): Effect.Effect<ExecutionResult, GatewayError> =>
      Effect.gen(function* () {
        const terminal = yield* lifecycle.inspect(input).pipe(Effect.flatMap((durable) => durableResult(durable)))
        if (terminal !== undefined) return terminal
        const session = (yield* Ref.get(sessions)).get(input.assignmentId)
        const nextSocket = session === undefined || !session.ready ? sentTo : session.socket
        if (session !== undefined && session.ready && session.socket !== sentTo) {
          yield* controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
          yield* Effect.try({
            try: () =>
              send(session.socket, {
                _tag: "CellCancel",
                access: session.access,
                operationKey: input.operationKey,
                attempt: input.attempt,
              }),
            catch: () => GatewayFailure.make({ kind: "transport", message: "Could not cancel executor operation" }),
          })
        }
        const operation = (yield* Ref.get(pending)).get(pendingKey)
        const completed =
          operation === undefined
            ? yield* Effect.sleep("100 millis").pipe(Effect.as(Option.none<ExecutionResult>()))
            : yield* Deferred.await(operation.result).pipe(Effect.timeoutOption("100 millis"))
        return Option.isSome(completed) ? completed.value : yield* poll(nextSocket)
      })
    return yield* poll()
  })

  return { execute, cancel, complete, settleCancelledOperation, sendCellExecute }
}
