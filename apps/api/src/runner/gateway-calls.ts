import type { AccessWire, MachineOutcome, MachineRequest } from "@rika/remote-execution/protocol"
import { Clock, DateTime, Deferred, Effect, Ref, Semaphore } from "effect"
import type { GatewayError, Socket } from "../executor/gateway"
import { gatewayModel, type MachineCall, type Pending, type Session } from "./gateway-model"

interface CallState {
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly pending: Ref.Ref<Map<string, Pending>>
  readonly machineCalls: Ref.Ref<Map<string, MachineCall>>
  readonly machineLock: Semaphore.Semaphore
}

interface CallDependencies {
  readonly requestDigest: (value: string) => Effect.Effect<string, GatewayError>
  readonly machineIdFor: (operationKey: string, attempt: number) => Effect.Effect<string, GatewayError>
  readonly send: (socket: Socket, frame: string) => void
  readonly state: CallState
}

const machineDeadlineOutcome: MachineOutcome = {
  _tag: "Unknown",
  message: "Machine outcome is unknown at the operation deadline",
}

export const runnerGatewayCalls = (dependencies: CallDependencies) => {
  const { encode, encodeMachineRequest, failure, machineKey, operationKey, sameFence } = gatewayModel
  const { requestDigest, machineIdFor, send, state } = dependencies
  const { assignments, machineCalls, machineLock, pending, sessions } = state

  const deliver = (socket: Socket, frame: string) =>
    Effect.try({ try: () => send(socket, frame), catch: () => false }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )

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
            const correlation = {
              access: session.access,
              operationKey: call.operationKey,
              attempt: call.attempt,
              machineId: call.machineId,
              requestDigest: call.requestDigest,
            }
            send(
              session.socket,
              encode(
                call.cancelling
                  ? { _tag: "MachineCancel", ...correlation }
                  : { _tag: "MachineExecute", ...correlation, request: call.request },
              ),
            )
          }
        }),
      ),
    )
  })

  const cancelMachineOperation = Effect.fn("RunnerGateway.cancelMachineOperation")(function* (
    assignmentId: string,
    operationKeyValue: string,
    attempt: number,
  ) {
    const operation = (yield* Ref.get(pending)).get(operationKey(assignmentId, operationKeyValue, attempt))
    if (operation === undefined) return
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    const machineId = yield* machineIdFor(operationKeyValue, attempt)
    const digest = yield* requestDigest(encodeMachineRequest(operation.request.machineRequest))
    const mapKey = machineKey(assignmentId, operationKeyValue, attempt, machineId)
    const candidate: MachineCall = {
      assignmentId,
      operationKey: operationKeyValue,
      attempt,
      machineId,
      requestDigest: digest,
      request: operation.request.machineRequest,
      socket: session?.socket ?? operation.socket,
      access: session?.access ?? operation.access,
      deadlineAtMillis: DateTime.toEpochMillis(DateTime.makeUnsafe(operation.request.deadlineAt)),
      cancelling: true,
      result: yield* Deferred.make<MachineOutcome>(),
    }
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(machineCalls)
          const known = current.get(mapKey)
          if (known !== undefined && known.requestDigest !== digest) {
            yield* Deferred.succeed(known.result, {
              _tag: "Fenced",
              message: "Local machine call id conflicts with a different request",
            })
            return
          }
          const alreadySent = known?.cancelling === true && session?.socket === known.socket
          const call = known === undefined ? candidate : { ...known, cancelling: true }
          const retained =
            session === undefined ? call : { ...call, socket: session.socket, access: session.access, cancelling: true }
          yield* Ref.set(machineCalls, new Map(current).set(mapKey, retained))
          if (session === undefined || alreadySent) return
          const sent = yield* deliver(
            session.socket,
            encode({
              _tag: "MachineCancel",
              access: session.access,
              operationKey: operationKeyValue,
              attempt,
              machineId,
              requestDigest: digest,
            }),
          )
          if (sent) return
          yield* Deferred.succeed(retained.result, {
            _tag: "Unknown",
            message: "Local machine cancellation delivery is uncertain",
          })
          yield* Ref.update(machineCalls, (calls) => {
            if (calls.get(mapKey)?.result !== retained.result) return calls
            const next = new Map(calls)
            next.delete(mapKey)
            return next
          })
        }),
      ),
    )
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

  const invokeMachine = Effect.fn("RunnerGateway.invokeMachine")(function* (
    assignmentId: string,
    operationKeyValue: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
  ) {
    const pendingOperation = (yield* Ref.get(pending)).get(operationKey(assignmentId, operationKeyValue, attempt))
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    if (pendingOperation === undefined || session === undefined)
      return yield* failure("disconnected", "Local operation authority is no longer available")
    const digest = yield* requestDigest(encodeMachineRequest(request))
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
      cancelling: false,
      result: yield* Deferred.make<MachineOutcome>(),
    }
    const admitted = yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(machineCalls)
          const known = current.get(mapKey)
          if ((yield* Clock.currentTimeMillis) >= deadlineAtMillis) {
            if (known !== undefined) yield* Deferred.succeed(known.result, machineDeadlineOutcome)
            yield* Ref.set(machineCalls, new Map(Array.from(current).filter(([key]) => key !== mapKey)))
            return { call: undefined, sent: true } as const
          }
          const call = known ?? candidate
          if (known !== undefined) return { call, sent: true } as const
          yield* Ref.set(machineCalls, new Map(current).set(mapKey, candidate))
          const sent = yield* deliver(
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
      Effect.timeoutOrElse({ duration: remaining, orElse: () => settleMachine(mapKey, call, machineDeadlineOutcome) }),
    )
  })

  return {
    cancelMachineOperation,
    invokeMachine,
    receiveMachine,
    replayMachineCalls,
    retireOperation,
    sessionRegistered,
  }
}
