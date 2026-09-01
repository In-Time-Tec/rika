import type { Interface as Controller, Quiescence } from "@rika/e2b-executor/controller"
import { redactAccess, type AccessWire, type ApiMessage } from "@rika/remote-execution/protocol"
import { Clock, Crypto, Deferred, Effect, Option, PubSub, Ref, type Semaphore, Stream } from "effect"
import {
  GatewayError,
  type Gateway,
  type PreparationStore,
  type PtyEvent,
  type PtyRequest,
  type Socket,
} from "./contract"
import { gatewayProtocol } from "./protocol"
import type { GatewaySession as Session } from "./rpc/model"

const { accessFailure, expired, sameAccess } = gatewayProtocol

export const gatewayControlFactory = (options: {
  readonly controller: Controller
  readonly preparation: PreparationStore
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly assignments: Ref.Ref<Map<Socket, string>>
  readonly quiescing: Ref.Ref<Set<string>>
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
  readonly crypto: Crypto.Crypto
  readonly ptyFrames: PubSub.PubSub<PtyEvent>
  readonly awaitSession: (assignmentId: string) => Effect.Effect<Session>
  readonly send: (socket: Socket, message: ApiMessage) => void
}) => {
  const publishPty = Effect.fn("ExecutorGateway.publishPty")(function* (socket: Socket, message: PtyEvent) {
    yield* options.admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.get(options.assignments).pipe(Effect.map((current) => current.get(socket)))
        const session = assignmentId === undefined ? undefined : (yield* Ref.get(options.sessions)).get(assignmentId)
        if (session?.socket !== socket || !sameAccess(session.access, message.access))
          return yield* GatewayError.make({ kind: "fenced", message: "PTY frame has a stale executor session" })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
        yield* options.controller.validateAccess(redactAccess(message.access))
        yield* PubSub.publish(options.ptyFrames, message)
      }),
    )
  })

  const sendPty = Effect.fn("ExecutorGateway.sendPty")(function* (assignmentId: string, request: PtyRequest) {
    const connected = yield* options.awaitSession(assignmentId).pipe(Effect.timeoutOption("30 seconds"))
    if (Option.isNone(connected))
      return yield* GatewayError.make({ kind: "timeout", message: "Executor did not connect in time" })
    yield* options.admission.withPermits(1)(
      Effect.gen(function* () {
        const session = (yield* Ref.get(options.sessions)).get(assignmentId)
        if (session === undefined)
          return yield* GatewayError.make({
            kind: "disconnected",
            message: "Executor disconnected before the PTY request could be sent",
          })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
        yield* options.controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
        yield* Effect.try({
          try: () => options.send(session.socket, { ...request, fence: session.access.fence }),
          catch: () => GatewayError.make({ kind: "transport", message: "Could not send the PTY request" }),
        })
      }),
    )
  })

  const ptyEvents = (assignmentId: string) =>
    Stream.fromPubSub(options.ptyFrames).pipe(
      Stream.filter((message) => message.access.fence.assignmentId === assignmentId),
    )

  const retryPreparation = Effect.fn("ExecutorGateway.retryPreparation")(function* (assignmentId: string) {
    const session = yield* Ref.get(options.sessions).pipe(Effect.map((current) => current.get(assignmentId)))
    if (session === undefined)
      return yield* GatewayError.make({ kind: "disconnected", message: "Executor is not connected" })
    const attempt = yield* options.preparation.retry(session.access)
    options.send(session.socket, { _tag: "WorkspacePreparationRetry", fence: session.access.fence, attempt })
  })

  const active: Gateway["active"] = (socket) =>
    Effect.gen(function* () {
      const assignmentId = (yield* Ref.get(options.assignments)).get(socket)
      if (assignmentId === undefined) return true
      const current = (yield* Ref.get(options.sessions)).get(assignmentId)
      if (current === undefined || current.socket !== socket) return false
      return yield* options.controller.validateAccess(redactAccess(current.access)).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            const log =
              error.kind === "repository"
                ? Effect.logWarning("executor-gateway.authority-unavailable")
                : Effect.logError("executor-gateway.authority-invalid")
            return log.pipe(
              Effect.annotateLogs({
                "rika.executor.assignment.id": assignmentId,
                "rika.error.kind": error.kind,
                "rika.error.message": error.message,
              }),
              Effect.as(error.kind === "repository"),
            )
          },
          onSuccess: () => Effect.succeed(true),
        }),
      )
    })

  const quiesce = Effect.fn("ExecutorGateway.quiesce")(function* (assignmentId: string) {
    const command = yield* options.admission.withPermits(1)(
      Effect.gen(function* () {
        const session = (yield* Ref.get(options.sessions)).get(assignmentId)
        if (session === undefined || !session.ready)
          return yield* GatewayError.make({ kind: "disconnected", message: "Executor workspace is not ready" })
        yield* options.controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
        const result = yield* Deferred.make<Quiescence, GatewayError>()
        const requestId = yield* options.crypto.randomUUIDv4.pipe(
          Effect.mapError(() =>
            GatewayError.make({ kind: "transport", message: "Could not identify quiesce request" }),
          ),
        )
        yield* Ref.update(options.quiescing, (current) => new Set(current).add(assignmentId))
        yield* Ref.update(options.quiescence, (current) =>
          new Map(current).set(assignmentId, { access: session.access, requestId, result }),
        )
        yield* Effect.try({
          try: () => options.send(session.socket, { _tag: "Quiesce", fence: session.access.fence, requestId }),
          catch: () => GatewayError.make({ kind: "transport", message: "Could not quiesce executor" }),
        })
        return result
      }),
    )
    return yield* Deferred.await(command).pipe(
      Effect.timeoutOption("60 seconds"),
      Effect.flatMap((completed) =>
        Option.isNone(completed)
          ? GatewayError.make({ kind: "timeout", message: "Executor did not quiesce in time" })
          : Effect.succeed(completed.value),
      ),
      Effect.ensuring(
        Ref.update(options.quiescence, (current) => {
          if (current.get(assignmentId)?.result !== command) return current
          const next = new Map(current)
          next.delete(assignmentId)
          return next
        }),
      ),
    )
  })

  return { active, ptyEvents, publishPty, quiesce, retryPreparation, sendPty }
}
