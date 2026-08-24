import * as BunSocket from "@effect/platform-bun/BunSocket"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope, Stream } from "effect"
import * as SocketClient from "effect/unstable/socket/Socket"
import { TestClock } from "effect/testing"
import type { CliDeviceDirectory, IdentityConfig, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import type { Runtime as ExecutorRuntime } from "../../src/executor/service"
import type { Gateway, Socket } from "../../src/executor/gateway"
import type { HostedProductService } from "../../src/hosted/product"
import type { HttpDependencies } from "../../src/server/http"
import type { RunnerGateway } from "../../src/runner/gateway"
import { serveApi } from "../../src/server/bun"
import { testToolPolicy } from "../hosted/execution/tool-policy.fixture"

const config: IdentityConfig = {
  production: false,
  port: 0,
  baseUrl: "http://127.0.0.1",
  trustedOrigins: ["http://127.0.0.1"],
  authSecret: Redacted.make("abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEF"),
  githubClientId: "test",
  githubClientSecret: Redacted.make("test"),
  resendApiKey: Redacted.make("test"),
  emailFrom: "test@example.test",
  resource: "http://127.0.0.1/api/v1",
  databaseUrl: Redacted.make("postgresql://unused"),
  databaseSsl: "disable",
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
    authorizeThread: () => Effect.die("unused"),
    threadExecutionContext: () => Effect.die("unused"),
    projects: () => Effect.die("unused"),
    createProject: () => Effect.die("unused"),
    registerRunner: () => Effect.die("unused"),
    setRemoteThreadCreation: () => Effect.die("unused"),
    pollRunner: () => Effect.die("unused"),
    createConnection: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
  }
  const executor: ExecutorRuntime = {
    controller: undefined as never,
    gateway,
    runnerGateway: {
      receive: gateway.receive,
      disconnected: gateway.disconnected,
      active: gateway.active,
      execute: () => Effect.die("unused"),
      cancel: gateway.cancel,
      machine: gateway.machine,
    } satisfies RunnerGateway,
    admitRunner: () => Effect.die("unused"),
    admitRun: () => Effect.die("unused"),
    run: () => Effect.die("unused"),
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
    toolPolicy: testToolPolicy,
    executor,
    recovery: { inspect: () => Effect.die("unused"), resolve: () => Effect.die("unused") },
    execution: {
      check: Effect.succeed({ backend: "postgres", source: "test", workerId: "test" }),
      status: Effect.succeed({} as never),
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

const tag = (message: unknown) => {
  const body = typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer)
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ _tag: Schema.optional(Schema.String) })))(body)
    ._tag
}

const verifiesSessionReplacement = (endpoint: "executors" | "runners") =>
  Effect.gen(function* () {
    const bindingStarted = yield* Deferred.make<void>()
    const machineStarted = yield* Deferred.make<void>()
    const bindingCleanup = yield* Deferred.make<void>()
    const machineCleanup = yield* Deferred.make<void>()
    const releaseCleanup = yield* Deferred.make<void>()
    const oldDisconnected = yield* Deferred.make<void>()
    const disconnected: Array<Socket> = []
    let oldSocket: Socket | undefined
    let resumedOldReceive = false
    const reverseReceive = (started: Deferred.Deferred<void>, cleanup: Deferred.Deferred<void>) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.tap(() =>
          Effect.sync(() => {
            resumedOldReceive = true
          }),
        ),
        Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(releaseCleanup)))),
      )
    const gateway: Gateway = {
      receive: (socket, message) => {
        const current = tag(message)
        if (current === "BindingInvoke") {
          oldSocket ??= socket
          return reverseReceive(bindingStarted, bindingCleanup)
        }
        if (current === "MachineResult") return reverseReceive(machineStarted, machineCleanup)
        return Effect.sync(() => socket.send("replacement-active"))
      },
      disconnected: (socket) =>
        Effect.sync(() => {
          disconnected.push(socket)
        }).pipe(Effect.tap(() => (socket === oldSocket ? Deferred.succeed(oldDisconnected, undefined) : Effect.void))),
      active: () => Effect.succeed(true),
      execute: () => Effect.die("unused"),
      cancel: () => Effect.void,
      machine: () => Effect.die("unused"),
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
    yield* original.send('{"_tag":"BindingInvoke"}')
    yield* original.send('{"_tag":"MachineResult"}')
    yield* Deferred.await(bindingStarted)
    yield* Deferred.await(machineStarted)
    yield* original.close
    yield* Deferred.await(bindingCleanup)
    yield* Deferred.await(machineCleanup)

    const replacement = yield* connect(url)
    yield* replacement.send('{"_tag":"CurrentSession"}')
    expect(yield* Deferred.await(replacement.firstMessage)).toBe("replacement-active")
    expect((yield* Deferred.poll(oldDisconnected))._tag).toBe("None")
    expect(replacement.messages).toEqual(["replacement-active"])

    yield* Deferred.succeed(releaseCleanup, undefined)
    yield* Deferred.await(oldDisconnected)
    expect(resumedOldReceive).toBe(false)
    expect(disconnected).toEqual([oldSocket])
    expect(replacement.messages).toEqual(["replacement-active"])

    yield* replacement.close
    yield* Scope.close(resourceScope, Exit.void)
  })

it.effect("owns executor reverse receives by their originating WebSocket session", () =>
  verifiesSessionReplacement("executors"),
)

it.effect("owns Runner reverse receives by their originating WebSocket session", () =>
  verifiesSessionReplacement("runners"),
)

it.effect("interrupts reverse-channel receives before Bun server shutdown closes their sockets", () =>
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
      cancel: () => Effect.void,
      machine: () => Effect.die("unused"),
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
    yield* connected.send('{"_tag":"BindingInvoke"}')
    yield* Deferred.await(terminalized)

    const closing = yield* Scope.close(resourceScope, Exit.void).pipe(
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.forkChild,
    )
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
        if (current === "BindingInvoke") return receive(reverseStarted, reverseCleanup)
        if (current === "Serialized") return receive(serialStarted, serialCleanup)
        return Effect.sync(() => {
          queuedSerialStarted = true
        })
      },
      disconnected: () => Effect.void,
      active: () => Effect.succeed(true),
      execute: () => Effect.die("unused"),
      cancel: () => Effect.void,
      machine: () => Effect.die("unused"),
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
    yield* connected.send('{"_tag":"BindingInvoke"}')
    const request = yield* Effect.tryPromise(() => Bun.fetch(`${baseUrl}/readyz`)).pipe(Effect.forkChild)
    yield* Deferred.await(serialStarted)
    yield* Deferred.await(reverseStarted)
    yield* Deferred.await(httpStarted)

    const closing = yield* Scope.close(resourceScope, Exit.void).pipe(
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.forkChild,
    )
    yield* Deferred.await(serialCleanup)
    yield* Deferred.await(reverseCleanup)
    const lateUpgrade = yield* Effect.exit(connect(`${baseUrl.replace("http", "ws")}/api/v1/executors`))
    expect(lateUpgrade._tag).toBe("Failure")
    expect((yield* Deferred.poll(closed))._tag).toBe("None")
    expect(queuedSerialStarted).toBe(false)

    yield* TestClock.adjust("5 seconds")
    yield* Deferred.await(closed)
    expect(receiveResumed).toBe(false)
    expect(queuedSerialStarted).toBe(false)

    yield* Deferred.succeed(releaseCleanup, undefined)
    yield* Deferred.succeed(releaseHttp, undefined)
    yield* Fiber.await(request)
    yield* Fiber.join(closing)
  }),
)
