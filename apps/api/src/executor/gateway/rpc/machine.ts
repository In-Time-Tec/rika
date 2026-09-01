import { MachineRequest, type AccessWire, type ApiMessage, type MachineOutcome } from "@rika/remote-execution/protocol"
import { Clock, DateTime, Deferred, Effect, Ref, type Semaphore } from "effect"
import { GatewayError, type Socket } from "../contract"
import type { GatewaySession, MachineCall, PendingOperation } from "./model"
import { gatewayProtocol } from "../protocol"

const deadlineOutcome: MachineOutcome = {
  _tag: "Unknown",
  message: "Machine outcome is unknown at the operation deadline",
}

export interface MachineRpcDependencies {
  readonly sessions: Ref.Ref<Map<string, GatewaySession>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly pending: Ref.Ref<Map<string, PendingOperation>>
  readonly calls: Ref.Ref<Map<string, MachineCall>>
  readonly lock: Semaphore.Semaphore
  readonly admission: Semaphore.Semaphore
  readonly digest: (value: string) => Effect.Effect<string, GatewayError>
  readonly send: (socket: Socket, message: ApiMessage) => void
}

export const machineRpcFactory = (dependencies: MachineRpcDependencies) => {
  const settle = Effect.fn("ExecutorGateway.machine.settle")(function* (
    mapKey: string,
    call: MachineCall,
    outcome: MachineOutcome,
  ) {
    yield* dependencies.lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(call.result, outcome)
          yield* Ref.update(dependencies.calls, (current) => {
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

  const receive = Effect.fn("ExecutorGateway.machine.receive")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    machineId: string,
    requestDigest: string,
    outcome: MachineOutcome,
  ) {
    yield* dependencies.admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = (yield* Ref.get(dependencies.assignments)).get(socket)
        const session =
          assignmentId === undefined ? undefined : (yield* Ref.get(dependencies.sessions)).get(assignmentId)
        if (
          assignmentId === undefined ||
          session?.socket !== socket ||
          !gatewayProtocol.sameAccess(session.access, access)
        )
          return yield* GatewayError.make({ kind: "fenced", message: "Machine result came from an unknown executor" })
        const mapKey = gatewayProtocol.machineKey(assignmentId, operationKey, attempt, machineId)
        const call = (yield* Ref.get(dependencies.calls)).get(mapKey)
        if (call === undefined) return
        if (
          call.socket !== socket ||
          call.attempt !== attempt ||
          call.requestDigest !== requestDigest ||
          !gatewayProtocol.sameAccess(call.access, access)
        )
          return yield* GatewayError.make({ kind: "fenced", message: "Machine result conflicts with its request" })
        yield* settle(
          mapKey,
          call,
          (yield* Clock.currentTimeMillis) >= call.deadlineAtMillis ? deadlineOutcome : outcome,
        )
      }),
    )
  })

  const invoke = Effect.fn("ExecutorGateway.machine.invoke")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
  ) {
    const requestDigest = yield* dependencies.digest(gatewayProtocol.encodeMachineRequest(request))
    const session = (yield* Ref.get(dependencies.sessions)).get(assignmentId)
    const operation = (yield* Ref.get(dependencies.pending)).get(
      gatewayProtocol.key(assignmentId, operationKey, attempt),
    )
    if (
      session === undefined ||
      operation === undefined ||
      operation.attempt !== attempt ||
      operation.socket !== session.socket ||
      !gatewayProtocol.sameExecutor(operation.access, session.access)
    )
      return { _tag: "Unknown" as const, message: "The selected executor is no longer available" }
    const mapKey = gatewayProtocol.machineKey(assignmentId, operationKey, attempt, machineId)
    const deadlineAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(operation.request.deadlineAt))
    const candidate: MachineCall = {
      assignmentId,
      operationKey,
      attempt,
      machineId,
      requestDigest,
      request,
      socket: session.socket,
      access: session.access,
      deadlineAtMillis,
      cancelling: false,
      result: yield* Deferred.make<MachineOutcome>(),
    }
    const call = yield* dependencies.lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(dependencies.calls)
          const known = current.get(mapKey)
          if ((yield* Clock.currentTimeMillis) >= deadlineAtMillis) {
            if (known !== undefined) {
              yield* Deferred.succeed(known.result, deadlineOutcome)
              yield* Ref.set(
                dependencies.calls,
                new Map(Array.from(current).filter(([currentKey]) => currentKey !== mapKey)),
              )
            }
            return undefined
          }
          if (known !== undefined) return known
          yield* Ref.set(dependencies.calls, new Map(current).set(mapKey, candidate))
          yield* Effect.try({
            try: () =>
              dependencies.send(session.socket, {
                _tag: "MachineExecute",
                access: session.access,
                operationKey,
                attempt,
                machineId,
                requestDigest,
                request,
              }),
            catch: () => undefined,
          }).pipe(Effect.ignore)
          return candidate
        }),
      ),
    )
    if (call === undefined) return deadlineOutcome
    if (call.requestDigest !== requestDigest)
      return { _tag: "Unknown" as const, message: "A machine call id was reused with a different request" }
    return yield* Deferred.await(call.result).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(0, call.deadlineAtMillis - (yield* Clock.currentTimeMillis)),
        orElse: () => settle(mapKey, call, deadlineOutcome),
      }),
    )
  })

  const cancel = Effect.fn("ExecutorGateway.machine.cancel")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
    deadlineAt: string,
  ) {
    const requestDigest = yield* dependencies.digest(gatewayProtocol.encodeMachineRequest(request))
    const session = (yield* Ref.get(dependencies.sessions)).get(assignmentId)
    if (session === undefined)
      return { _tag: "Unknown" as const, message: "The selected executor is no longer available" }
    const mapKey = gatewayProtocol.machineKey(assignmentId, operationKey, attempt, machineId)
    const deadlineAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(deadlineAt))
    const candidate: MachineCall = {
      assignmentId,
      operationKey,
      attempt,
      machineId,
      requestDigest,
      request,
      socket: session.socket,
      access: session.access,
      deadlineAtMillis,
      cancelling: true,
      result: yield* Deferred.make<MachineOutcome>(),
    }
    const call = yield* dependencies.lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(dependencies.calls)
          const known = current.get(mapKey)
          if (known !== undefined && known.requestDigest !== requestDigest) return known
          const cancelling = known === undefined ? candidate : { ...known, cancelling: true }
          yield* Ref.set(dependencies.calls, new Map(current).set(mapKey, cancelling))
          yield* Effect.try({
            try: () =>
              dependencies.send(session.socket, {
                _tag: "MachineCancel",
                access: session.access,
                operationKey,
                attempt,
                machineId,
                requestDigest,
              }),
            catch: () => undefined,
          }).pipe(Effect.ignore)
          return cancelling
        }),
      ),
    )
    if (call.requestDigest !== requestDigest)
      return { _tag: "Fenced" as const, message: "A machine call id was reused with a different request" }
    return yield* Deferred.await(call.result).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(0, call.deadlineAtMillis - (yield* Clock.currentTimeMillis)),
        orElse: () => settle(mapKey, call, deadlineOutcome),
      }),
    )
  })

  return { cancel, deadlineOutcome, invoke, receive, settle }
}
