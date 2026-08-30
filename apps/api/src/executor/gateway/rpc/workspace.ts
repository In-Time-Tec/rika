import type { ControllerError, Interface as Controller } from "@rika/e2b-executor/controller"
import {
  redactAccess,
  type AccessWire,
  type ApiMessage,
  type WorkspaceRequest,
  type WorkspaceResponse,
} from "@rika/remote-execution/protocol"
import { Clock, Deferred, Effect, Option, Ref, type Semaphore } from "effect"
import { GatewayError, type Gateway, type Socket } from "../contract"
import type { GatewaySession, WorkspaceCall } from "./model"
import { gatewayProtocol } from "../protocol"

export interface WorkspaceRpcDependencies {
  readonly controller: Controller
  readonly sessions: Ref.Ref<Map<string, GatewaySession>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly calls: Ref.Ref<Map<string, WorkspaceCall>>
  readonly admission: Semaphore.Semaphore
  readonly awaitSession: (assignmentId: string) => Effect.Effect<GatewaySession, GatewayError>
  readonly send: (socket: Socket, message: ApiMessage) => void
  readonly accessFailure: (error: ControllerError) => GatewayError
  readonly expired: () => GatewayError
}

export const workspaceRpcFactory = (dependencies: WorkspaceRpcDependencies) => {
  const receive = Effect.fn("ExecutorGateway.workspace.receive")(function* (
    socket: Socket,
    access: AccessWire,
    response: WorkspaceResponse,
  ) {
    const assignmentId = (yield* Ref.get(dependencies.assignments)).get(socket)
    const call =
      assignmentId === undefined
        ? undefined
        : (yield* Ref.get(dependencies.calls)).get(gatewayProtocol.workspaceKey(assignmentId, response.requestId))
    if (
      assignmentId === undefined ||
      call === undefined ||
      call.socket !== socket ||
      !gatewayProtocol.sameAccess(call.access, access) ||
      !gatewayProtocol.matchesWorkspaceRequest(call.request, response)
    )
      return yield* GatewayError.make({ kind: "fenced", message: "Workspace result conflicts with its request" })
    yield* dependencies.controller
      .validateAccess(redactAccess(access))
      .pipe(Effect.mapError(dependencies.accessFailure))
    yield* Deferred.succeed(call.result, response)
  })

  const admit = Effect.fn("ExecutorGateway.workspace.admit")(function* (
    assignmentId: string,
    request: WorkspaceRequest,
  ) {
    return yield* dependencies.admission.withPermits(1)(
      Effect.gen(function* () {
        const session = (yield* Ref.get(dependencies.sessions)).get(assignmentId)
        if (session === undefined)
          return yield* GatewayError.make({
            kind: "disconnected",
            message: "Executor disconnected before the Workspace request could be sent",
          })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* dependencies.expired()
        yield* dependencies.controller
          .validateAccess(redactAccess(session.access))
          .pipe(Effect.mapError(dependencies.accessFailure))
        const mapKey = gatewayProtocol.workspaceKey(assignmentId, request.requestId)
        const known = (yield* Ref.get(dependencies.calls)).get(mapKey)
        if (known !== undefined) {
          if (!gatewayProtocol.equivalentWorkspaceRequest(known.request, request))
            return yield* GatewayError.make({
              kind: "fenced",
              message: "Workspace request id conflicts with a different request",
            })
          return known
        }
        const result = yield* Deferred.make<WorkspaceResponse, GatewayError>()
        const created: WorkspaceCall = { assignmentId, request, socket: session.socket, access: session.access, result }
        yield* Ref.update(dependencies.calls, (current) => new Map(current).set(mapKey, created))
        yield* Effect.try({
          try: () =>
            dependencies.send(session.socket, { _tag: "WorkspaceRequest", fence: session.access.fence, request }),
          catch: () => GatewayError.make({ kind: "transport", message: "Could not send the Workspace request" }),
        }).pipe(Effect.tapError((error) => Deferred.fail(result, error)))
        return created
      }),
    )
  })

  const workspace: Gateway["workspace"] = (assignmentId, request) =>
    Effect.gen(function* () {
      const connected = yield* dependencies.awaitSession(assignmentId).pipe(Effect.timeoutOption("30 seconds"))
      if (Option.isNone(connected))
        return yield* GatewayError.make({ kind: "timeout", message: "Executor did not connect in time" })
      const call = yield* admit(assignmentId, request)
      const mapKey = gatewayProtocol.workspaceKey(assignmentId, request.requestId)
      return yield* Deferred.await(call.result).pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.flatMap((completed) =>
          Option.isNone(completed)
            ? GatewayError.make({ kind: "timeout", message: "Workspace request did not finish in time" })
            : Effect.succeed(completed.value),
        ),
        Effect.ensuring(
          Ref.update(dependencies.calls, (current) => {
            if (current.get(mapKey)?.result !== call.result) return current
            const next = new Map(current)
            next.delete(mapKey)
            return next
          }),
        ),
      )
    })

  return { receive, workspace }
}
