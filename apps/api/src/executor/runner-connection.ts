import { Clock, Effect, Fiber, Schedule, Schema, Scope } from "effect"
import {
  ExecutorFenceError,
  ExecutorTransportError,
  makeWorkspaceExecutorWebSocketServer,
  sameBinding,
  type WorkspaceExecutorWebSocketPeer,
  type WorkspaceExecutorWebSocketServer,
} from "@rika/execution"
import type { IdentityPrincipal } from "@rika/identity"
import { ExecutorPlacementPolicy } from "@rika/product/executor-policy"
import type { ProductRepositoryService, ThreadAuthorityProjection } from "@rika/product-store/product-repository"
import { authenticateIdentityRequest, type IdentityHttpOptions } from "../identity/http"
import { decodeThreadBinding } from "./binding"
import type { ThreadExecutionBinding } from "../runtime/partition"

export class RunnerConnectionError extends Schema.TaggedError<RunnerConnectionError>()("RikaRunnerConnectionError", {
  kind: Schema.Literals(["unauthorized", "forbidden", "unavailable"]),
  message: Schema.String,
}) {}

export interface RunnerConnectionOptions extends IdentityHttpOptions {
  readonly product: Pick<ProductRepositoryService, "threadAuthority" | "threadExecutionContext">
  readonly environment: string
}

export interface RunnerConnectionAuthorization {
  readonly binding: ThreadExecutionBinding
  readonly validate: Effect.Effect<void, RunnerConnectionError>
}

const forbidden = () =>
  RunnerConnectionError.make({ kind: "forbidden", message: "Runner assignment is not authorized" })
const unavailable = () =>
  RunnerConnectionError.make({ kind: "unavailable", message: "Runner assignment is unavailable" })
const unauthorized = () =>
  RunnerConnectionError.make({ kind: "unauthorized", message: "Runner device authentication required" })
const ownsThread = (userId: string, authority: ThreadAuthorityProjection) => {
  if (authority.createdByUserId !== userId || authority.executorKind !== "runner") return false
  if (authority.kind === "personal") return authority.userId === userId
  return authority.kind === "organization" && authority.organizationId !== null && authority.membershipId !== null
}

const currentBinding = Effect.fn("Rika.RunnerConnection.currentBinding")(function* (
  principal: IdentityPrincipal,
  deviceId: string,
  threadId: string,
  options: RunnerConnectionOptions,
): Effect.fn.Return<ThreadExecutionBinding, RunnerConnectionError> {
  if (principal.expiresAt === undefined || principal.expiresAt <= (yield* Clock.currentTimeMillis))
    return yield* unauthorized()
  const currentDevice = yield* options.devices.authenticate(principal).pipe(Effect.mapError(unavailable))
  if (currentDevice !== deviceId) return yield* unauthorized()
  const authority = yield* options.product
    .threadAuthority(principal.userId, threadId)
    .pipe(Effect.mapError(unavailable))
  if (authority === undefined || !ownsThread(principal.userId, authority)) return yield* forbidden()
  const row = yield* options.product
    .threadExecutionContext(authority.ownerId, threadId)
    .pipe(Effect.mapError(unavailable))
  if (row === undefined || row.lifecycle === "terminated") return yield* forbidden()
  const placement = yield* Schema.decodeUnknownEffect(ExecutorPlacementPolicy)(row.placement).pipe(
    Effect.mapError(forbidden),
  )
  if (placement._tag !== "RunnerPlacement" || placement.deviceId !== deviceId) return yield* forbidden()
  return yield* decodeThreadBinding(row, {
    environment: options.environment,
    ownerId: authority.ownerId,
    threadId,
  }).pipe(Effect.mapError(forbidden))
})

export const authorizeRunnerConnection = Effect.fn("Rika.RunnerConnection.authorize")(function* (
  request: Request,
  threadId: string,
  options: RunnerConnectionOptions,
): Effect.fn.Return<RunnerConnectionAuthorization, RunnerConnectionError> {
  const access = yield* authenticateIdentityRequest(request, options).pipe(
    Effect.mapError((error) => (error.kind === "unavailable" ? unavailable() : unauthorized())),
  )
  if (access.deviceId === undefined || access.principal.clientId === undefined) return yield* unauthorized()
  const binding = yield* currentBinding(access.principal, access.deviceId, threadId, options)
  return {
    binding,
    validate: currentBinding(access.principal, access.deviceId, threadId, options).pipe(
      Effect.flatMap((current) =>
        sameBinding(binding.workspaceBinding, current.workspaceBinding) ? Effect.void : forbidden(),
      ),
    ),
  }
})

export const makeAuthorizedRunnerConnection = Effect.fn("Rika.RunnerConnection.makeAuthorized")(function* (input: {
  readonly authorization: RunnerConnectionAuthorization
  readonly peer: WorkspaceExecutorWebSocketPeer
}): Effect.fn.Return<
  WorkspaceExecutorWebSocketServer,
  ExecutorFenceError | ExecutorTransportError,
  Scope.Scope
> {
  const ownerScope = yield* Scope.Scope
  const authorization = input.authorization
  const validate = authorization.validate.pipe(
    Effect.mapError((error) =>
      error.kind === "unavailable"
        ? ExecutorTransportError.make({ phase: "connection", message: "Runner authority is unavailable" })
        : ExecutorFenceError.make({ reason: "assignment", message: "Runner authority is no longer valid" }),
    ),
  )
  const server = yield* makeWorkspaceExecutorWebSocketServer({
    authorize: () => validate.pipe(Effect.as(authorization.binding.workspaceBinding)),
    peer: input.peer,
  })
  let closed = false
  const disconnect = (code: number, reason: string) =>
    server.disconnected().pipe(
      Effect.andThen(
        Effect.try({
          try: () => {
            if (closed) return
            closed = true
            input.peer.close(code, reason)
          },
          catch: () =>
            ExecutorTransportError.make({ phase: "connection", message: "Runner connection could not close" }),
        }).pipe(Effect.ignore),
      ),
    )
  yield* Effect.addFinalizer(() => disconnect(1000, "Runner connection closed"))
  const guard = validate.pipe(Effect.tapError(() => disconnect(1008, "Runner authorization expired")))
  const heartbeat = yield* guard.pipe(
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.ignore,
    Effect.forkIn(ownerScope),
  )
  return {
    ready: guard.pipe(Effect.andThen(server.ready)),
    receive: (frame) => guard.pipe(Effect.andThen(server.receive(frame))),
    disconnected: () => Fiber.interrupt(heartbeat).pipe(Effect.andThen(disconnect(1000, "Runner connection closed"))),
    executor: {
      binding: server.executor.binding,
      handshake: (request) => guard.pipe(Effect.andThen(server.executor.handshake(request))),
      dispatch: (intent, request, handshake) =>
        guard.pipe(Effect.andThen(server.executor.dispatch(intent, request, handshake))),
      receipt: (operationId) => guard.pipe(Effect.andThen(server.executor.receipt(operationId))),
      cancel: (operationId) => guard.pipe(Effect.andThen(server.executor.cancel(operationId))),
    },
  }
})

export const makeRunnerExecutorConnection = Effect.fn("Rika.RunnerConnection.make")(function* (input: {
  readonly request: Request
  readonly threadId: string
  readonly options: RunnerConnectionOptions
  readonly peer: WorkspaceExecutorWebSocketPeer
}) {
  const authorization = yield* authorizeRunnerConnection(input.request, input.threadId, input.options)
  return yield* makeAuthorizedRunnerConnection({ authorization, peer: input.peer })
})
