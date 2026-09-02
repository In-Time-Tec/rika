import {
  HostedExecutionOperations,
  layer as hostedExecutionOperationsLayer,
} from "@rika/product-store/executor-operations"
import { redactAccess, type AccessWire } from "@rika/remote-execution/protocol"
import { Crypto, DateTime, Deferred, Effect, Encoding, Layer, Ref, Semaphore } from "effect"
import { GatewayError, type OperationIdentity, type Socket, type SocketFrame } from "../executor/gateway"
import { gatewayExecutionFactory } from "../executor/gateway/execution"
import { gatewayProtocol } from "../executor/gateway/protocol"
import { gatewaySessionAwaiter } from "../executor/gateway/sessions"
import type { PendingOperation } from "../executor/gateway/rpc/model"
import { LifecycleStores } from "../executor/lifecycle-store"
import { makeNativeOperationEndpoint } from "../executor/native-operation-endpoint"
import type { RunnerExecutorAuthority } from "./executor"
import { runnerGatewayMessages } from "./gateway-messages"
import { gatewayModel, type FinalResult, type LocalExecuteInput, type Session } from "./gateway-model"

const { accessFailure, key, sameExecutor } = gatewayProtocol
const { sameFence: same } = gatewayModel
const failure = (kind: GatewayError["kind"], message: string) => GatewayError.make({ kind, message })

export interface RunnerGateway {
  readonly receive: (socket: Socket, frame: SocketFrame) => Effect.Effect<void>
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly active: (socket: Socket) => Effect.Effect<boolean>
  readonly execute: (input: LocalExecuteInput) => Effect.Effect<FinalResult, GatewayError>
  readonly cancel: (input: OperationIdentity) => Effect.Effect<FinalResult, GatewayError>
}

const makeRunnerGatewayWithOperations = Effect.fn("RunnerGateway.make")(function* (authority: RunnerExecutorAuthority) {
  const operations = yield* HostedExecutionOperations
  const crypto = yield* Crypto.Crypto
  const scope = yield* Effect.scope
  const lifecycle = LifecycleStores.build(operations, crypto)
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const pending = yield* Ref.make(new Map<string, PendingOperation>())
  const quiescing = yield* Ref.make(new Set<string>())
  const gatewayLock = yield* Semaphore.make(1)
  const digest = Effect.fn("RunnerGateway.digest")(function* (value: string) {
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.mapError(() => failure("transport", "Could not identify Runner operation")))
    return Encoding.encodeHex(bytes)
  })
  const machineIdFor = (operationKey: string, attempt: number) => digest(`${attempt}\u0000${operationKey}`)
  const nativeOperations = yield* makeNativeOperationEndpoint({
    digest,
    encodeRequest: gatewayModel.encodeMachineRequest,
    session: (assignmentId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId))),
    authorize: (input, session) =>
      Ref.get(pending).pipe(
        Effect.map((current) => {
          const operation = current.get(key(input.assignmentId, input.operationKey, input.attempt))
          return (
            operation !== undefined && operation.socket === session.socket && same(operation.access, session.access)
          )
        }),
      ),
    sameAccess: same,
    send: (session, message) =>
      Effect.try({
        try: () => session.socket.send(gatewayModel.encode(message)),
        catch: (cause) => failure("transport", `Could not deliver Runner native operation: ${String(cause)}`),
      }),
  })
  const calls = {
    receiveMachine: Effect.fn("RunnerGateway.receiveNativeOperation")(function* (
      socket: Socket,
      presented: AccessWire,
      operationKey: string,
      attempt: number,
      machineId: string,
      requestDigest: string,
      outcome: import("@rika/remote-execution/protocol").MachineOutcome,
    ) {
      const assignmentId = (yield* Ref.get(assignments)).get(socket)
      const session = assignmentId === undefined ? undefined : (yield* Ref.get(sessions)).get(assignmentId)
      if (session === undefined || session.socket !== socket || !same(session.access, presented))
        return yield* failure("fenced", "Runner native operation result has no current executor")
      yield* nativeOperations.receive(session, {
        assignmentId: session.access.fence.assignmentId,
        operationKey,
        attempt,
        machineId,
        requestDigest,
        outcome,
      })
    }),
  }
  const register = Effect.fn("RunnerGateway.register")(function* (session: Session) {
    yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = session.access.fence.assignmentId
        const previous = yield* Ref.modify(sessions, (current) => {
          const known = current.get(assignmentId)
          return [known, new Map(current).set(assignmentId, session)] as const
        })
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          if (previous !== undefined && previous.socket !== session.socket) next.delete(previous.socket)
          next.set(session.socket, assignmentId)
          return next
        })
        const failed = yield* Ref.modify(pending, (current) => {
          const next = new Map(current)
          const failures = []
          for (const [operationKey, operation] of next) {
            if (operation.assignmentId !== assignmentId) continue
            if (!sameExecutor(operation.access, session.access)) {
              next.delete(operationKey)
              failures.push(operation.result)
            } else next.set(operationKey, { ...operation, socket: session.socket, access: session.access })
          }
          return [failures, next] as const
        })
        yield* Effect.forEach(
          failed,
          (result) =>
            Deferred.fail(
              result,
              GatewayError.make({
                kind: "disconnected",
                message: "Runner connection was replaced before returning a result",
              }),
            ),
          { discard: true },
        )
        yield* nativeOperations.refreshed(session)
        if (previous !== undefined && previous.socket !== session.socket) previous.socket.close(1008, "fenced")
      }),
    )
  })
  const replayPending = (session: Session) => nativeOperations.reconnected(session)
  const disconnected = Effect.fn("RunnerGateway.disconnected")(function* (socket: Socket) {
    yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = (yield* Ref.get(assignments)).get(socket)
        if (assignmentId === undefined) return
        const currentSession = (yield* Ref.get(sessions)).get(assignmentId)
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          next.delete(socket)
          return next
        })
        if (currentSession?.socket === socket)
          yield* Ref.update(sessions, (current) => {
            const next = new Map(current)
            next.delete(assignmentId)
            return next
          })
        yield* nativeOperations.disconnected(socket)
      }),
    )
  })
  const shutdown = Effect.fn("RunnerGateway.shutdown")(function* (socket: Socket, access: AccessWire) {
    const assignmentId = (yield* Ref.get(assignments)).get(socket)
    const session = assignmentId === undefined ? undefined : (yield* Ref.get(sessions)).get(assignmentId)
    if (
      assignmentId === undefined ||
      assignmentId !== access.fence.assignmentId ||
      session?.socket !== socket ||
      !same(session.access, access)
    )
      return yield* failure("fenced", "Runner shutdown does not match the current session")
    yield* disconnected(socket)
    yield* authority
      .release(redactAccess(access))
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("runner-assignment.release-failed").pipe(
            Effect.annotateLogs({ "rika.error.kind": error.kind, "rika.error.message": error.message }),
          ),
        ),
      )
  })
  const receive = runnerGatewayMessages({ authority, register, replayPending, shutdown, calls })
  const execution = gatewayExecutionFactory({
    lifecycle,
    validateAccess: (access) => authority.validateAccess(redactAccess(access)).pipe(Effect.mapError(accessFailure)),
    ready: () => Effect.void,
    sessions,
    pending,
    quiescing,
    admission: gatewayLock,
    awaitSession: gatewaySessionAwaiter(sessions),
    grant: () => Effect.void,
    machineIdFor,
    invokeMachine: (assignmentId, operationKey, attempt, machineId, request, deadlineAt) =>
      nativeOperations.invoke({
        assignmentId,
        operationKey,
        attempt,
        machineId,
        request,
        deadlineAtMillis: DateTime.toEpochMillis(DateTime.makeUnsafe(deadlineAt)),
      }),
    cancelMachine: (assignmentId, operationKey, attempt, machineId, request, deadlineAt) =>
      nativeOperations.cancel({
        assignmentId,
        operationKey,
        attempt,
        machineId,
        request,
        deadlineAtMillis: DateTime.toEpochMillis(DateTime.makeUnsafe(deadlineAt)),
      }),
    scope,
  })
  const withPersistenceDisposition = (
    result: Effect.Effect<import("../executor/gateway").ExecutionResult, GatewayError>,
  ) => result.pipe(Effect.map((value) => ({ ...value, eventPersisted: false as const })))
  const active: RunnerGateway["active"] = (socket) =>
    Effect.gen(function* () {
      const assignmentId = (yield* Ref.get(assignments)).get(socket)
      if (assignmentId === undefined) return true
      const current = (yield* Ref.get(sessions)).get(assignmentId)
      if (current === undefined || current.socket !== socket) return false
      return yield* authority.validateAccess(redactAccess(current.access)).pipe(
        Effect.as(true),
        Effect.catch((error) => Effect.succeed(error.kind === "repository")),
      )
    })
  return {
    receive,
    disconnected,
    active,
    execute: (input) => withPersistenceDisposition(execution.execute(input)),
    cancel: (input) => withPersistenceDisposition(execution.cancel(input)),
  } satisfies RunnerGateway
})

export const makeRunnerGateway = Effect.fn("RunnerGateway.makeLive")(function* (authority: RunnerExecutorAuthority) {
  const context = yield* Layer.build(hostedExecutionOperationsLayer)
  return yield* makeRunnerGatewayWithOperations(authority).pipe(Effect.provideContext(context))
})
