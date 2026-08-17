import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as Operation from "@rika/product/product-operation-service"
import * as ServerService from "@rika/product/server-service"
import {
  Clock,
  Config,
  Console,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  FileSystem,
  Queue,
  Ref,
  Scope,
  Semaphore,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { readOrCreateToken, resolve } from "../../server/process/server-endpoint"
import { releaseAdoptedStartup } from "../../server/process/server-startup"
import { hardExit, makeExecutionControls } from "./server-host-operation"
import type { Owner } from "./server-host-operation"
import { makeConnectionHandler } from "./server-host-connection"
import { isServerPath } from "./server-websocket-server"
import { makeInteractiveRouter } from "./server-host-feed"
import { defaultOutboundCapacity, json } from "../protocol/server-protocol"
import { watchConfigFileForRestart } from "../../server/process/server-config-reload"
export const host = Effect.fn("ServerTransport.host")(function* (options: {
  readonly port: number
  readonly identity: string
  readonly token: string
  readonly graceMilliseconds: number
  readonly abandonMilliseconds: number
  readonly ownerDrainMilliseconds: number
  readonly startupHoldMilliseconds: number
  readonly outboundCapacity: number
  readonly stopped: Deferred.Deferred<void>
  readonly ready: Deferred.Deferred<void>
  readonly onReady: Effect.Effect<void, ServerService.ServerServiceError, FileSystem.FileSystem>
  readonly owner: Owner
  readonly configWatchPaths?: ReadonlyArray<string>
  readonly configReloadDebounceMilliseconds?: number
  readonly configReloadDrainTimeoutMilliseconds?: number
}) {
  const crypto = yield* Crypto.Crypto
  const baseConsole = yield* Console.Console
  const hostScope = yield* Effect.scope
  const serviceNonce = yield* crypto.randomUUIDv4
  const graceFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
  const coldCohortUntil = yield* Ref.make(0)
  const lifecycle = yield* ServerService.ServiceRuntime.makeLifecycle(() => Effect.void)
  const hostWork = yield* FiberSet.make<void, never>()
  const activeConnections = yield* Ref.make(new Map<string, Effect.Effect<void>>())
  const operationAdmission = yield* Semaphore.make(32)
  const drainingFailure = (requestId: string, operation: string) =>
    writerFailure(
      requestId,
      ProductOperation.OperationUnavailable.make({ operation, message: "Rika Server is draining" }),
    )
  const writerFailure = (requestId: string, error: ProductOperation.OperationUnavailable) =>
    json({ _tag: "operation-failed", requestId, error } satisfies ServerService.ServerMessage)
  const scheduleGrace = (generation: number, delay = options.graceMilliseconds) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const cohortUntil = yield* Ref.get(coldCohortUntil)
      const effectiveDelay = Math.max(delay, cohortUntil - now)
      const fiber = yield* Effect.forkIn(
        Effect.sleep(effectiveDelay).pipe(
          Effect.andThen(lifecycle.expireGrace(generation)),
          Effect.flatMap((draining) => (draining ? Deferred.succeed(options.stopped, undefined) : Effect.void)),
          Effect.asVoid,
        ),
        hostScope,
      )
      yield* Ref.set(graceFiber, fiber)
    })
  const abandonFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
  const scheduleAbandonment = (generation: number, sleepMilliseconds = options.abandonMilliseconds) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(
        Effect.sleep(sleepMilliseconds).pipe(
          Effect.andThen(lifecycle.graceHolds(generation)),
          Effect.flatMap((abandoned) => (abandoned ? stopAbandonedExecutionWork(generation) : Effect.void)),
        ),
        hostScope,
      )
      yield* Ref.set(abandonFiber, fiber)
    })
  const requestByInput = new WeakMap<object, { readonly requestId: string; readonly routeKey: string }>()
  type ServerSession = {
    readonly session: InteractiveSession.InteractiveSession
    readonly ended: Deferred.Deferred<void>
    readonly feedGeneration: string
    readonly commands: Map<number, Deferred.Deferred<void>>
    readonly commandReleases: Map<number, Effect.Effect<void>>
    readonly commandQueue: Queue.Queue<{
      readonly sequence: number
      readonly cancelled: Deferred.Deferred<void>
      readonly effect: Effect.Effect<void, ProductOperation.OperationUnavailable | ServerService.ServerServiceError>
    }>
    readonly acceptCommand: (sequence: number) => boolean
    readonly acknowledge: (throughSequence: number) => Effect.Effect<boolean>
  }
  const routes = yield* Ref.make(
    new Map<
      string,
      {
        readonly connectionId: string
        readonly send: (text: string) => Effect.Effect<void, ProductOperation.OperationUnavailable>
        readonly sendFrames: (
          frames: ReadonlyArray<string>,
        ) => Effect.Effect<void, ProductOperation.OperationUnavailable>
        readonly sessions: Map<string, ServerSession>
      }
    >(),
  )
  const interactive = makeInteractiveRouter({ crypto, options, requestByInput, routes })
  const ownerScope = yield* Scope.make()
  const serverScope = yield* Scope.make()
  const operationReady = yield* Deferred.make<Operation.Interface>()
  const { prepareServerReplacement, stopAbandonedExecutionWork, stopExecutionWorkForShutdown } =
    makeExecutionControls(operationReady)
  /**
   * A replacement Server adopts this one's durable work, so the exit that hands over must not
   * cancel it. Every other exit ends the work for good and has to say so in durable state.
   */
  const handingOver = yield* Ref.make(false)
  const drainForHandover = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Ref.set(handingOver, true).pipe(Effect.andThen(effect))
  yield* Effect.addFinalizer((exit) =>
    lifecycle.beginDrain.pipe(
      Effect.andThen(FiberSet.clear(hostWork)),
      Effect.andThen(
        Ref.get(handingOver).pipe(
          Effect.flatMap((replacing) => (replacing ? Effect.void : stopExecutionWorkForShutdown)),
        ),
      ),
      Effect.andThen(
        Effect.raceFirst(
          FiberSet.awaitEmpty(hostWork).pipe(Effect.andThen(Scope.close(ownerScope, exit))),
          Effect.sleep(options.ownerDrainMilliseconds).pipe(
            Effect.andThen(hardExit(`owner drain exceeded ${options.ownerDrainMilliseconds}ms`)),
          ),
        ),
      ),
      Effect.andThen(
        Ref.get(activeConnections).pipe(
          Effect.flatMap((connections) =>
            Effect.forEach(
              connections.values(),
              (close) =>
                close.pipe(
                  Effect.timeoutOrElse({
                    duration: "250 millis",
                    orElse: () => Effect.logWarning("server.shutdown.connection_close.timeout").pipe(Effect.asVoid),
                  }),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
      ),
      Effect.andThen(
        Scope.close(serverScope, exit).pipe(
          Effect.timeoutOrElse({
            duration: "500 millis",
            orElse: () => Effect.logWarning("server.shutdown.server_close.timeout").pipe(Effect.asVoid),
          }),
        ),
      ),
    ),
  )
  const server = yield* Scope.provide(BunHttpServer.make({ hostname: "127.0.0.1", port: options.port }), serverScope)
  const handle = makeConnectionHandler({
    options,
    crypto,
    baseConsole,
    hostScope,
    serviceNonce,
    graceFiber,
    lifecycle,
    hostWork,
    activeConnections,
    operationAdmission,
    drainingFailure,
    scheduleGrace,
    abandonFiber,
    scheduleAbandonment,
    requestByInput,
    routes,
    interactive,
    operationReady,
    prepareServerReplacement,
    drainForHandover,
    requestStop: Deferred.succeed(options.stopped, undefined).pipe(Effect.asVoid),
  })
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!isServerPath(request.url)) return HttpServerResponse.empty({ status: 404 })
    const socket = yield* request.upgrade
    yield* handle(socket)
    return HttpServerResponse.empty()
  })
  yield* Scope.provide(server.serve(app), serverScope)
  const operation = yield* Scope.provide(options.owner(interactive), ownerScope)
  yield* Deferred.succeed(operationReady, operation)
  yield* Ref.set(coldCohortUntil, (yield* Clock.currentTimeMillis) + options.startupHoldMilliseconds)
  const startupGrace = yield* lifecycle.ready
  if (startupGrace !== undefined) {
    yield* scheduleGrace(startupGrace)
    yield* scheduleAbandonment(startupGrace)
  }
  yield* options.onReady
  if (options.configWatchPaths !== undefined && options.configWatchPaths.length > 0) {
    const restartForConfigChange = Effect.gen(function* () {
      yield* Effect.logInfo("server.config.reloading")
      yield* lifecycle.beginDrain
      yield* Effect.forkIn(
        drainForHandover(lifecycle.drainForReplacement(prepareServerReplacement)).pipe(
          Effect.raceFirst(Effect.sleep(options.configReloadDrainTimeoutMilliseconds ?? 30_000).pipe(Effect.asVoid)),
          Effect.ensuring(Deferred.succeed(options.stopped, undefined)),
        ),
        hostScope,
      )
    })
    yield* Effect.forkIn(
      Effect.forEach(
        options.configWatchPaths,
        (filename) =>
          watchConfigFileForRestart({
            filename,
            debounceMilliseconds: options.configReloadDebounceMilliseconds ?? 1_000,
            onRestart: restartForConfigChange,
          }),
        { concurrency: "unbounded", discard: true },
      ),
      hostScope,
    )
  }
  yield* Effect.logInfo("server.listener.ready")
  yield* Deferred.succeed(options.ready, undefined)
  yield* Deferred.await(options.stopped)
})
export const serve = Effect.fn("ServerTransport.serve")(function* (options: {
  readonly profile: string
  readonly dataRoot: string
  readonly graceMilliseconds?: number
  readonly abandonMilliseconds?: number
  readonly ownerDrainMilliseconds?: number
  readonly startupHoldMilliseconds?: number
  readonly outboundCapacity?: number
  readonly onReady?: Effect.Effect<void, ServerService.ServerServiceError, FileSystem.FileSystem>
  readonly owner: Owner
}) {
  const endpoint = yield* resolve(options.profile, options.dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const ownerDrainMilliseconds =
    options.ownerDrainMilliseconds ??
    Number(yield* Config.string("RIKA_INTERNAL_SERVER_OWNER_DRAIN").pipe(Config.withDefault("5000")))
  const stopped = yield* Deferred.make<void>()
  const ready = yield* Deferred.make<void>()
  yield* Effect.forkChild(
    Deferred.await(ready).pipe(
      Effect.andThen(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)),
    ),
  )
  yield* host({
    ...endpoint,
    token,
    graceMilliseconds: options.graceMilliseconds ?? 500,
    abandonMilliseconds:
      options.abandonMilliseconds ??
      Number(yield* Config.string("RIKA_INTERNAL_SERVER_ABANDON").pipe(Config.withDefault("5000"))),
    ownerDrainMilliseconds,
    startupHoldMilliseconds: options.startupHoldMilliseconds ?? 10_000,
    outboundCapacity: Math.max(1, Math.floor(options.outboundCapacity ?? defaultOutboundCapacity)),
    stopped,
    ready,
    onReady: options.onReady ?? Effect.void,
    owner: options.owner,
  }).pipe(Effect.ensuring(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)))
})
