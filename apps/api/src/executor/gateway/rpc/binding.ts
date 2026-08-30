import * as HostedObservability from "@rika/product/hosted-observability"
import type { AccessWire, ApiMessage, BindingOutcome, BindingRequest } from "@rika/remote-execution/protocol"
import { Clock, Crypto, DateTime, Deferred, Effect, Ref, type Semaphore } from "effect"
import { invokeAdmittedTool, type HostedToolPolicyService } from "../../../hosted/execution/tool-policy"
import { GatewayError, type Socket } from "../contract"
import type { GatewaySession, PendingOperation } from "./model"
import { gatewayProtocol } from "../protocol"

interface BindingCorrelation {
  threadId: string
  turnId: string
  runId: string
  operationId: string
  cellId?: string
  bindingId: string
}

export interface BindingRpcDependencies {
  readonly sessions: Ref.Ref<Map<string, GatewaySession>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly pending: Ref.Ref<Map<string, PendingOperation>>
  readonly admission: Semaphore.Semaphore
  readonly digest: (value: string) => Effect.Effect<string, GatewayError>
  readonly toolPolicy: HostedToolPolicyService
  readonly crypto: Crypto.Crypto
  readonly send: (socket: Socket, message: ApiMessage) => void
}

const deadlineOutcome: BindingOutcome = {
  _tag: "Unknown",
  message: "Cell binding outcome is unknown at the operation deadline",
}

const observedOutcome = (outcome: BindingOutcome) => {
  if (outcome._tag === "Unknown") return "unknown" as const
  return outcome._tag === "Rejected" ? ("failure" as const) : ("success" as const)
}

export const bindingRpcFactory = (dependencies: BindingRpcDependencies) => {
  const authorize = Effect.fn("ExecutorGateway.binding.authorize")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    requestDigest: string,
    request: BindingRequest,
  ) {
    return yield* dependencies.admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = (yield* Ref.get(dependencies.assignments)).get(socket)
        if (assignmentId === undefined)
          return yield* GatewayError.make({ kind: "fenced", message: "Binding call came from an unknown executor" })
        const operation = (yield* Ref.get(dependencies.pending)).get(
          gatewayProtocol.key(assignmentId, operationKey, attempt),
        )
        if (operation === undefined || (yield* Deferred.isDone(operation.result))) return undefined
        if (
          operation.socket !== socket ||
          operation.attempt !== attempt ||
          !gatewayProtocol.sameAccess(operation.access, access) ||
          request.sessionId !== operation.request.sessionId ||
          request.cellId !== operation.request.toolCallId
        )
          return yield* GatewayError.make({ kind: "fenced", message: "Binding call has a stale cell identity" })
        if ((yield* dependencies.digest(gatewayProtocol.encodeBindingRequest(request))) !== requestDigest)
          return yield* GatewayError.make({ kind: "fenced", message: "Binding call request digest is invalid" })
        return operation
      }),
    )
  })

  const invoke = Effect.fn("ExecutorGateway.binding.invoke")(function* (
    operation: PendingOperation,
    access: AccessWire,
    operationKey: string,
    callId: string,
    request: BindingRequest,
    result: Deferred.Deferred<BindingOutcome>,
    remaining: number,
  ) {
    const correlation: BindingCorrelation = {
      threadId: operation.request.threadId,
      turnId: operation.request.turnId,
      runId: operation.request.runId,
      operationId: operationKey,
      bindingId: callId,
    }
    if (request.cellId !== undefined) correlation.cellId = request.cellId
    yield* HostedObservability.event("binding_send", "success", correlation)
    const outcome = yield* HostedObservability.observe(
      "binding_terminal",
      correlation,
      invokeAdmittedTool({
        policyService: dependencies.toolPolicy,
        threadId: operation.request.threadId,
        turnId: operation.request.turnId,
        workspaceId: operation.request.workspaceId,
        operationKey,
        callId,
        request,
        access,
        invoke: operation.bindings.registry.invoke({ ...request, input: request.input }),
      }).pipe(
        Effect.provideContext(operation.bindings.context),
        Effect.provideService(Crypto.Crypto, dependencies.crypto),
        Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.succeed(deadlineOutcome) }),
        Effect.orElseSucceed(
          (): BindingOutcome => ({ _tag: "Unknown", message: "Tool admission could not durably record its decision" }),
        ),
        Effect.onInterrupt(() => Deferred.succeed(result, deadlineOutcome).pipe(Effect.asVoid)),
      ),
      observedOutcome,
    )
    yield* Deferred.succeed(result, outcome)
  })

  const sendResult = Effect.fn("ExecutorGateway.binding.sendResult")(function* (
    operation: PendingOperation,
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    callId: string,
    requestDigest: string,
    outcome: BindingOutcome,
  ) {
    yield* dependencies.admission.withPermits(1)(
      Effect.gen(function* () {
        const assigned = (yield* Ref.get(dependencies.assignments)).get(socket)
        const session = (yield* Ref.get(dependencies.sessions)).get(operation.assignmentId)
        if (
          assigned !== operation.assignmentId ||
          session?.socket !== socket ||
          !gatewayProtocol.sameAccess(session.access, access)
        )
          return yield* GatewayError.make({ kind: "disconnected", message: "Binding result has no current executor" })
        dependencies.send(socket, {
          _tag: "BindingResult",
          access,
          operationKey,
          attempt,
          callId,
          requestDigest,
          outcome,
        })
      }),
    )
  })

  const receive = Effect.fn("ExecutorGateway.binding.receive")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    callId: string,
    requestDigest: string,
    request: BindingRequest,
  ) {
    const operation = yield* authorize(socket, access, operationKey, attempt, requestDigest, request)
    if (operation === undefined) return
    yield* operation.bindingAccess.withPermits(1)(
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<BindingOutcome>()
        const call = yield* Ref.modify(operation.bindingCalls, (current) => {
          const known = current.get(callId)
          if (known !== undefined) return [known, current] as const
          const created = { requestDigest, result: candidate }
          return [created, new Map(current).set(callId, created)] as const
        })
        if (call.requestDigest !== requestDigest)
          return yield* GatewayError.make({
            kind: "fenced",
            message: "Binding call id conflicts with a different request",
          })
        const remaining = Math.max(
          0,
          DateTime.toEpochMillis(DateTime.makeUnsafe(operation.request.deadlineAt)) - (yield* Clock.currentTimeMillis),
        )
        if (call.result === candidate)
          yield* invoke(operation, access, operationKey, callId, request, candidate, remaining)
        const outcome = yield* Deferred.await(call.result).pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () =>
              Deferred.succeed(call.result, deadlineOutcome).pipe(Effect.andThen(Deferred.await(call.result))),
          }),
        )
        yield* sendResult(operation, socket, access, operationKey, attempt, callId, requestDigest, outcome)
      }),
    )
  })

  return { receive }
}
