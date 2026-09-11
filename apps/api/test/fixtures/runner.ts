import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer } from "effect"
import { makeGeneralistClientLayer } from "@rika/client/generalist"
import { makeFetchTransport, makeProductClient } from "@rika/client/product"
import { WorkspaceExecutor } from "@rika/execution"
import { makeRunnerClient } from "@rika/client/runner"
import { makeContextMaterializer } from "@rika/context"
import { remoteWorkspaceReader } from "@rika/context/remote"
import { connectRunnerWebSocket } from "@rika/runner/transport"
import { localWorkspaceExecutorLayer } from "@rika/runner/workspace"
import { TestModel } from "generalist/testing"
import * as DurabilityTesting from "generalist/testing/durability"
import { serveApiV2LocalHost } from "../../src/transport/local-host"
import { threadPartition, type ThreadExecutionBinding } from "../../src/runtime/partition"
import { ProductAuthorizationError, type ProductAuthorityService } from "../../src/product/authority"
import type { PrepareSessionContext } from "../../src/runtime/preparation"
import { threadContext, workspaceBinding } from "./context"
import { reservePort, RivetEngine, rivetEngineLayer } from "./rivet-engine"
import { makeRunnerGateway } from "../../src/executor/runner-gateway"
import { runnerIdentityFixture } from "./runner-identity"
import { testWebSocketConstructor } from "./runner-socket"

export const runnerFixture = Effect.gen(function* () {
  const platform = yield* Layer.build(BunServices.layer)
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "rika-hosted-runner-" })
    const local = yield* WorkspaceExecutor.pipe(
      Effect.provide(yield* Layer.build(localWorkspaceExecutorLayer({ checkout, binding: workspaceBinding }))),
    )
    const runnerIdentity = yield* runnerIdentityFixture
    const runnerGateway = yield* makeRunnerGateway(runnerIdentity.options)
    const executor = runnerGateway.executor(workspaceBinding)
    const engine = yield* RivetEngine.pipe(Effect.provide(yield* Layer.build(rivetEngineLayer)))
    const port = yield* Effect.scoped(reservePort)
    const partition = threadPartition({
      environment: "test",
      ownerId: "owner",
      threadId: "hosted-runner",
      target: "runner",
    })
    const binding: ThreadExecutionBinding = { partition, placement: workspaceBinding.placement, workspaceBinding }
    const revoked = new Set<string>()
    const authority: ProductAuthorityService = {
      authenticateBearer: (token) =>
        Effect.succeed(
          (token === "controller" || token === "spectator") && !revoked.has(token)
            ? { id: token, tenantId: "owner", role: token }
            : undefined,
        ),
      threadBinding: () => Effect.succeed(binding),
      resourceThread: () => Effect.succeed(partition.threadId),
      authorize: ({ principal, action }) =>
        Effect.succeed(!revoked.has(principal.id) && (principal.role === "controller" || action !== "mutate")),
    }
    const fixture = yield* TestModel.make(
      [0, 1].flatMap((turn) => [
        TestModel.turn([
          TestModel.toolCall("bash", { command: "printf hosted-runner > result.txt" }, { id: `native-bash-${turn}` }),
        ]),
        TestModel.turn([TestModel.text("done")]),
      ]),
    )
    const bucket = yield* DurabilityTesting.make()
    const storage = Layer.merge(DurabilityTesting.layer(bucket), BunServices.layer)
    const start = () =>
      serveApiV2LocalHost({
        authority,
        environment: "test",
        storage,
        revision: "hosted-runner-test",
        workspace: () => Effect.succeed(executor),
        context: () =>
          Effect.gen(function* () {
            const captured = yield* threadContext(workspaceBinding, partition.rootSessionId, fixture.layer)
            const materialization = yield* makeContextMaterializer({
              readGuidance: () => Effect.succeed([]),
              listSkills: () => Effect.succeed([]),
            }).discover({
              binding: workspaceBinding,
              sessionId: partition.rootSessionId,
              guidanceScope: captured.materialization.guidanceScope,
              capturedAt: "2026-09-09T12:00:00.000Z",
              model: captured.materialization.model,
              tools: captured.materialization.tools,
            })
            const reader = makeContextMaterializer(
              remoteWorkspaceReader({ binding: workspaceBinding, workspace: executor }),
            )
            return {
              ...captured,
              materialization,
              prepare: (input: Parameters<PrepareSessionContext>[0]) =>
                reader.discover({
                  binding: workspaceBinding,
                  sessionId: partition.rootSessionId,
                  guidanceScope: materialization.guidanceScope,
                  capturedAt: input.admittedAt,
                  model: materialization.model,
                  tools: materialization.tools,
                }),
            }
          }).pipe(
            Effect.mapError((error) => ProductAuthorizationError.make({ kind: "invalid", message: error.message })),
          ),
        registry: {
          ...engine,
          runtime: "native",
          startEngine: false,
          noWelcome: true,
          envoy: { poolName: `rika-hosted-${port}` },
        },
        rivetEndpoint: engine.endpoint,
        port,
        runnerGateway,
      })
    let host = yield* start()
    yield* Effect.addFinalizer(() => Effect.tryPromise(() => host.close()).pipe(Effect.orDie))
    yield* Effect.tryPromise(() => host.registry.startAndWait())
    const connect = () =>
      Effect.gen(function* () {
        const runnerClient = makeRunnerClient({
          baseUrl: host.url,
          transport: makeFetchTransport(globalThis.fetch),
          requestHeaders: () => Effect.succeed({ authorization: "DPoP fixture-runner", dpop: "fixture-proof" }),
        })
        const enrollment = yield* runnerClient.enrollmentRequest(partition.threadId)
        return yield* connectRunnerWebSocket({
          workspace: local,
          connect: () =>
            testWebSocketConstructor(enrollment.headers.authorization ?? "", enrollment.headers.dpop)(enrollment.url, [
              ...enrollment.protocols,
            ]),
        }).pipe(Effect.tap((connection) => connection.ready))
      })
    const runnerConnection = yield* connect()
    const restart = Effect.gen(function* () {
      yield* Effect.tryPromise(() => host.close())
      host = yield* start()
      yield* Effect.tryPromise(() => host.registry.startAndWait())
      yield* connect()
    })
    const product = makeProductClient({
      baseUrl: host.url,
      transport: makeFetchTransport(globalThis.fetch),
      requestHeaders: () => Effect.succeed({ authorization: "Bearer controller" }),
    })
    const session = yield* product.ensureSession(partition.threadId, "ensure-hosted-session")
    const clientFor = (principal: "controller" | "spectator") =>
      makeGeneralistClientLayer({
        baseUrl: `${host.url}/api/v2/threads/${partition.threadId}/runtime`,
        auth: { requestHeaders: () => Effect.succeed({ authorization: `Bearer ${principal}` }) },
      })
    const client = yield* clientFor("controller")
    return {
      client,
      clientFor,
      session,
      partition,
      fs,
      checkout,
      fixture,
      revoked,
      restart,
      runnerIdentity,
      runnerConnection,
      runnerGateway,
      host,
    }
  }).pipe(Effect.provide(platform))
}).pipe(Effect.orDie)
