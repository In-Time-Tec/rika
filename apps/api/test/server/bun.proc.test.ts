import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope, Stream } from "effect"
import * as SocketClient from "effect/unstable/socket/Socket"
import { TestClock } from "effect/testing"
import type { CliDeviceDirectory, IdentityConfig, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import type { Runtime as ExecutorRuntime } from "../../src/executor/service"
import type { Interface as ControllerService } from "@rika/e2b-executor/controller"
import type { Gateway, Socket } from "../../src/executor/gateway"
import type { HostedProductService } from "../../src/hosted/product"
import type { HttpDependencies } from "../../src/server/http"
import type { RunnerGateway } from "../../src/runner/gateway"
import { serveApi } from "../../src/server/bun"

const config: IdentityConfig = {
  production: false,
  port: 0,
  baseUrl: "http://127.0.0.1",
  trustedOrigins: ["http://127.0.0.1"],
  authSecret: Redacted.make("abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEF"),
  github: { clientId: "test", clientSecret: Redacted.make("test") },
  mail: { resendApiKey: Redacted.make("test"), emailFrom: "test@example.test" },
  resource: "http://127.0.0.1/api/v1",
  databaseUrl: Redacted.make("postgresql://unused"),
  databaseSsl: "disable",
}

const unusedController: ControllerService = {
  provision: () => Effect.die("unused"),
  replace: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  pause: () => Effect.die("unused"),
  kill: () => Effect.die("unused"),
  portal: () => Effect.die("unused"),
  hello: () => Effect.die("unused"),
  reconnect: () => Effect.die("unused"),
  validateAccess: () => Effect.die("unused"),
  heartbeat: () => Effect.die("unused"),
  checkpoint: () => Effect.die("unused"),
  credential: () => Effect.die("unused"),
  revokeCredential: () => Effect.die("unused"),
  workspace: () => Effect.die("unused"),
  ready: () => Effect.die("unused"),
  loadSetupCache: () => Effect.die("unused"),
  storeSetupCache: () => Effect.die("unused"),
  activatePhase: () => Effect.die("unused"),
  cleanupOrphans: Effect.die("unused"),
}

const dependencies = (gateway: Gateway, ready: Effect.Effect<void> = Effect.void): HttpDependencies => {
  const identity: IdentityRuntime = {
    handle: () => Effect.die("unused"),
    identify: () => Effect.die("unused"),
    protectedResourceMetadata: Effect.die("unused"),
  }
  const directory: IdentityDirectory = {
    ready: Effect.void,
    account: () => Effect.die("unused"),
  }
  const devices: CliDeviceDirectory = {
    register: () => Effect.die("unused"),
    discard: () => Effect.die("unused"),
    authenticate: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    revokeAll: () => Effect.die("unused"),
  }
  const product: HostedProductService = {
    ready,
    activatePrincipal: () => Effect.die("unused"),
    authorizeOwner: () => Effect.die("unused"),
    authorizeThread: () => Effect.die("unused"),
    threadExecutionContext: () => Effect.die("unused"),
    projects: () => Effect.die("unused"),
    createProject: () => Effect.die("unused"),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    createConnection: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
    admitAuthorizedRun: () => Effect.die("unused"),
    cancelRunAdmission: () => Effect.die("unused"),
    cancelAuthorizedRunAdmission: () => Effect.die("unused"),
  }
  const executor: ExecutorRuntime = {
    controller: unusedController,
    gateway,
    runnerGateway: {
      receive: gateway.receive,
      disconnected: gateway.disconnected,
      active: gateway.active,
      execute: () => Effect.die("unused"),
      cancel: (input) => gateway.cancel(input).pipe(Effect.map((result) => ({ ...result, eventPersisted: true }))),
    } satisfies RunnerGateway,
    admitRunner: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
    runTool: () => Effect.die("unused"),
    cancelTool: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    replace: () => Effect.die("unused"),
    ready: Effect.void,
  }
  return {
    identity,
    directory,
    devices,
    product,
    executor,
    recovery: {
      inspect: () => Effect.die("unused"),
      resolve: () => Effect.die("unused"),
      reconcileCompleted: Effect.die("unused"),
    },
    execution: {
      check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }),
      status: Effect.succeed({
        scan: { _tag: "Starting" },
        wakeup: { _tag: "Starting" },
        lastFallbackAt: undefined,
        lastFailure: undefined,
        active: 0,
        capacity: 1,
        oldestClaimAt: undefined,
        scanAgeMillis: undefined,
        wakeupAgeMillis: undefined,
        lastFallbackAgeMillis: undefined,
        oldestClaimAgeMillis: undefined,
        lastFailureAgeMillis: undefined,
        availableCapacity: 1,
        execution: { worker: "execution" },
        turn: { worker: "turn", active: 0, capacity: 1, oldestClaimAgeMillis: undefined },
        projection: {
          worker: "projection",
          active: 0,
          capacity: 1,
          oldestActiveProjectionAgeMillis: undefined,
        },
      }),
    },
    production: false,
  }
}

const connect = (url: string) => {
  const effect = Effect.gen(function* () {
    const socket = yield* SocketClient.makeWebSocket(url)
    const send = yield* socket.writer
    const opened = yield* Deferred.make<void>()
    const firstMessage = yield* Deferred.make<string>()
    const messages: Array<string> = []
    const fiber = yield* socket
      .runString(
        (message) =>
          Effect.sync(() => messages.push(message)).pipe(Effect.andThen(Deferred.succeed(firstMessage, message))),
        { onOpen: Deferred.succeed(opened, undefined) },
      )
      .pipe(Effect.forkScoped)
    yield* Deferred.await(opened).pipe(Effect.raceFirst(Fiber.join(fiber)))
    return { send, close: Fiber.interrupt(fiber), messages, firstMessage }
  })
  return Layer.build(BunSocket.layerWebSocketConstructor).pipe(
    Effect.flatMap((context) => Effect.provide(effect, context)),
  )
}

const tag = (message: string | Uint8Array<ArrayBufferLike>) => {
  const body = Schema.is(Schema.String)(message) ? message : new TextDecoder().decode(message)
  return Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ _tag: Schema.optional(Schema.String) })))(body)._tag
}

const verifiesSessionReplacement = (endpoint: "executors" | "runners") =>
  Effect.gen(function* () {
    const machineStarted = yield* Deferred.make<void>()
    const machineCompleted = yield* Deferred.make<void>()
    const releaseReverse = yield* Deferred.make<void>()
    const oldDisconnected = yield* Deferred.make<void>()
    const disconnected: Array<Socket> = []
    let oldSocket: Socket | undefined
    let interrupted = false
    const gateway: Gateway = {
      receive: (socket, message) => {
        if (tag(message) === "MachineResult") {
          oldSocket ??= socket
          return Deferred.succeed(machineStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReverse)),
            Effect.andThen(Deferred.succeed(machineCompleted, undefined)),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          )
        }
        return Effect.sync(() => socket.send("replacement-active"))
      },
      disconnected: (socket) =>
        Effect.sync(() => {
          disconnected.push(socket)
        }).pipe(Effect.tap(() => (socket === oldSocket ? Deferred.succeed(oldDisconnected, undefined) : Effect.void))),
      active: () => Effect.succeed(true),
      execute: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      workspace: () => Effect.die("unused"),
      sendPty: () => Effect.die("unused"),
      ptyEvents: () => Stream.empty,
      retryPreparation: () => Effect.void,
      quiesce: () => Effect.die("unused"),
      pushBranch: () => Effect.die("unused"),
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies: dependencies(gateway) }).pipe(
      Effect.provideService(Scope.Scope, resourceScope),
    )
    const url = `ws://127.0.0.1:${running.server.port}/api/v1/${endpoint}`
    const original = yield* connect(url)
    yield* original.send('{"_tag":"MachineResult"}')
    yield* Deferred.await(machineStarted)
    yield* original.close
    yield* Deferred.await(oldDisconnected)
    expect(interrupted).toBe(false)
    expect((yield* Deferred.poll(machineCompleted))._tag).toBe("None")

    const replacement = yield* connect(url)
    yield* replacement.send('{"_tag":"CurrentSession"}')
    expect(yield* Deferred.await(replacement.firstMessage)).toBe("replacement-active")
    expect(replacement.messages).toEqual(["replacement-active"])

    yield* Deferred.succeed(releaseReverse, undefined)
    yield* Deferred.await(machineCompleted)
    expect(interrupted).toBe(false)
    expect(disconnected).toEqual([oldSocket])
    expect(replacement.messages).toEqual(["replacement-active"])

    yield* replacement.close
    yield* Scope.close(resourceScope, Exit.void)
  })

it.effect("keeps executor reverse receives alive after their WebSocket disconnects", () =>
  verifiesSessionReplacement("executors"),
)

it.effect("keeps Runner reverse receives alive after their WebSocket disconnects", () =>
  verifiesSessionReplacement("runners"),
)

it.effect("gives reverse-channel receives a bounded graceful server shutdown", () =>
  Effect.gen(function* () {
    const terminalized = yield* Deferred.make<void>()
    const cleanupStarted = yield* Deferred.make<void>()
    const releaseCleanup = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const gateway: Gateway = {
      receive: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(terminalized, undefined)
          return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseCleanup))),
          ),
        ),
      disconnected: () => Effect.void,
      active: () => Effect.succeed(true),
      execute: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      workspace: () => Effect.die("unused"),
      sendPty: () => Effect.die("unused"),
      ptyEvents: () => Stream.empty,
      retryPreparation: () => Effect.void,
      quiesce: () => Effect.die("unused"),
      pushBranch: () => Effect.die("unused"),
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies: dependencies(gateway) }).pipe(
      Effect.provideService(Scope.Scope, resourceScope),
    )
    const connected = yield* connect(`ws://127.0.0.1:${running.server.port}/api/v1/executors`)
    yield* connected.send('{"_tag":"MachineResult"}')
    yield* Deferred.await(terminalized)

    const closing = yield* Scope.close(resourceScope, Exit.void).pipe(
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.forkChild,
    )
    yield* Effect.yieldNow
    expect((yield* Deferred.poll(cleanupStarted))._tag).toBe("None")
    expect((yield* Deferred.poll(closed))._tag).toBe("None")

    yield* TestClock.adjust("5 seconds")
    yield* Deferred.await(cleanupStarted)
    expect((yield* Deferred.poll(closed))._tag).toBe("None")
    expect(connected.messages).toEqual([])

    yield* Deferred.succeed(releaseCleanup, undefined)
    yield* Fiber.join(closing)
    expect(connected.messages).toEqual([])
  }),
)

it.effect("race-closes admission and forces bounded shutdown after session cleanup", () =>
  Effect.gen(function* () {
    const httpStarted = yield* Deferred.make<void>()
    const releaseHttp = yield* Deferred.make<void>()
    const serialStarted = yield* Deferred.make<void>()
    const reverseStarted = yield* Deferred.make<void>()
    const serialCleanup = yield* Deferred.make<void>()
    const reverseCleanup = yield* Deferred.make<void>()
    const releaseCleanup = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    let queuedSerialStarted = false
    let receiveResumed = false
    const receive = (started: Deferred.Deferred<void>, cleanup: Deferred.Deferred<void>) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.tap(() =>
          Effect.sync(() => {
            receiveResumed = true
          }),
        ),
        Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(releaseCleanup)))),
      )
    const gateway: Gateway = {
      receive: (_, message) => {
        const current = tag(message)
        if (current === "MachineResult") return receive(reverseStarted, reverseCleanup)
        if (current === "Serialized") return receive(serialStarted, serialCleanup)
        return Effect.sync(() => {
          queuedSerialStarted = true
        })
      },
      disconnected: () => Effect.void,
      active: () => Effect.succeed(true),
      execute: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      workspace: () => Effect.die("unused"),
      sendPty: () => Effect.die("unused"),
      ptyEvents: () => Stream.empty,
      retryPreparation: () => Effect.void,
      quiesce: () => Effect.die("unused"),
      pushBranch: () => Effect.die("unused"),
    }
    const ready = Deferred.succeed(httpStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseHttp)))
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies: dependencies(gateway, ready) }).pipe(
      Effect.provideService(Scope.Scope, resourceScope),
    )
    const baseUrl = `http://127.0.0.1:${running.server.port}`
    const connected = yield* connect(`${baseUrl.replace("http", "ws")}/api/v1/executors`)
    yield* connected.send('{"_tag":"Serialized"}')
    yield* connected.send('{"_tag":"QueuedSerialized"}')
    yield* connected.send('{"_tag":"MachineResult"}')
    const request = yield* Effect.tryPromise(() => Bun.fetch(`${baseUrl}/readyz`)).pipe(Effect.forkChild)
    yield* Deferred.await(serialStarted)
    yield* Deferred.await(reverseStarted)
    yield* Deferred.await(httpStarted)

    const closing = yield* Scope.close(resourceScope, Exit.void).pipe(
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.forkChild,
    )
    yield* Deferred.await(serialCleanup)
    expect((yield* Deferred.poll(reverseCleanup))._tag).toBe("None")
    const lateUpgrade = yield* Effect.exit(connect(`${baseUrl.replace("http", "ws")}/api/v1/executors`))
    expect(lateUpgrade._tag).toBe("Failure")
    expect((yield* Deferred.poll(closed))._tag).toBe("None")
    expect(queuedSerialStarted).toBe(false)

    yield* TestClock.adjust("5 seconds")
    yield* Deferred.await(reverseCleanup)
    expect((yield* Deferred.poll(closed))._tag).toBe("None")
    expect(receiveResumed).toBe(false)
    expect(queuedSerialStarted).toBe(false)

    yield* Deferred.succeed(releaseCleanup, undefined)
    yield* Deferred.await(closed)
    yield* Deferred.succeed(releaseHttp, undefined)
    yield* Fiber.await(request)
    yield* Fiber.join(closing)
  }),
)
