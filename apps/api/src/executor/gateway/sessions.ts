import type { Quiescence } from "@rika/e2b-executor/controller"
import type { AccessWire, ApiMessage, WorkspaceResponse } from "@rika/remote-execution/protocol"
import { Clock, Deferred, Effect, Ref, type Semaphore } from "effect"
import { GatewayError, type ExecutionResult, type Socket } from "./contract"
import { gatewayProtocol } from "./protocol"
import type { GatewaySession as Session, MachineCall, PendingOperation as Pending, WorkspaceCall } from "./rpc/model"

const { sameAccess, sameExecutor } = gatewayProtocol

interface SessionRegistryOptions {
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly pending: Ref.Ref<Map<string, Pending>>
  readonly machineCalls: Ref.Ref<Map<string, MachineCall>>
  readonly workspaceCalls: Ref.Ref<Map<string, WorkspaceCall>>
  readonly quiescence: Ref.Ref<
    Map<
      string,
      {
        readonly access: AccessWire
        readonly requestId: string
        readonly result: Deferred.Deferred<Quiescence, GatewayError>
      }
    >
  >
  readonly admission: Semaphore.Semaphore
  readonly machineLock: Semaphore.Semaphore
  readonly close: (socket: Socket, code: number, reason: string) => void
  readonly failBranchPush: (
    predicate: (call: { readonly socket: Socket }) => boolean,
    message: string,
  ) => Effect.Effect<void>
  readonly grantRuntime: (session: Session, operationKey: string) => Effect.Effect<void, GatewayError>
  readonly send: (socket: Socket, message: ApiMessage) => void
  readonly machineDeadlineOutcome: import("@rika/remote-execution/protocol").MachineOutcome
}

export const gatewaySessionAwaiter = (sessions: Ref.Ref<Map<string, Session>>) => {
  const awaitSession = (assignmentId: string): Effect.Effect<Session> =>
    Effect.suspend(() =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(assignmentId)
          return session === undefined || !session.ready
            ? Effect.sleep("100 millis").pipe(Effect.andThen(awaitSession(assignmentId)))
            : Effect.succeed(session)
        }),
      ),
    )
  return awaitSession
}

export const gatewaySessionsFactory = (options: SessionRegistryOptions) => {
  const register = Effect.fn("ExecutorGateway.register")(function* (session: Session) {
    return yield* options.admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = session.access.fence.assignmentId
        const currentSession = yield* Ref.get(options.sessions).pipe(Effect.map((current) => current.get(assignmentId)))
        if (
          currentSession !== undefined &&
          currentSession.socket !== session.socket &&
          sameAccess(currentSession.access, session.access)
        ) {
          options.close(session.socket, 1008, "duplicate")
          return false
        }
        const previousAssignment = yield* Ref.get(options.assignments).pipe(
          Effect.map((current) => current.get(session.socket)),
        )
        const displaced = yield* Ref.modify(options.sessions, (current) => {
          const previous = current.get(assignmentId)
          const priorSession = previousAssignment === undefined ? undefined : current.get(previousAssignment)
          const next = new Map(current)
          if (
            previousAssignment !== undefined &&
            previousAssignment !== assignmentId &&
            priorSession?.socket === session.socket
          )
            next.delete(previousAssignment)
          next.set(assignmentId, session)
          return [{ previous, previousAssignment }, next] as const
        })
        yield* Ref.update(options.assignments, (current) => {
          const next = new Map(current)
          if (displaced.previous !== undefined && displaced.previous.socket !== session.socket)
            next.delete(displaced.previous.socket)
          next.set(session.socket, assignmentId)
          return next
        })
        const failed = yield* Ref.modify(
          options.pending,
          (
            current,
          ): readonly [ReadonlyArray<Deferred.Deferred<ExecutionResult, GatewayError>>, Map<string, Pending>] => {
            const displacedPending = [...current.entries()].filter(([, operation]) => {
              if (operation.assignmentId === assignmentId) return !sameExecutor(operation.access, session.access)
              return (
                displaced.previousAssignment !== undefined &&
                displaced.previousAssignment !== assignmentId &&
                operation.assignmentId === displaced.previousAssignment &&
                operation.socket === session.socket
              )
            })
            if (displacedPending.length === 0) return [[], current] as const
            const next = new Map(current)
            for (const [pendingKey] of displacedPending) next.delete(pendingKey)
            return [displacedPending.map(([, operation]) => operation.result), next] as const
          },
        )
        const previousSocket = displaced.previous?.socket
        if (previousSocket !== undefined && previousSocket !== session.socket) {
          options.close(previousSocket, 1008, "fenced")
          yield* options.failBranchPush(
            (call) => call.socket === previousSocket,
            "Executor connection changed during the approved branch push",
          )
        }
        yield* Effect.forEach(
          failed,
          (result) =>
            Deferred.fail(
              result,
              GatewayError.make({
                kind: "disconnected",
                message: "Executor connection was replaced before returning a result",
              }),
            ),
          { discard: true },
        )
        yield* Ref.update(options.pending, (current) => {
          const next = new Map(current)
          for (const [pendingKey, operation] of next)
            if (operation.assignmentId === assignmentId)
              next.set(pendingKey, { ...operation, socket: session.socket, access: session.access })
          return next
        })
        yield* options.machineLock.withPermits(1)(
          Ref.update(options.machineCalls, (current) => {
            const next = new Map(current)
            for (const [pendingKey, operation] of next)
              if (operation.assignmentId === assignmentId)
                next.set(pendingKey, { ...operation, socket: session.socket, access: session.access })
            return next
          }),
        )
        const failedWorkspace = yield* Ref.modify(
          options.workspaceCalls,
          (
            current,
          ): readonly [
            ReadonlyArray<Deferred.Deferred<WorkspaceResponse, GatewayError>>,
            Map<string, WorkspaceCall>,
          ] => {
            const displacedCalls = [...current.entries()].filter(
              ([, call]) => call.assignmentId === assignmentId && !sameExecutor(call.access, session.access),
            )
            if (displacedCalls.length === 0) return [[], current] as const
            const next = new Map(current)
            for (const [callKey] of displacedCalls) next.delete(callKey)
            return [displacedCalls.map(([, call]) => call.result), next] as const
          },
        )
        yield* Effect.forEach(
          failedWorkspace,
          (result) =>
            Deferred.fail(
              result,
              GatewayError.make({
                kind: "disconnected",
                message: "Executor connection was replaced before returning a Workspace result",
              }),
            ),
          { discard: true },
        )
        yield* Ref.update(options.workspaceCalls, (current) => {
          const next = new Map(current)
          for (const [callKey, call] of next)
            if (call.assignmentId === assignmentId)
              next.set(callKey, { ...call, socket: session.socket, access: session.access })
          return next
        })
        return true
      }),
    )
  })

  const replayPending = Effect.fn("ExecutorGateway.replayPending")(function* (session: Session) {
    for (const operation of (yield* Ref.get(options.pending)).values()) {
      if (operation.assignmentId !== session.access.fence.assignmentId) continue
      yield* options.grantRuntime(session, operation.operationKey)
    }
    yield* options.machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          for (const [mapKey, operation] of yield* Ref.get(options.machineCalls)) {
            if (operation.assignmentId !== session.access.fence.assignmentId) continue
            if (now >= operation.deadlineAtMillis) {
              yield* Deferred.succeed(operation.result, options.machineDeadlineOutcome)
              yield* Ref.update(options.machineCalls, (current) => {
                if (current.get(mapKey)?.result !== operation.result) return current
                const next = new Map(current)
                next.delete(mapKey)
                return next
              })
              continue
            }
            options.send(
              session.socket,
              operation.cancelling
                ? {
                    _tag: "MachineCancel",
                    access: session.access,
                    operationKey: operation.operationKey,
                    attempt: operation.attempt,
                    machineId: operation.machineId,
                    requestDigest: operation.requestDigest,
                  }
                : {
                    _tag: "MachineExecute",
                    access: session.access,
                    operationKey: operation.operationKey,
                    attempt: operation.attempt,
                    machineId: operation.machineId,
                    requestDigest: operation.requestDigest,
                    request: operation.request,
                  },
            )
          }
        }),
      ),
    )
    for (const call of (yield* Ref.get(options.workspaceCalls)).values()) {
      if (call.assignmentId !== session.access.fence.assignmentId) continue
      options.send(session.socket, { _tag: "WorkspaceRequest", fence: session.access.fence, request: call.request })
    }
  })

  const disconnected = Effect.fn("ExecutorGateway.disconnected")(function* (socket: Socket) {
    yield* options.admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.modify(options.assignments, (current) => {
          const known = current.get(socket)
          if (known === undefined) return [undefined, current] as const
          const next = new Map(current)
          next.delete(socket)
          return [known, next] as const
        })
        if (assignmentId !== undefined)
          yield* Ref.update(options.sessions, (current) => {
            if (current.get(assignmentId)?.socket !== socket) return current
            const next = new Map(current)
            next.delete(assignmentId)
            return next
          })
        if (assignmentId !== undefined) {
          const waiting = yield* Ref.modify(options.quiescence, (current) => {
            const known = current.get(assignmentId)
            if (known === undefined || known.access.fence.assignmentId !== assignmentId)
              return [undefined, current] as const
            const next = new Map(current)
            next.delete(assignmentId)
            return [known, next] as const
          })
          if (waiting !== undefined)
            yield* Deferred.fail(
              waiting.result,
              GatewayError.make({ kind: "disconnected", message: "Executor disconnected while quiescing" }),
            )
        }
        yield* options.failBranchPush(
          (call) => call.socket === socket,
          "Executor disconnected during the approved branch push",
        )
      }),
    )
  })

  return { register, replayPending, disconnected }
}
