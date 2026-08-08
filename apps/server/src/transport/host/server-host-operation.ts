import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as Operation from "@rika/product/product-operation-service"
import * as InteractiveFeedOverflow from "@rika/product/server-interactive-feed"
import * as ServerService from "@rika/product/server-service"
import {
  Cause,
  Clock,
  Console,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { failureKind, outputFrames } from "@rika/client/protocol/server-message-codec"
import { json } from "@rika/client/protocol/server-protocol"
import { formatOutput } from "./server-host-command"
import type { ServerRoute } from "./server-host-types"

type Lifecycle = Effect.Success<ReturnType<typeof ServerService.ServiceRuntime.makeLifecycle>>
type OperationOptions = { readonly identity: string; readonly token: string; readonly outboundCapacity: number }
type OperationContext = {
  readonly message: Extract<ServerService.ClientMessage, { readonly _tag: "operation" }>
  readonly requests: Ref.Ref<
    Map<string, Fiber.Fiber<void, ProductOperation.OperationUnavailable | ServerService.ServerServiceError>>
  >
  readonly close: (code: number, reason?: string) => Effect.Effect<void, ServerService.ServerServiceError>
  readonly writer: (frame: string | Socket.CloseEvent) => Effect.Effect<void, ServerService.ServerServiceError>
  readonly connectionId: string
  readonly routeKey: (requestId: string) => string
  readonly requestByInput: WeakMap<object, { readonly requestId: string; readonly routeKey: string }>
  readonly outboundMessages: Semaphore.Semaphore
  readonly routesRef: Ref.Ref<Map<string, ServerRoute>>
  readonly lifecycle: Lifecycle
  readonly hostWork: FiberSet.FiberSet<void, never>
  readonly options: OperationOptions
  readonly baseConsole: Console.Console
  readonly rawWriter: (frame: string | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>
  readonly operationReady: Deferred.Deferred<Operation.Interface>
  readonly operationAdmission: Semaphore.Semaphore
  readonly drainingFailure: (requestId: string, operation: string) => string
}

export type Owner = (
  interactive: (
    input: InteractiveFeedOverflow.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
  ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
) => Effect.Effect<Operation.Interface, ServerService.ServerServiceError, Scope.Scope>

export type HostOperation = Operation.Interface

export const hardExit = (reason: string) =>
  Effect.logError("server.shutdown.hard_exit").pipe(
    Effect.annotateLogs("rika.server.shutdown.reason", reason),
    Effect.andThen(Effect.sync(() => process.exit(typeof process.exitCode === "number" ? process.exitCode : 143))),
    Effect.asVoid,
  )

export const makeExecutionControls = (operationReady: Deferred.Deferred<Operation.Interface>) => {
  const hasActiveExecutionWork = Deferred.await(operationReady).pipe(
    Effect.flatMap((operation) =>
      operation.authorizeServerReplacement !== undefined
        ? operation.authorizeServerReplacement.pipe(Effect.map((disposition) => disposition === "defer"))
        : (operation.hasActiveExecutionWork ?? Effect.succeed(true)),
    ),
    Effect.catch((error) =>
      Effect.logError("server.replacement.status_failed").pipe(
        Effect.annotateLogs("rika.failure.kind", String(error)),
        Effect.as(true),
      ),
    ),
  )
  const stopExecutionWork = Deferred.await(operationReady).pipe(
    Effect.flatMap((operation) => operation.stopActiveExecutionWork ?? Effect.void),
  )
  const stopAbandonedExecutionWork = (generation: number, requireActiveWork: boolean) =>
    (requireActiveWork ? hasActiveExecutionWork : Effect.succeed(true)).pipe(
      Effect.flatMap((active) =>
        !active
          ? Effect.void
          : Effect.logInfo("server.abandonment.cancelling").pipe(
              Effect.annotateLogs("rika.server.generation", generation),
              Effect.andThen(stopExecutionWork),
              Effect.andThen(
                Effect.logInfo("server.abandonment.cancelled").pipe(
                  Effect.annotateLogs("rika.server.generation", generation),
                ),
              ),
            ),
      ),
      Effect.catch((error) =>
        Effect.logError("server.abandonment.cancel_failed").pipe(
          Effect.annotateLogs("rika.failure.kind", String(error)),
        ),
      ),
    )
  return { hasActiveExecutionWork, stopAbandonedExecutionWork }
}

export const handleOperation = (context: OperationContext) => {
  const {
    message,
    requests,
    close,
    writer,
    connectionId,
    routeKey,
    requestByInput,
    outboundMessages,
    routesRef,
    lifecycle,
    hostWork,
    options,
    baseConsole,
    rawWriter,
    operationReady,
    operationAdmission,
    drainingFailure,
  } = context
  const requestsRef = requests
  const routesState = routesRef
  return Effect.gen(function* () {
    if (message._tag === "operation") {
      if ((yield* Ref.get(requestsRef)).has(message.requestId)) return yield* close(4400)
      yield* Effect.logInfo("server.operation.accepted").pipe(
        Effect.annotateLogs({
          "rika.operation": message.input._tag,
          "rika.server.request.id": message.requestId,
        }),
      )
      const requestRouteKey = routeKey(message.requestId)
      requestByInput.set(message.input, { requestId: message.requestId, routeKey: requestRouteKey })
      const send = (frame: string) =>
        writer(frame).pipe(
          Effect.mapError((error) =>
            ProductOperation.OperationUnavailable.make({
              operation: "ServerConnection",
              message: String(error),
            }),
          ),
        )
      const sendFrames = (frames: ReadonlyArray<string>) =>
        outboundMessages.withPermits(1)(Effect.forEach(frames, send, { discard: true }))
      yield* Ref.update(routesState, (current) =>
        current.set(requestRouteKey, {
          connectionId,
          send,
          sendFrames,
          sessions: new Map(),
        }),
      )
      const started = yield* Deferred.make<void>()
      const fiber = yield* lifecycle.runWork(
        hostWork,
        Deferred.await(started).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              const output = yield* Queue.bounded<
                | { readonly _tag: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
                | { readonly _tag: "finished" }
              >(options.outboundCapacity)
              let outputOverflowed = false
              const write = (channel: "stdout" | "stderr", values: ReadonlyArray<unknown>) => {
                if (!Queue.offerUnsafe(output, { _tag: "output", channel, text: formatOutput(values) }))
                  outputOverflowed = true
              }
              const requestConsole = Object.assign(Object.create(baseConsole) as Console.Console, {
                assert: (condition: boolean, ...values: ReadonlyArray<unknown>) => {
                  if (!condition) write("stderr", values)
                },
                debug: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                error: (...values: ReadonlyArray<unknown>) => write("stderr", values),
                info: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                log: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                warn: (...values: ReadonlyArray<unknown>) => write("stderr", values),
              })
              const sender = yield* Effect.forkChild(
                Effect.gen(function* () {
                  while (true) {
                    const frame = yield* Queue.take(output)
                    if (frame._tag === "finished") return
                    for (const encoded of outputFrames(message.requestId, frame.channel, frame.text))
                      yield* send(encoded)
                  }
                }),
              )
              const operation = yield* Deferred.await(operationReady)
              const execution = operation
                .run(message.input)
                .pipe(Effect.provideService(Console.Console, requestConsole))
              const result = yield* Effect.exit(
                message.input._tag === "Interactive" ? execution : operationAdmission.withPermits(1)(execution),
              )
              const delivery = yield* Effect.raceFirst(
                Fiber.await(sender),
                Queue.offer(output, { _tag: "finished" }).pipe(Effect.andThen(Fiber.await(sender))),
              )
              let outcome
              if (Exit.isFailure(delivery))
                outcome = Exit.fail(
                  ProductOperation.OperationUnavailable.make({
                    operation: message.input._tag,
                    message: `Server output delivery failed: ${Cause.pretty(delivery.cause)}`,
                  }),
                )
              else if (outputOverflowed)
                outcome = Exit.fail(
                  ProductOperation.OperationUnavailable.make({
                    operation: message.input._tag,
                    message: "Server client output queue is overloaded",
                  }),
                )
              else outcome = result
              yield* Exit.match(outcome, {
                onFailure: (cause) => {
                  const failure = Cause.squash(cause)
                  const error = Schema.is(ProductOperation.OperationUnavailable)(failure)
                    ? failure
                    : ProductOperation.OperationUnavailable.make({
                        operation: message.input._tag,
                        message: String(failure),
                      })
                  return Clock.currentTimeMillis.pipe(
                    Effect.flatMap((failedAt) =>
                      Effect.logError("server.operation.failed").pipe(
                        Effect.annotateLogs({
                          "rika.duration.ms": failedAt - startedAt,
                          "rika.failure.kind": failureKind(cause),
                        }),
                      ),
                    ),
                    Effect.andThen(
                      send(
                        json({
                          _tag: "operation-failed",
                          requestId: message.requestId,
                          error,
                        } satisfies ServerService.ServerMessage),
                      ).pipe(Effect.catch(() => rawWriter(new Socket.CloseEvent(1011)).pipe(Effect.ignore))),
                    ),
                  )
                },
                onSuccess: () =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((completedAt) =>
                      Effect.logInfo("server.operation.completed").pipe(
                        Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                      ),
                    ),
                    Effect.andThen(
                      send(
                        json({
                          _tag: "operation-completed",
                          requestId: message.requestId,
                        } satisfies ServerService.ServerMessage),
                      ).pipe(Effect.catch(() => rawWriter(new Socket.CloseEvent(1011)).pipe(Effect.ignore))),
                    ),
                  ),
              })
            }).pipe(
              Effect.annotateLogs({
                "rika.operation": message.input._tag,
                "rika.server.connection.id": connectionId,
                "rika.server.request.id": message.requestId,
              }),
              Effect.ensuring(
                Ref.update(requestsRef, (current) => (current.delete(message.requestId), current)).pipe(
                  Effect.andThen(Ref.update(routesState, (current) => (current.delete(requestRouteKey), current))),
                  Effect.andThen(Effect.sync(() => requestByInput.delete(message.input))),
                ),
              ),
              Effect.asVoid,
            ),
          ),
        ),
        message.input._tag !== "Interactive",
      )
      if (fiber === undefined) {
        yield* Ref.update(routesState, (current) => (current.delete(requestRouteKey), current))
        requestByInput.delete(message.input)
        yield* writer(drainingFailure(message.requestId, message.input._tag))
        return
      }
      yield* Ref.update(requestsRef, (current) => current.set(message.requestId, fiber))
      yield* Deferred.succeed(started, undefined)
    }
  })
}
