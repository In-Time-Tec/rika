import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as Socket from "effect/unstable/socket/Socket"
import type { IdentityConfig } from "@rika/identity"
import { protocolVersion, ServerFrame } from "@rika/product/client-protocol"
import { Timestamp } from "@rika/product/hosted-model"
import type { Interface as ControllerService } from "@rika/e2b-executor/controller"
import type { HttpDependencies } from "../../../src/server/http"
import { pollAuthority, sendThreadFrames, serveApi } from "../../../src/server/bun"
import { testToolPolicy } from "../../hosted/execution/tool-policy.fixture"

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

const recovery: HttpDependencies["recovery"] = {
  inspect: () => Effect.die("unused"),
  resolve: () => Effect.die("unused"),
  reconcileCompleted: Effect.die("unused"),
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

it.effect("closes inactive sessions with a policy violation on the authority schedule", () =>
  Effect.gen(function* () {
    let active = true
    const closed: Array<readonly [number | undefined, string | undefined]> = []
    const polling = yield* pollAuthority(
      new Set([
        {
          validate: () => Effect.sync(() => active),
          close: (code?: number, reason?: string) => closed.push([code, reason]),
        },
      ]),
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust("99 millis")
    expect(closed).toEqual([])
    active = false
    yield* TestClock.adjust("1 millis")
    expect(closed).toEqual([[1008, "authority revoked"]])
    yield* Fiber.interrupt(polling)
  }),
)

it.effect("closes a slow Thread consumer before buffering another frame", () =>
  Effect.gen(function* () {
    const sent: Array<string> = []
    const closed: Array<readonly [number | undefined, string | undefined]> = []
    const socket = {
      getBufferedAmount: () => 32 * 1024 * 1024,
      send: (message: string) => sent.push(message),
      close: (code?: number, reason?: string) => closed.push([code, reason]),
    }
    yield* sendThreadFrames(socket, [
      {
        protocolVersion,
        payload: { _tag: "Heartbeat", at: Timestamp.make("2026-08-21T00:00:00.000Z") },
      },
    ])
    expect(sent).toEqual([])
    expect(closed).toEqual([[1013, "slow Thread consumer"]])
  }),
)

it.effect("exchanges canonical Thread frames and finishes accepted commands after socket disconnect", () =>
  Effect.gen(function* () {
    let connected: ReadonlyArray<string> | undefined
    const received: Array<unknown> = []
    let receiveStartedAfterOutboundStopped = false
    const outboundStarted = yield* Deferred.make<void>()
    const outboundStopped = yield* Deferred.make<void>()
    const detachedReceiveEntered = yield* Deferred.make<void>()
    const releaseDetachedReceive = yield* Deferred.make<void>()
    const detachedReceiveCompleted = yield* Deferred.make<void>()
    let connectionCount = 0
    const dependencies: HttpDependencies = {
      identity: {
        handle: () => Effect.die("unused"),
        identify: () => Effect.die("unused"),
        protectedResourceMetadata: Effect.die("unused"),
      },
      directory: { ready: Effect.void, account: () => Effect.die("unused") },
      devices: {
        register: () => Effect.die("unused"),
        discard: () => Effect.die("unused"),
        authenticate: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        revoke: () => Effect.die("unused"),
        revokeAll: () => Effect.die("unused"),
      },
      product: {
        ready: Effect.void,
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
      },
      toolPolicy: testToolPolicy,
      threads: {
        issueTicket: () => Effect.die("unused"),
        connect: (ticket, audience) => {
          connected = [ticket, audience]
          connectionCount += 1
          if (connectionCount === 2)
            return Effect.succeed({
              receive: () =>
                Deferred.succeed(detachedReceiveEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDetachedReceive)),
                  Effect.andThen(Deferred.succeed(detachedReceiveCompleted, undefined)),
                  Effect.as([]),
                ),
              outbound: Effect.never,
              detach: Effect.void,
              active: Effect.succeed(true),
            })
          return Effect.succeed({
            receive: (message) =>
              Deferred.isDone(outboundStopped).pipe(
                Effect.tap((stopped) =>
                  Effect.sync(() => {
                    received.push(message)
                    receiveStartedAfterOutboundStopped = stopped
                  }),
                ),
                Effect.as([
                  {
                    protocolVersion,
                    payload: {
                      _tag: "Heartbeat" as const,
                      at: Timestamp.make("2026-08-21T00:00:00.000Z"),
                    },
                  },
                ]),
              ),
            outbound: Deferred.succeed(outboundStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(outboundStopped, undefined)),
            ),
            detach: Effect.void,
            active: Effect.succeed(true),
          })
        },
      },
      executor: {
        controller: unusedController,
        gateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          active: () => Effect.succeed(true),
          execute: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
          machine: () => Effect.die("unused"),
          workspace: () => Effect.die("unused"),
          sendPty: () => Effect.die("unused"),
          ptyEvents: () => Stream.empty,
          retryPreparation: () => Effect.void,
          quiesce: () => Effect.die("unused"),
          pushBranch: () => Effect.die("unused"),
        },
        runnerGateway: {
          receive: () => Effect.void,
          disconnected: () => Effect.void,
          active: () => Effect.succeed(true),
          execute: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
          machine: () => Effect.die("unused"),
        },
        admitRunner: () => Effect.die("unused"),
        admitRun: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        replace: () => Effect.die("unused"),
        ready: Effect.void,
      },
      recovery,
      execution: {
        check: Effect.succeed({
          backend: "postgres",
          source: "test",
          workerId: "test",
        }),
        status: Effect.die("unused"),
      },
      production: false,
    }
    const resourceScope = yield* Scope.make()
    const running = yield* serveApi({ config, dependencies }).pipe(Effect.provideService(Scope.Scope, resourceScope))
    const baseUrl = `http://127.0.0.1:${running.server.port}`
    const queryCredential = yield* Effect.tryPromise(() => Bun.fetch(`${baseUrl}/api/v1/threads/socket?ticket=secret`))
    expect(queryCredential.status).toBe(401)

    const reply = yield* Effect.scoped(
      Layer.build(Socket.layerWebSocketConstructorGlobal).pipe(
        Effect.flatMap((context) =>
          Effect.provide(
            Effect.gen(function* () {
              const socket = yield* Socket.makeWebSocket(`${baseUrl.replace("http:", "ws:")}/api/v1/threads/socket`, {
                protocols: ["rika.thread.v1", "rika.ticket.secret"],
              })
              const writer = yield* socket.writer
              const opened = yield* Deferred.make<void>()
              const response = yield* Deferred.make<string>()
              yield* socket
                .runString((message) => Deferred.succeed(response, message), {
                  onOpen: Deferred.succeed(opened, undefined),
                })
                .pipe(Effect.forkScoped)
              yield* Deferred.await(opened)
              yield* writer(
                `{"protocolVersion":${protocolVersion},"requestId":"request-1","command":{"_tag":"Detach"}}`,
              )
              yield* Deferred.await(outboundStarted)
              return yield* Deferred.await(response)
            }),
            context,
          ),
        ),
      ),
    )
    const detachedScope = yield* Scope.make()
    const detachedContext = yield* Layer.build(Socket.layerWebSocketConstructorGlobal).pipe(
      Effect.provideService(Scope.Scope, detachedScope),
    )
    yield* Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(`${baseUrl.replace("http:", "ws:")}/api/v1/threads/socket`, {
        protocols: ["rika.thread.v1", "rika.ticket.secret"],
      })
      const writer = yield* socket.writer
      const opened = yield* Deferred.make<void>()
      yield* Effect.forkIn(
        socket.runString(() => Effect.void, {
          onOpen: Deferred.succeed(opened, undefined),
        }),
        detachedScope,
      )
      yield* Deferred.await(opened)
      yield* writer(`{"protocolVersion":${protocolVersion},"requestId":"request-detached","command":{"_tag":"Detach"}}`)
    }).pipe(Effect.provide(detachedContext))
    yield* Deferred.await(detachedReceiveEntered)
    yield* Scope.close(detachedScope, Exit.void)
    yield* Deferred.succeed(releaseDetachedReceive, undefined)
    yield* Deferred.await(detachedReceiveCompleted)
    yield* Effect.tryPromise(() => running.server.stop(true))
    yield* Scope.close(resourceScope, Exit.void)
    expect(connected).toEqual(["secret", "/api/v1/threads/socket"])
    expect(received).toEqual([
      {
        protocolVersion,
        requestId: "request-1",
        command: { _tag: "Detach" },
      },
    ])
    expect(receiveStartedAfterOutboundStopped).toBe(true)
    expect(yield* Schema.decodeEffect(Schema.fromJsonString(ServerFrame))(reply)).toEqual({
      protocolVersion,
      payload: { _tag: "Heartbeat", at: "2026-08-21T00:00:00.000Z" },
    })
  }),
)
