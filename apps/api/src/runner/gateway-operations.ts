import type { HostedExecutionOperationsService } from "@rika/product-store/executor-operations"
import { HostedExecutionOperationsError } from "@rika/product-store/executor-operations"
import type { ToolOperationResponse } from "@rika/product/tool-operation-lifecycle"
import {
  AssignmentLeaseEpoch,
  EventId,
  ExecutorAssignmentId,
  FencingGeneration,
  IdempotencyKey,
  Sequence,
} from "@rika/product/hosted-model"
import type { HostedThreadEventStore } from "@rika/product/hosted-thread-event-store"
import { redactAccess } from "@rika/remote-execution/protocol"
import { Cause, Clock, DateTime, Deferred, Effect, Exit, Ref, Semaphore } from "effect"
import type { GatewayError, OperationIdentity, OperationInput } from "../executor/gateway"
import type { RunnerExecutorAuthority } from "./executor"
import { gatewayModel, type FinalResult, type LocalExecuteInput, type Pending, type Session } from "./gateway-model"

const terminalSettlementGraceMillis = 6_000
const cancelledResponse: ToolOperationResponse = {
  _tag: "DomainFailure",
  failure: { kind: "cancelled", message: "Tool operation cancelled" },
}

interface OperationDependencies {
  readonly authority: RunnerExecutorAuthority
  readonly operations: HostedExecutionOperationsService
  readonly store: HostedThreadEventStore["Service"]
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly pending: Ref.Ref<Map<string, Pending>>
  readonly gatewayLock: Semaphore.Semaphore
  readonly prepare: (
    input: OperationInput,
  ) => Effect.Effect<import("@rika/product-store/executor-operations").OperationRecord, GatewayError>
  readonly claimDispatch: (input: {
    readonly session: Session
    readonly operationKey: string
    readonly attempt: number
  }) => Effect.Effect<void, GatewayError>
  readonly identifyOperation: (input: OperationIdentity) => Effect.Effect<string, GatewayError>
  readonly matchesOperation: (
    input: OperationIdentity,
    row: import("@rika/product-store/executor-operations").OperationRecord,
    digest: string,
  ) => boolean
  readonly finalize: (input: {
    readonly assignmentId?: string
    readonly operationKey: string
    readonly attempt: number
    readonly response: ToolOperationResponse
    readonly state: "completed" | "unknown"
  }) => Effect.Effect<FinalResult, GatewayError>
  readonly settlePending: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    result: FinalResult,
  ) => Effect.Effect<void>
  readonly retirePending: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    expected?: Pending,
  ) => Effect.Effect<Pending | undefined>
  readonly runNative: (operation: Pending) => Effect.Effect<void>
  readonly cancelNative: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
  ) => Effect.Effect<void, GatewayError>
}

export const runnerGatewayOperations = (dependencies: OperationDependencies) => {
  const {
    authority,
    operations,
    store,
    sessions,
    pending,
    gatewayLock,
    prepare,
    claimDispatch,
    identifyOperation,
    matchesOperation,
    finalize,
    settlePending,
    retirePending,
    runNative,
    cancelNative,
  } = dependencies
  const { failure, finalResult, operationKey: key, sameFence: same, timeoutResponse, unknownResponse } = gatewayModel

  const recoverTerminals = Effect.fn("RunnerGateway.recoverTerminals")(function* () {
    const rows = yield* operations.terminalRecoveryScan.pipe(
      Effect.mapError(() => failure("transport", "Could not inspect Runner terminal receipts")),
    )
    return yield* Effect.forEach(rows, (row) =>
      finalize({
        assignmentId: row.assignmentId,
        operationKey: row.operationKey,
        attempt: row.attempt,
        response: row.frame.response,
        state: row.frame.outcome === "unknown" ? "unknown" : "completed",
      }).pipe(
        Effect.flatMap((result) => settlePending(row.assignmentId, row.operationKey, row.attempt, result)),
        Effect.as<GatewayError | undefined>(undefined),
        Effect.catch((error) => Effect.succeed<GatewayError | undefined>(error)),
      ),
    )
  })

  const terminalizeAccepted = Effect.fn("RunnerGateway.terminalizeAccepted")(function* (
    input: OperationIdentity,
    terminalResponse: ToolOperationResponse,
    outcome: "failed" | "cancelled",
  ) {
    const current = yield* operations
      .findOperation(input)
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
    if (current === undefined) return yield* failure("transport", "Runner operation is unavailable")
    if (current.state === "completed" || current.state === "unknown") {
      if (current.response === null || current.terminalOutcome === null)
        return yield* failure("transport", "Persisted Runner terminal outcome is missing")
      return { response: current.response, outcome: current.terminalOutcome, eventPersisted: true }
    }
    if (current.state === "dispatched") return undefined
    const terminalized = yield* operations
      .terminalizeAccepted(input, terminalResponse, outcome, (result) =>
        store
          .appendEvent({
            eventId: EventId.make(input.operationKey),
            idempotencyKey: IdempotencyKey.make(input.operationKey),
            assignmentId: ExecutorAssignmentId.make(input.assignmentId),
            assignmentGeneration: FencingGeneration.make(String(result.assignmentGeneration)),
            leaseEpoch: AssignmentLeaseEpoch.make(String(result.leaseEpoch)),
            commandSequence: Sequence.make(String(result.commandSequence)),
            event: { _tag: "ToolResult", operationKey: input.operationKey, response: terminalResponse },
          })
          .pipe(Effect.mapError((cause) => HostedExecutionOperationsError.make({ message: cause.message }))),
      )
      .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner terminal")))
    if (terminalized !== undefined) return finalResult(terminalResponse, outcome)
    const changed = yield* operations
      .findOperation(input)
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
    if (changed === undefined) return yield* failure("transport", "Runner operation is unavailable")
    if (changed.state === "completed" || changed.state === "unknown") {
      if (changed.response === null || changed.terminalOutcome === null)
        return yield* failure("transport", "Persisted Runner terminal outcome is missing")
      return finalResult(changed.response, changed.terminalOutcome)
    }
    return undefined
  })

  const waitForTerminal = (input: LocalExecuteInput): Effect.Effect<FinalResult, GatewayError> =>
    Effect.gen(function* () {
      yield* recoverTerminals().pipe(Effect.ignore)
      const row = yield* operations
        .findOperation(input)
        .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
      if (row === undefined) return yield* failure("transport", "Runner operation is unavailable")
      if (row.state === "completed" || row.state === "unknown") {
        if (row.response === null || row.terminalOutcome === null)
          return yield* failure("transport", "Persisted Runner terminal outcome is missing")
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
        return finalResult(row.response, row.terminalOutcome, session?.access)
      }
      const deadlineAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(input.deadlineAt))
      const settlementDeadlineAtMillis = deadlineAtMillis + terminalSettlementGraceMillis
      const now = yield* Clock.currentTimeMillis
      if (now >= deadlineAtMillis && row.state === "accepted") {
        const timedOut = yield* terminalizeAccepted(input, timeoutResponse, "failed")
        if (timedOut !== undefined) return timedOut
      }
      if (now >= settlementDeadlineAtMillis) {
        yield* cancelNative(input.assignmentId, input.operationKey, input.attempt)
        return yield* finalize({
          assignmentId: input.assignmentId,
          operationKey: input.operationKey,
          attempt: input.attempt,
          response: unknownResponse,
          state: "unknown",
        })
      }
      const nextBoundary = now < deadlineAtMillis ? deadlineAtMillis : settlementDeadlineAtMillis
      return yield* Effect.sleep(Math.min(100, nextBoundary - now)).pipe(Effect.andThen(waitForTerminal(input)))
    })

  const awaitResult = Effect.fn("RunnerGateway.awaitResult")(function* (
    result: Deferred.Deferred<FinalResult, GatewayError>,
    input: LocalExecuteInput,
  ) {
    const remaining = Math.max(
      0,
      DateTime.toEpochMillis(DateTime.makeUnsafe(input.deadlineAt)) - (yield* Clock.currentTimeMillis),
    )
    return yield* Deferred.await(result).pipe(
      Effect.timeoutOrElse({ duration: remaining, orElse: () => waitForTerminal(input) }),
    )
  })

  const awaitSession = (input: LocalExecuteInput): Effect.Effect<Session | undefined> =>
    Effect.gen(function* () {
      const session = (yield* Ref.get(sessions)).get(input.assignmentId)
      if (session !== undefined) return session
      if ((yield* Clock.currentTimeMillis) >= DateTime.toEpochMillis(DateTime.makeUnsafe(input.deadlineAt)))
        return undefined
      return yield* Effect.sleep("100 millis").pipe(Effect.andThen(awaitSession(input)))
    })

  const execute = Effect.fn("RunnerGateway.execute")(function* (input: LocalExecuteInput) {
    yield* recoverTerminals().pipe(Effect.ignore)
    const durable = yield* prepare(input)
    const request: LocalExecuteInput = { ...input, admittedAt: durable.admittedAt, deadlineAt: durable.deadlineAt }
    const pendingKey = key(request.assignmentId, request.operationKey, request.attempt)
    const existingPending = yield* gatewayLock.withPermits(1)(
      Ref.get(pending).pipe(Effect.map((current) => current.get(pendingKey))),
    )
    if (existingPending !== undefined) {
      if (existingPending.code !== request.code)
        return yield* failure("fenced", "Runner operation identity conflicts with a different tool request")
      return yield* awaitResult(existingPending.result, request)
    }
    if (durable.state === "completed" || durable.state === "unknown") {
      if (durable.response === null || durable.terminalOutcome === null)
        return yield* failure("transport", "Persisted Runner terminal outcome is missing")
      const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(request.assignmentId)))
      return finalResult(durable.response, durable.terminalOutcome, session?.access)
    }
    const session = yield* awaitSession(request)
    if (session === undefined) return yield* waitForTerminal(request)
    const workspace = yield* authority
      .workspaceIdentity(redactAccess(session.access))
      .pipe(Effect.mapError((error) => failure("fenced", error.message)))
    const setup = yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const currentPending = (yield* Ref.get(pending)).get(pendingKey)
        if (currentPending !== undefined) {
          if (currentPending.code !== request.code)
            return yield* failure("fenced", "Runner operation identity conflicts with a different tool request")
          return { existing: currentPending } as const
        }
        const currentSession = (yield* Ref.get(sessions)).get(request.assignmentId)
        if (
          currentSession === undefined ||
          currentSession.socket !== session.socket ||
          !same(currentSession.access, session.access)
        )
          return yield* failure("disconnected", "Runner disconnected before dispatch")
        yield* authority
          .validateAccess(redactAccess(currentSession.access))
          .pipe(Effect.mapError((error) => failure("fenced", error.message)))
        const currentOperation = yield* prepare(request)
        if (currentOperation.state === "accepted")
          yield* claimDispatch({
            session: currentSession,
            operationKey: request.operationKey,
            attempt: currentOperation.attempt,
          })
        else if (
          currentOperation.state !== "dispatched" ||
          currentOperation.dispatchedGeneration !== currentSession.access.fence.assignmentGeneration ||
          currentOperation.dispatchedExecutorInstanceId !== currentSession.access.fence.executorId ||
          currentOperation.dispatchedProcessIncarnation !== currentSession.access.fence.processIncarnation
        )
          return yield* failure("fenced", "Runner operation was dispatched to a different executor")
        const current: Pending = {
          assignmentId: request.assignmentId,
          operationKey: request.operationKey,
          attempt: currentOperation.attempt,
          code: request.code,
          workspaceId: workspace,
          request,
          socket: currentSession.socket,
          access: currentSession.access,
          result: yield* Deferred.make<FinalResult, GatewayError>(),
        }
        yield* Ref.update(pending, (values) => new Map(values).set(pendingKey, current))
        yield* runNative(current)
        return { current } as const
      }),
    )
    if ("existing" in setup) return yield* awaitResult(setup.existing.result, request)
    return yield* awaitResult(setup.current.result, request).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : retirePending(request.assignmentId, request.operationKey, request.attempt, setup.current).pipe(
              Effect.ignore,
            ),
      ),
    )
  })

  const cancel = Effect.fn("RunnerGateway.cancel")(function* (input: OperationIdentity) {
    const row = yield* operations
      .findOperation(input)
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
    if (row === undefined) return yield* failure("transport", "Runner operation is unavailable")
    const digest = yield* identifyOperation(input)
    if (!matchesOperation(input, row, digest))
      return yield* failure("fenced", "Runner operation key conflicts with a different request")
    const accepted = yield* terminalizeAccepted(input, cancelledResponse, "cancelled")
    if (accepted !== undefined) return accepted
    const pendingKey = key(input.assignmentId, input.operationKey, input.attempt)
    const cancellationDeadlineAtMillis =
      DateTime.toEpochMillis(DateTime.makeUnsafe(row.deadlineAt)) + terminalSettlementGraceMillis
    const awaitTerminal = (): Effect.Effect<FinalResult, GatewayError> =>
      Effect.gen(function* () {
        yield* recoverTerminals().pipe(Effect.ignore)
        const current = yield* operations
          .findOperation(input)
          .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
        if (current === undefined) return yield* failure("transport", "Runner operation is unavailable")
        if (current.state === "completed" || current.state === "unknown") {
          if (current.response === null || current.terminalOutcome === null)
            return yield* failure("transport", "Persisted Runner terminal outcome is missing")
          const session = (yield* Ref.get(sessions)).get(input.assignmentId)
          const result = finalResult(current.response, current.terminalOutcome, session?.access)
          yield* settlePending(input.assignmentId, input.operationKey, input.attempt, result)
          return result
        }
        const now = yield* Clock.currentTimeMillis
        if (now >= cancellationDeadlineAtMillis) {
          yield* cancelNative(input.assignmentId, input.operationKey, input.attempt).pipe(Effect.ignore)
          const result = yield* finalize({
            assignmentId: input.assignmentId,
            operationKey: input.operationKey,
            attempt: input.attempt,
            response: unknownResponse,
            state: "unknown",
          })
          yield* settlePending(input.assignmentId, input.operationKey, input.attempt, result)
          return result
        }
        if (current.state === "accepted") {
          const terminal = yield* terminalizeAccepted(input, cancelledResponse, "cancelled")
          if (terminal !== undefined) return terminal
        }
        yield* cancelNative(input.assignmentId, input.operationKey, input.attempt).pipe(Effect.ignore)
        const remaining = Math.max(0, cancellationDeadlineAtMillis - now)
        const pendingOperation = (yield* Ref.get(pending)).get(pendingKey)
        if (pendingOperation !== undefined) {
          const completed = yield* Effect.raceFirst(
            Deferred.await(pendingOperation.result).pipe(
              Effect.map((result) => ({ _tag: "Completed" as const, result })),
            ),
            Effect.sleep(Math.min(100, remaining)).pipe(Effect.as({ _tag: "Polling" as const })),
          )
          if (completed._tag === "Completed") return completed.result
        } else yield* Effect.sleep(Math.min(100, remaining))
        return yield* awaitTerminal()
      })
    return yield* awaitTerminal()
  })

  const pollAccepted = recoverTerminals().pipe(
    Effect.flatMap((failures) => {
      const errors = failures.filter((error): error is GatewayError => error !== undefined)
      const first = errors[0]
      return first === undefined
        ? Effect.void
        : Effect.logError("runner-recovery.failed").pipe(
            Effect.annotateLogs({
              "rika.error.kind": first.kind,
              "rika.error.message": first.message,
              "rika.recovery.failures": errors.length,
            }),
          )
    }),
  )
  const recovery = Effect.forever(
    Effect.sleep("1 second").pipe(
      Effect.andThen(pollAccepted),
      Effect.catch((error) =>
        Effect.logError("runner-recovery.poll-failed").pipe(
          Effect.annotateLogs({ "rika.error.kind": error.kind, "rika.error.message": error.message }),
        ),
      ),
    ),
  )
  return { execute, cancel, recovery }
}
