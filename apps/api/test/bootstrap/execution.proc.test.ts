import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { makeGeneralistClientLayer } from "@rika/client/generalist"
import { makeFetchTransport, makeProductClient } from "@rika/client/product"
import { makeRunnerClient } from "@rika/client/runner"
import { WorkspaceBinding, WorkspaceExecutor } from "@rika/execution"
import { currentExecutorPolicy } from "@rika/product/executor-policy"
import type { CredentialRecord } from "@rika/product-store/provider-credentials"
import * as Runner from "@rika/runner/transport"
import * as Workspace from "@rika/runner/workspace"
import { Crypto, Effect, FileSystem, Inspectable, Layer, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as DurabilityTesting from "generalist/testing/durability"
import * as Execution from "../../src/bootstrap/execution"
import { loadExecutionConfig } from "../../src/bootstrap/execution-config"
import * as Production from "../../src/bootstrap/production"
import * as LocalHost from "../../src/transport/local-host"
import { reservePort, RivetEngine, rivetEngineLayer } from "../fixtures/rivet-engine"
import { testWebSocketConstructor } from "../fixtures/runner-socket"
import { executionEnvironment } from "./execution.harness"
import { modelHttpFixture } from "./model-http.harness"
import { makeProductionHarness, productionConfig, runnerBinding } from "./production.harness"

const encryptedCredential = Effect.gen(function* () {
  const nonce = new Uint8Array(12).fill(1)
  const key = yield* Effect.tryPromise(() =>
    globalThis.crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt"]),
  )
  const sealed = new Uint8Array(
    yield* Effect.tryPromise(() =>
      globalThis.crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: new TextEncoder().encode("rika/provider-credential/v1/owner/openai"),
          tagLength: 128,
        },
        key,
        new TextEncoder().encode("test-only-model-key"),
      ),
    ),
  )
  return {
    credentialIdentity: "credential-model",
    ownerId: "owner",
    provider: "openai",
    status: "active",
    revision: "1",
    keyVersion: 1,
    nonce,
    ciphertext: sealed.slice(0, -16),
    authenticationTag: sealed.slice(-16),
  } satisfies CredentialRecord
})

it.live(
  "uses the production context and encrypted credential to stream HTTP model calls and execute on the assigned Runner",
  () =>
    Effect.scoped(
      Layer.build(BunServices.layer).pipe(
        Effect.flatMap((platform) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "rika-production-execution-" })
            const guidance = "Guidance from the assigned production-composition workspace."
            yield* fs.writeFileString(`${checkout}/AGENTS.md`, guidance)
            const model = yield* modelHttpFixture
            const engine = yield* RivetEngine.pipe(Effect.provide(yield* Layer.build(rivetEngineLayer)))
            const port = yield* Effect.scoped(reservePort)
            const url = `http://127.0.0.1:${port}`
            const harness = makeProductionHarness()
            let credential: CredentialRecord = yield* encryptedCredential
            const services: Production.ApiV2ProductionServices = {
              ...harness.services,
              crypto: yield* Crypto.Crypto,
              product: {
                ...harness.services.product,
                threadExecutionContext: (ownerId, threadId) =>
                  harness.services.product.threadExecutionContext(ownerId, threadId).pipe(
                    Effect.map((row) =>
                      row === undefined
                        ? undefined
                        : {
                            ...row,
                            placement: {
                              _tag: "RunnerPlacement",
                              deviceId: "device",
                              requestingDeviceId: "device",
                              checkoutFingerprint: "checkout",
                              executorPolicy: currentExecutorPolicy,
                            },
                          },
                    ),
                  ),
              },
              providerCredentials: {
                ...harness.services.providerCredentials,
                credentialByOwner: () => Effect.sync(() => credential),
                credentialByIdentity: () => Effect.sync(() => credential),
              },
            }
            const config = {
              ...productionConfig,
              identity: { ...productionConfig.identity, baseUrl: url },
              rivet: { endpoint: engine.endpoint, namespace: "default" },
              port,
            }
            const execution = yield* loadExecutionConfig(executionEnvironment, false)
            const dependencies = yield* Execution.makeExecutionDependencies({ config, execution })(services).pipe(
              Effect.provideService(FetchHttpClient.Fetch, model.fetch),
            )
            const bucket = yield* DurabilityTesting.make()
            const composition = yield* Production.makeApiV2ProductionComposition(
              config,
              dependencies,
              services,
              Layer.merge(DurabilityTesting.layer(bucket), BunServices.layer),
            )
            const host = yield* Effect.acquireRelease(
              LocalHost.serveApiV2LocalHost({
                ...composition.options,
                rivetEndpoint: engine.endpoint,
                registry: {
                  ...engine,
                  runtime: "native",
                  startEngine: false,
                  noWelcome: true,
                  envoy: { poolName: `rika-production-${port}` },
                },
              }),
              (server) => Effect.tryPromise(() => server.close()).pipe(Effect.orDie),
            )
            yield* Effect.tryPromise(() => host.registry.startAndWait())
            const binding = yield* Schema.decodeEffect(WorkspaceBinding)({
              ...runnerBinding.workspaceBinding,
              ...currentExecutorPolicy,
            })
            const local = yield* WorkspaceExecutor.pipe(
              Effect.provide(yield* Layer.build(Workspace.localWorkspaceExecutorLayer({ checkout, binding }))),
            )
            const runner = makeRunnerClient({
              baseUrl: host.url,
              transport: makeFetchTransport(globalThis.fetch),
              requestHeaders: () => Effect.succeed({ authorization: "DPoP runner-access", dpop: "runner-proof" }),
            })
            const enrollment = yield* runner.enrollmentRequest(runnerBinding.partition.threadId)
            const connection = yield* Runner.connectRunnerWebSocket({
              workspace: local,
              connect: () =>
                testWebSocketConstructor(enrollment.headers.authorization ?? "", enrollment.headers.dpop)(
                  enrollment.url,
                  [...enrollment.protocols],
                ),
            })
            yield* connection.ready
            const product = makeProductClient({
              baseUrl: host.url,
              transport: makeFetchTransport(globalThis.fetch),
              requestHeaders: () => Effect.succeed({ authorization: "Bearer controller" }),
            })
            const session = yield* product.ensureSession(runnerBinding.partition.threadId, "ensure-production")
            expect(model.requests).toEqual([])
            expect(yield* fs.exists(`${checkout}/production-result.txt`)).toBe(false)
            const client = yield* makeGeneralistClientLayer({
              baseUrl: `${host.url}/api/v2/threads/${runnerBinding.partition.threadId}/runtime`,
              auth: { requestHeaders: () => Effect.succeed({ authorization: "Bearer controller" }) },
            })
            yield* client.sessions.submit({
              sessionId: session.sessionId,
              commandId: "production-input",
              input: "Create the workspace file",
            })
            const snapshot = yield* client.sessions.snapshot({ sessionId: session.sessionId }).pipe(
              Effect.repeat({
                until: (value) =>
                  value.runs.some((run) => run.status === "failed") ||
                  (value.runs.length > 0 && value.runs.every((run) => run.status === "succeeded")),
                schedule: Schedule.spaced("50 millis"),
              }),
              Effect.timeout("20 seconds"),
            )
            for (const run of snapshot.runs.filter((entry) => entry.status !== "succeeded")) {
              const inspection = yield* client.runs.inspect({ runId: run.runId })
              const events = yield* client.events.subscribe({ sessionId: session.sessionId }).pipe(
                Stream.takeUntil((event) => event._tag === "Completed" && event.runId === run.runId),
                Stream.runCollect,
                Effect.timeout("5 seconds"),
              )
              expect(inspection.status, Inspectable.toStringUnknown(events)).toBe("succeeded")
            }
            expect(yield* fs.readFileString(`${checkout}/production-result.txt`)).toBe("production-native")
            expect(model.requests).toHaveLength(2)
            for (const request of model.requests) {
              expect(request).toContain(guidance)
              expect(request).not.toContain("test-only-model-key")
              expect(request).not.toContain(executionEnvironment.BOX_API_KEY)
            }
            const context = yield* dependencies.context({
              partition: runnerBinding.partition,
              binding: { ...runnerBinding, workspaceBinding: binding },
              workspace: composition.runnerGateway.executor(binding),
              rebindWorkspace: () => Effect.die("Runner must not rotate during credential revocation"),
            })
            credential = {
              ...credential,
              status: "revoked",
              revision: "2",
              nonce: null,
              ciphertext: null,
              authenticationTag: null,
              keyVersion: null,
            }
            expect(yield* context.authorization.current(session.sessionId)).toEqual({
              allowedTools: [],
              allowedModels: [],
              allowedCredentials: [],
            })
            expect(model.requests).toHaveLength(2)
            expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot)).not.toContain(
              "test-only-model-key",
            )
          }).pipe(Effect.provide(platform)),
        ),
      ),
    ),
  60_000,
)
