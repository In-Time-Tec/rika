import type * as MachineBindings from "@rika/kernel/machine-bindings"
import type { AccessWire, BindingOutcome, BindingRequest, MachineOutcome } from "@rika/remote-execution/protocol"
import { Clock, Crypto, DateTime, Deferred, Effect, Ref, Semaphore } from "effect"
import type { GatewayError, Socket } from "../executor/gateway"
import { invokeAdmittedTool, type HostedToolPolicyService } from "../hosted/execution/tool-policy"
import { gatewayModel, type MachineCall, type Pending, type Session } from "./gateway-model"

const { encode, encodeBindingRequest, encodeMachineRequest, failure, machineKey, operationKey, sameFence } =
  gatewayModel

interface CallState {
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly pending: Ref.Ref<Map<string, Pending>>
  readonly machineCalls: Ref.Ref<Map<string, MachineCall>>
  readonly gatewayLock: Semaphore.Semaphore
  readonly machineLock: Semaphore.Semaphore
}

interface CallDependencies {
  readonly crypto: Crypto.Crypto
  readonly toolPolicy: HostedToolPolicyService
  readonly requestDigest: (value: string) => Effect.Effect<string, GatewayError>
  readonly send: (socket: Socket, frame: string) => void
  readonly state: CallState
}

const machineDeadlineOutcome: MachineOutcome = {
  _tag: "Unknown",
  message: "Machine outcome is unknown at the operation deadline",
}

export const runnerGatewayCalls = (dependencies: CallDependencies) => {
  const { crypto, requestDigest, send, state, toolPolicy } = dependencies
  const { assignments, gatewayLock, machineCalls, machineLock, pending, sessions } = state

  const settleMachine = Effect.fn("RunnerGateway.settleMachine")(function* (
    mapKey: string,
    call: MachineCall,
    outcome: MachineOutcome,
  ) {
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(call.result, outcome)
          yield* Ref.update(machineCalls, (current) => {
            if (current.get(mapKey)?.result !== call.result) return current
            const next = new Map(current)
            next.delete(mapKey)
            return next
          })
        }),
      ),
    )
    return yield* Deferred.await(call.result)
  })

  const sessionRegistered = Effect.fn("RunnerGateway.calls.sessionRegistered")(function* (session: Session) {
    yield* machineLock.withPermits(1)(
      Ref.update(machineCalls, (current) => {
        const next = new Map(current)
        for (const [callKey, call] of next)
          if (call.assignmentId === session.access.fence.assignmentId)
            next.set(callKey, { ...call, socket: session.socket, access: session.access })
        return next
      }),
    )
  })

  const replayMachineCalls = Effect.fn("RunnerGateway.calls.replayMachineCalls")(function* (session: Session) {
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          for (const [mapKey, call] of yield* Ref.get(machineCalls)) {
            if (call.assignmentId !== session.access.fence.assignmentId) continue
            if (now >= call.deadlineAtMillis) {
              yield* Deferred.succeed(call.result, machineDeadlineOutcome)
              yield* Ref.update(machineCalls, (current) => {
                if (current.get(mapKey)?.result !== call.result) return current
                const next = new Map(current)
                next.delete(mapKey)
                return next
              })
              continue
            }
            send(
              session.socket,
              encode({
                _tag: "MachineExecute",
                access: session.access,
                operationKey: call.operationKey,
                attempt: call.attempt,
                machineId: call.machineId,
                requestDigest: call.requestDigest,
                request: call.request,
              }),
            )
          }
        }),
      ),
    )
  })

  const receiveBinding = Effect.fn("RunnerGateway.receiveBinding")(function* (
    socket: Socket,
    access: AccessWire,
    operationKeyValue: string,
    attempt: number,
    callId: string,
    digest: string,
    request: BindingRequest,
  ) {
    const assignmentId = (yield* Ref.get(assignments)).get(socket)
    const pendingOperation =
      assignmentId === undefined
        ? undefined
        : (yield* Ref.get(pending)).get(operationKey(assignmentId, operationKeyValue, attempt))
    if (assignmentId === undefined) return yield* failure("fenced", "Local binding call has no executor")
    if (pendingOperation === undefined || (yield* Deferred.isDone(pendingOperation.result))) return
    if (
      pendingOperation.socket !== socket ||
      pendingOperation.attempt !== attempt ||
      !sameFence(pendingOperation.access, access) ||
      request.sessionId !== pendingOperation.request.sessionId ||
      request.cellId !== pendingOperation.request.toolCallId
    )
      return yield* failure("fenced", "Local binding call has a stale cell identity")
    return yield* pendingOperation.bindingLock.withPermits(1)(
      Effect.gen(function* () {
        const expected = yield* requestDigest(encodeBindingRequest(request))
        if (expected !== digest) return yield* failure("fenced", "Local binding request digest is invalid")
        const candidate = yield* Deferred.make<BindingOutcome>()
        const call = yield* Ref.modify(pendingOperation.bindingCalls, (current) => {
          const known = current.get(callId)
          if (known !== undefined) return [known, current] as const
          const created = { requestDigest: digest, result: candidate }
          return [created, new Map(current).set(callId, created)] as const
        })
        if (call.requestDigest !== digest)
          return yield* failure("fenced", "Local binding call id conflicts with a different request")
        const remaining = Math.max(
          0,
          DateTime.toEpochMillis(DateTime.makeUnsafe(pendingOperation.request.deadlineAt)) -
            (yield* Clock.currentTimeMillis),
        )
        const deadlineOutcome = {
          _tag: "Unknown" as const,
          message: "Cell binding outcome is unknown at the operation deadline",
        }
        if (call.result === candidate) {
          const outcome = yield* invokeAdmittedTool({
            policyService: toolPolicy,
            threadId: pendingOperation.request.threadId,
            turnId: pendingOperation.request.turnId,
            workspaceId: pendingOperation.request.workspaceId,
            operationKey: operationKeyValue,
            callId,
            request,
            access,
            invoke: pendingOperation.bindings.registry.invoke({ ...request, input: request.input }),
          }).pipe(
            Effect.provideContext(pendingOperation.bindings.context),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.succeed(deadlineOutcome) }),
            Effect.orElseSucceed(
              (): BindingOutcome => ({
                _tag: "Unknown",
                message: "Tool admission could not durably record its decision",
              }),
            ),
            Effect.onInterrupt(() => Deferred.succeed(candidate, deadlineOutcome).pipe(Effect.asVoid)),
          )
          yield* Deferred.succeed(candidate, outcome)
        }
        const outcome = yield* Deferred.await(call.result).pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () =>
              Deferred.succeed(call.result, deadlineOutcome).pipe(Effect.andThen(Deferred.await(call.result))),
          }),
        )
        yield* gatewayLock.withPermits(1)(
          Effect.gen(function* () {
            const assigned = (yield* Ref.get(assignments)).get(socket)
            const current = (yield* Ref.get(sessions)).get(pendingOperation.assignmentId)
            if (
              assigned !== pendingOperation.assignmentId ||
              current?.socket !== socket ||
              !sameFence(current.access, access)
            )
              return yield* failure("disconnected", "Local binding result has no executor")
            send(
              socket,
              encode({
                _tag: "BindingResult",
                access,
                operationKey: operationKeyValue,
                attempt,
                callId,
                requestDigest: digest,
                outcome,
              }),
            )
          }),
        )
      }),
    )
  })

  const settleCancelledOperation = Effect.fn("RunnerGateway.settleCancelledOperation")(function* (
    assignmentId: string,
    operationKeyValue: string,
    attempt: number,
  ) {
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(machineCalls)
          const next = new Map(current)
          for (const [mapKey, call] of current) {
            if (
              call.assignmentId !== assignmentId ||
              call.operationKey !== operationKeyValue ||
              call.attempt !== attempt
            )
              continue
            yield* Deferred.succeed(call.result, { _tag: "Cancelled" })
            next.delete(mapKey)
          }
          yield* Ref.set(machineCalls, next)
        }),
      ),
    )
    const pendingOperation = (yield* Ref.get(pending)).get(operationKey(assignmentId, operationKeyValue, attempt))
    if (pendingOperation === undefined) return
    const calls = [...(yield* Ref.get(pendingOperation.bindingCalls)).values()]
    yield* Effect.forEach(calls, (call) => Deferred.await(call.result), { concurrency: "unbounded", discard: true })
  })

  const receiveMachine = Effect.fn("RunnerGateway.receiveMachine")(function* (
    socket: Socket,
    access: AccessWire,
    operationKeyValue: string,
    attempt: number,
    machineId: string,
    digest: string,
    outcome: MachineOutcome,
  ) {
    yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = (yield* Ref.get(assignments)).get(socket)
        const current = assignmentId === undefined ? undefined : (yield* Ref.get(sessions)).get(assignmentId)
        if (assignmentId === undefined || current?.socket !== socket || !sameFence(current.access, access))
          return yield* failure("fenced", "Local machine result has no executor")
        const mapKey = machineKey(assignmentId, operationKeyValue, attempt, machineId)
        const call = (yield* Ref.get(machineCalls)).get(mapKey)
        if (call === undefined) return
        if (
          call.socket !== socket ||
          call.attempt !== attempt ||
          call.requestDigest !== digest ||
          !sameFence(call.access, access)
        )
          return yield* failure("fenced", "Local machine result conflicts with its request")
        yield* settleMachine(
          mapKey,
          call,
          (yield* Clock.currentTimeMillis) >= call.deadlineAtMillis ? machineDeadlineOutcome : outcome,
        )
      }),
    )
  })

  const retireOperation = Effect.fn("RunnerGateway.calls.retireOperation")(function* (
    assignmentId: string,
    operationKeyValue: string,
    attempt: number,
  ) {
    yield* machineLock.withPermits(1)(
      Ref.update(machineCalls, (current) => {
        const prefix = `${assignmentId}\u001f${operationKeyValue}\u001f${attempt}\u001f`
        return new Map(Array.from(current).filter(([callKey]) => !callKey.startsWith(prefix)))
      }),
    )
  })

  const machine = Effect.fn("RunnerGateway.machine")(function* (
    assignmentId: string,
    operationKeyValue: string,
    attempt: number,
    request: MachineBindings.Request,
  ) {
    const pendingOperation = (yield* Ref.get(pending)).get(operationKey(assignmentId, operationKeyValue, attempt))
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    if (pendingOperation === undefined || session === undefined)
      return yield* failure("disconnected", "Local cell authority is no longer available")
    const ordinal = yield* Ref.getAndUpdate(pendingOperation.nextMachineOrdinal, (current) => current + 1)
    const machineId = `${pendingOperation.request.toolCallId}:${ordinal}`
    const digest = yield* requestDigest(encodeMachineRequest(request))
    const result = yield* Deferred.make<MachineBindings.Outcome>()
    const mapKey = machineKey(assignmentId, operationKeyValue, attempt, machineId)
    const deadlineAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(pendingOperation.request.deadlineAt))
    const candidate: MachineCall = {
      assignmentId,
      operationKey: operationKeyValue,
      attempt,
      machineId,
      requestDigest: digest,
      request,
      socket: session.socket,
      access: session.access,
      deadlineAtMillis,
      result,
    }
    const admitted = yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(machineCalls)
          const known = current.get(mapKey)
          if ((yield* Clock.currentTimeMillis) >= deadlineAtMillis) {
            if (known !== undefined) {
              yield* Deferred.succeed(known.result, machineDeadlineOutcome)
              yield* Ref.set(machineCalls, new Map(Array.from(current).filter(([currentKey]) => currentKey !== mapKey)))
            }
            return { call: undefined, sent: true } as const
          }
          const call = known ?? candidate
          if (known !== undefined) return { call, sent: true } as const
          yield* Ref.set(machineCalls, new Map(current).set(mapKey, candidate))
          const sent = yield* Effect.try({
            try: () =>
              send(
                session.socket,
                encode({
                  _tag: "MachineExecute",
                  access: session.access,
                  operationKey: operationKeyValue,
                  attempt,
                  machineId,
                  requestDigest: digest,
                  request,
                }),
              ),
            catch: () => false,
          }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          return { call, sent } as const
        }),
      ),
    )
    const call = admitted.call
    if (call === undefined) return machineDeadlineOutcome
    if (call.requestDigest !== digest)
      return { _tag: "Fenced" as const, message: "Local machine call id conflicts with a different request" }
    if (!admitted.sent)
      return yield* settleMachine(mapKey, call, {
        _tag: "Unknown",
        message: "Local machine delivery is uncertain",
      })
    const remaining = Math.max(0, call.deadlineAtMillis - (yield* Clock.currentTimeMillis))
    return yield* Deferred.await(call.result).pipe(
      Effect.timeoutOrElse({
        duration: remaining,
        orElse: () => settleMachine(mapKey, call, machineDeadlineOutcome),
      }),
    )
  })

  return {
    machine,
    receiveBinding,
    receiveMachine,
    replayMachineCalls,
    retireOperation,
    sessionRegistered,
    settleCancelledOperation,
  }
}
