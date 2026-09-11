import * as BunServices from "@effect/platform-bun/BunServices"
import { it } from "@effect/vitest"
import { Crypto, Effect, Fiber, FileSystem, Layer, Redacted, Ref, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { expect } from "vitest"
import * as DurabilityTesting from "generalist/testing/durability"
import { BoxId } from "@rika/box-executor"
import { WorkspaceBinding, workspaceExecutorWebSocketProtocol } from "@rika/execution"
import { runBoxExecutor } from "@rika/runner/box/daemon"
import { makeNativeOperationIntent } from "@rika/runner/workspace"
import { makeBoxGateway } from "../../src/executor/box-enrollment"
import { threadPartition, type ThreadExecutionBinding } from "../../src/runtime/partition"
import { serveApiV2LocalHost } from "../../src/transport/local-host"
import { reservePort, RivetEngine, rivetEngineLayer } from "../fixtures/rivet-engine"
import { testWebSocketConstructor } from "../fixtures/runner-socket"

const boxId = Schema.decodeSync(BoxId)("bx_23456789")
const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "box-workspace",
  assignmentId: "box-assignment",
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "box-workspace", lineageId: "box-lineage" },
  buildId: "test-build",
  protocolVersion: 1,
})

const unused = () => Effect.die("Box-only transport acceptance must not construct a Runtime or model")

it.live(
  "serves ticket-authenticated Box native execution through the API's separate upgrade route",
  () =>
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(
        Effect.flatMap((platform) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "rika-box-api-" })
            const engine = yield* RivetEngine.pipe(Effect.provide(yield* Layer.build(rivetEngineLayer)))
            const port = yield* Effect.scoped(reservePort)
            const origin = `http://127.0.0.1:${port}`
            const publicOrigin = "https://rika-box-proxy.example.test"
            const partition = threadPartition({ environment: "test", ownerId: "owner", threadId: "box", target: "orb" })
            const current = yield* Ref.make<ThreadExecutionBinding | undefined>({
              partition,
              placement: binding.placement,
              workspaceBinding: binding,
            })
            const box = yield* makeBoxGateway({
              publicUrl: publicOrigin,
              crypto: yield* Crypto.Crypto,
              current: (id) => (id === boxId ? Ref.get(current) : Effect.as(Effect.void, undefined)),
            })
            const bucket = yield* DurabilityTesting.make()
            const host = yield* Effect.acquireRelease(
              serveApiV2LocalHost({
                hostname: "127.0.0.1",
                port,
                publicUrl: publicOrigin,
                environment: "test",
                revision: "box-route-test",
                boxGateway: box.gateway,
                authority: {
                  authenticateBearer: () => Effect.as(Effect.void, undefined),
                  threadBinding: () => Effect.as(Effect.void, undefined),
                  resourceThread: () => Effect.as(Effect.void, undefined),
                  authorize: () => Effect.succeed(false),
                },
                storage: Layer.merge(DurabilityTesting.layer(bucket), BunServices.layer),
                workspace: unused,
                context: unused,
                rivetEndpoint: engine.endpoint,
                registry: {
                  ...engine,
                  runtime: "native",
                  startEngine: false,
                  startServices: false,
                  noWelcome: true,
                },
              }),
              (server) => Effect.tryPromise(() => server.close()).pipe(Effect.orDie),
            )
            expect(host.url).toBe(origin)
            const http = yield* HttpClient.HttpClient.pipe(Effect.provide(yield* Layer.build(FetchHttpClient.layer)))
            const denied = yield* http.get(`${origin}/api/v2/boxes/${boxId}/executor`, {
              headers: {
                upgrade: "websocket",
                "sec-websocket-protocol": workspaceExecutorWebSocketProtocol,
                authorization: "DPoP unrelated-user-credential",
                dpop: "unrelated-proof",
              },
            })
            expect(denied.status).toBe(401)
            expect(yield* box.enrollment.ready(boxId, binding)).toBeUndefined()
            const grant = yield* box.enrollment.issue(boxId, binding)
            const daemon = yield* runBoxExecutor({
              bootstrap: {
                version: 1,
                boxId,
                binding,
                workspacePath: checkout,
                enrollment: { ...grant, ticket: Redacted.value(grant.ticket) },
              },
              expected: { buildId: "test-build", protocolVersion: 1 },
              connect: (url, protocol, headers) =>
                testWebSocketConstructor(headers.authorization ?? "")(
                  `${origin.replace("http:", "ws:")}${new URL(url).pathname}`,
                  [protocol],
                ),
            }).pipe(Effect.result, Effect.forkScoped)
            const handshake = yield* box.enrollment
              .ready(boxId, binding)
              .pipe(
                Effect.repeat({ until: (value) => value !== undefined, schedule: Schedule.spaced("10 millis") }),
                Effect.timeout("5 seconds"),
              )
            expect(handshake).toEqual(binding)
            const workspace = box.gateway.executor(binding)
            const evidence = yield* workspace.handshake({ binding })
            const input = { command: "printf box-native > result.txt" }
            const intent = makeNativeOperationIntent({ binding, operationId: "box-native-write", tool: "bash", input })
            yield* workspace.dispatch(intent, input, evidence)
            const receipt = yield* workspace.receipt(intent.operationId).pipe(
              Effect.repeat({
                until: (value) => value?.outcome._tag === "Completed",
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("5 seconds"),
            )
            expect(receipt).toMatchObject({ operationId: intent.operationId, binding })
            expect(yield* fs.readFileString(`${checkout}/result.txt`)).toBe("box-native")
            yield* Ref.set(current, undefined)
            expect(yield* Effect.result(box.enrollment.ready(boxId, binding))).toMatchObject({ _tag: "Failure" })
            expect(yield* Fiber.join(daemon).pipe(Effect.timeout("7 seconds"))).toMatchObject({
              _tag: "Failure",
              failure: { phase: "reconnect" },
            })
          }).pipe(Effect.provide(platform)),
        ),
      ),
    ),
  30_000,
)
