import type { ControllerError, Interface as Controller, Quiescence } from "@rika/e2b-executor/controller"
import type { EnvironmentPhase } from "@rika/product/environment-policy"
import {
  redactAccess,
  type AccessWire,
  type ExecutorMessage as ExecutorMessageValue,
} from "@rika/remote-execution/protocol"
import { Context, Crypto, Deferred, Effect, Encoding, Layer, PubSub, Redacted, Ref, Semaphore } from "effect"
import {
  GatewayError,
  type Gateway,
  type LifecycleStore,
  type PhaseAuthority,
  type PreparationStore,
  type PtyEvent,
  type Socket,
  type SocketFrame,
} from "./gateway/contract"
import { branchPushRpcFactory } from "./gateway/rpc/branch-push"
import { gatewayControlFactory } from "./gateway/control"
import { gatewayExecutionFactory } from "./gateway/execution"
import { gatewayMessageHandlerFactory } from "./gateway/message/handler"
import { gatewayProtocol } from "./gateway/protocol"
import { gatewaySessionAwaiter, gatewaySessionsFactory } from "./gateway/sessions"
import { machineRpcFactory } from "./gateway/rpc/machine"
import { workspaceRpcFactory } from "./gateway/rpc/workspace"
import type {
  BranchPushCall,
  GatewaySession as Session,
  MachineCall,
  PendingOperation as Pending,
  WorkspaceCall,
} from "./gateway/rpc/model"

const { accessFailure, decode, encode, expired, fenceOf, sameAccess } = gatewayProtocol

export * from "./gateway/contract"

export class ExecutorGateway extends Context.Service<ExecutorGateway, Gateway>()(
  "@rika/api/executor/gateway/ExecutorGateway",
) {}

const close = (socket: Socket, code: number, reason: string) => {
  socket.close(code, reason)
}

const failure = (socket: Socket, message: ExecutorMessageValue, error: ControllerError | GatewayError) => {
  const fence = fenceOf(message)
  if (fence !== undefined) socket.send(encode({ _tag: "Fenced", fence, message: error.message }))
  socket.close(1008, error.kind)
}

export const makeGateway = Effect.fn("ExecutorGateway.make")(function* (
  controller: Controller,
  lifecycle: LifecycleStore,
  phases: PhaseAuthority,
  preparation: PreparationStore,
) {
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const pending = yield* Ref.make(new Map<string, Pending>())
  const machineCalls = yield* Ref.make(new Map<string, MachineCall>())
  const workspaceCalls = yield* Ref.make(new Map<string, WorkspaceCall>())
  const branchPushCalls = yield* Ref.make(new Map<string, BranchPushCall>())
  const quiescing = yield* Ref.make(new Set<string>())
  const quiescence = yield* Ref.make(
    new Map<
      string,
      {
        readonly access: AccessWire
        readonly requestId: string
        readonly result: Deferred.Deferred<Quiescence, GatewayError>
      }
    >(),
  )
  const admission = yield* Semaphore.make(1)
  const machineLock = yield* Semaphore.make(1)
  const ptyFrames = yield* PubSub.sliding<PtyEvent>(256)
  const crypto = yield* Crypto.Crypto
  const scope = yield* Effect.scope
  const digest = Effect.fn("ExecutorGateway.digest")(function* (value: string) {
    return Encoding.encodeHex(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(value))
        .pipe(
          Effect.mapError(() => GatewayError.make({ kind: "transport", message: "Could not identify RPC request" })),
        ),
    )
  })
  const awaitSession = gatewaySessionAwaiter(sessions)
  const machineRpc = machineRpcFactory({
    sessions,
    assignments,
    pending,
    calls: machineCalls,
    lock: machineLock,
    admission,
    digest,
    send: (socket, message) => socket.send(encode(message)),
  })
  const workspaceRpc = workspaceRpcFactory({
    controller,
    sessions,
    assignments,
    calls: workspaceCalls,
    admission,
    awaitSession,
    accessFailure,
    expired,
    send: (socket, message) => socket.send(encode(message)),
  })
  const branchPushRpc = branchPushRpcFactory({
    controller,
    phases,
    preparation,
    sessions,
    quiescing,
    calls: branchPushCalls,
    admission,
    awaitSession,
    expired,
    accessFailure,
    send: (socket, message) => socket.send(encode(message)),
  })

  const grant = (
    session: Session,
    phase: EnvironmentPhase,
    operationKey: string | null,
    expectedEnvironmentDigest?: string,
  ): Effect.Effect<void, GatewayError> =>
    phases.activate(session.access, phase, (environment) =>
      Effect.gen(function* () {
        if (expectedEnvironmentDigest !== undefined && environment.digest !== expectedEnvironmentDigest)
          return yield* GatewayError.make({
            kind: "fenced",
            message: "Workspace environment authorization does not match its bootstrap",
          })
        if (operationKey === null)
          yield* Ref.update(sessions, (active) => {
            const current = active.get(session.access.fence.assignmentId)
            if (current?.socket !== session.socket || !sameAccess(current.access, session.access)) return active
            return new Map(active).set(session.access.fence.assignmentId, {
              ...current,
              environmentDigest: environment.digest,
            })
          })
        yield* Effect.try({
          try: () => {
            session.socket.send(
              encode({
                _tag: "PhaseEnvironmentGranted",
                phase,
                digest: environment.digest,
                operationKey,
                values: Object.fromEntries(
                  Object.entries(environment.values).map(([name, value]) => [name, Redacted.value(value)]),
                ),
                redactedNames: environment.redactedNames,
              }),
            )
          },
          catch: () => GatewayError.make({ kind: "transport", message: "Could not authorize executor phase" }),
        })
      }),
    )

  const execution = gatewayExecutionFactory({
    controller,
    lifecycle,
    preparation,
    sessions,
    pending,
    quiescing,
    admission,
    awaitSession,
    grant: (session, operationKey) => grant(session, "runtime", operationKey),
    machineIdFor: (operationKey, attempt) => digest(`${attempt}\u0000${operationKey}`),
    invokeMachine: machineRpc.invoke,
    cancelMachine: machineRpc.cancel,
    scope,
  })

  const sessionRegistry = gatewaySessionsFactory({
    sessions,
    assignments,
    pending,
    machineCalls,
    workspaceCalls,
    quiescence,
    admission,
    machineLock,
    close,
    failBranchPush: branchPushRpc.fail,
    grantRuntime: (session, operationKey) => grant(session, "runtime", operationKey),
    send: (socket, message) => socket.send(encode(message)),
    machineDeadlineOutcome: machineRpc.deadlineOutcome,
  })
  const { register, replayPending, disconnected } = sessionRegistry

  const control = gatewayControlFactory({
    controller,
    preparation,
    sessions,
    assignments,
    quiescing,
    quiescence,
    admission,
    crypto,
    ptyFrames,
    awaitSession,
    send: (socket, message) => socket.send(encode(message)),
  })
  const { active, ptyEvents, publishPty, quiesce, retryPreparation, sendPty } = control

  const recover = Effect.fn("ExecutorGateway.recover")(function* (
    message: ExecutorMessageValue,
    error: ControllerError | GatewayError,
  ) {
    if (message._tag !== "ExecutorReconnect" || error.kind !== "fenced") return
    const current = yield* Ref.get(sessions).pipe(
      Effect.map((registered) => registered.get(message.access.fence.assignmentId)),
    )
    if (current !== undefined) return
    const successor = {
      ...message.access,
      leaseEpoch: message.access.leaseEpoch + 1,
    }
    const acknowledged = yield* Effect.result(controller.validateAccess(redactAccess(successor)))
    if (acknowledged._tag === "Failure") return
    yield* phases
      .replace({
        assignmentId: message.access.fence.assignmentId,
        generation: message.access.fence.assignmentGeneration,
      })
      .pipe(Effect.ignoreCause)
  })

  const messageHandler = gatewayMessageHandlerFactory({
    controller,
    sessions,
    quiescing,
    quiescence,
    register,
    grant,
    replayPending,
    preparation,
    branchPushCalls,
    send: (socket, message) => socket.send(encode(message)),
    receiveMachine: (socket, message) =>
      machineRpc.receive(
        socket,
        message.access,
        message.operationKey,
        message.attempt,
        message.machineId,
        message.requestDigest,
        message.outcome,
      ),
    receiveWorkspace: (socket, message) => workspaceRpc.receive(socket, message.access, message.response),
    receiveBranchPush: (socket, message) =>
      branchPushRpc.receive(
        socket,
        message.access,
        message.publicationId,
        message.branch,
        message.commitSha,
        message.outcome,
      ),
    publishPty,
  })

  const receive = (socket: Socket, frame: SocketFrame) =>
    decode(frame).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sync(() => close(socket, 1007, "malformed")),
        onSuccess: (message) =>
          messageHandler.handle(socket, message).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.logError("executor-gateway.frame-rejected").pipe(
                  Effect.annotateLogs({
                    "rika.executor.frame": message._tag,
                    "rika.error.kind": error.kind,
                    "rika.error.message": error.message,
                  }),
                  Effect.andThen(recover(message, error)),
                  Effect.andThen(Effect.sync(() => failure(socket, message, error))),
                ),
              onSuccess: () => Effect.void,
            }),
          ),
      }),
      Effect.asVoid,
    )

  return {
    receive,
    disconnected,
    active,
    execute: execution.execute,
    cancel: execution.cancel,
    sendPty,
    ptyEvents,
    retryPreparation,
    workspace: workspaceRpc.workspace,
    quiesce,
    pushBranch: branchPushRpc.pushBranch,
  } satisfies Gateway
})

export const gatewayLayer = (options: {
  readonly controller: Controller
  readonly lifecycle: LifecycleStore
  readonly phases: PhaseAuthority
  readonly preparation: PreparationStore
}) =>
  Layer.effect(ExecutorGateway, makeGateway(options.controller, options.lifecycle, options.phases, options.preparation))
