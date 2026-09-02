import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { expect, it } from "@effect/vitest"
import type { CliDeviceDirectory, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import { rikaHostedEnvironmentValues, rikaHostedOwners } from "@rika/product-store/database-schema"
import * as HostedStore from "@rika/product-store/layer"
import { ApiMessage, type MachineOutcome } from "@rika/remote-execution/protocol"
import { asc, eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Clock, Context, DateTime, Effect, Layer, Option, Random, Redacted, Ref, Schema } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Pool } from "pg"
import { layer as controllerLayer } from "../../../../packages/e2b-executor/src/controller"
import { Credentials, CredentialError } from "../../../../packages/e2b-executor/src/checkout"
import { ObjectStore, memoryObjectStore, vaultLayer } from "../../../../packages/e2b-executor/src/checkpoint"
import { Provider, type BootstrapRequest, type CreateRequest } from "../../../../packages/e2b-executor/src/provider"
import type { Socket } from "../../../api/src/executor/gateway"
import { Executor, service as executorService } from "../../../api/src/executor/service"
import { HostedEnvironment, layer as hostedEnvironmentLayer } from "../../../api/src/hosted/environment/runtime"
import { HostedProduct, layer as hostedProductLayer } from "../../../api/src/hosted/product"
import { testLayer as hostedModelRegistryTestLayer } from "../../../api/src/hosted/environment/model-registry"
import { unavailableLayer as hostedRepositoriesUnavailableLayer } from "../../../api/src/hosted/repositories"
import { layer as runnerExecutorLayer } from "../../../api/src/runner/executor"
import { makeRikaApiHandler } from "../../../api/src/api"
import type { HttpDependencies } from "../../../api/src/server/http"
import * as HostedCommand from "../../src/command/root/hosted"
import { run } from "../../src/command/root/rika"
import * as HostedCli from "../../src/hosted/cli"
import * as HostedHttp from "../../src/hosted/http"
import {
  Browser,
  CredentialStore,
  HostedError,
  Http,
  ProfileStore,
  ThreadClient,
  type Credential,
  PrivateJwk,
} from "../../src/hosted/contract"
import { generate } from "../../src/hosted/dpop"
import { Service as ProductService } from "@rika/product/product-operation-service"
import { BetterAuthUserId, OrganizationId, Timestamp } from "@rika/product/hosted-model"
import {
  account,
  bunLayer,
  clientId,
  databaseUrl,
  deviceId,
  encodeExecutorMessage,
  type GatewayRef,
  live,
  migrate,
  seedIdentity,
  unusedHttpClient,
  webRequest,
  verifyQueuedTurn,
  workspaceCapabilities,
  workspaceEncryptionKey,
} from "./cli.fixture"

it.layer(bunLayer)((test) => {
  test.effect.skipIf(!live)("queues a routed CLI turn durably without executing tools in the HTTP request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = `rika_cli_e2b_${Math.abs(yield* Random.nextInt)}`
        const admin = new Pool({ connectionString: databaseUrl })
        yield* Effect.tryPromise(() => admin.query(`CREATE DATABASE "${database}"`))
        const parsed = new URL(databaseUrl!)
        parsed.pathname = `/${database}`
        const url = parsed.toString()
        let migrated: Pool | undefined
        try {
          migrated = yield* migrate(url)
          const databaseClient = drizzle({ client: migrated })
          const createdAt = DateTime.toDate(DateTime.makeUnsafe(yield* TestClock.withLive(Clock.currentTimeMillis)))
          yield* seedIdentity(databaseClient, createdAt)
          yield* Effect.tryPromise(() =>
            databaseClient.insert(rikaHostedOwners).values({
              id: "organization-owner-cli-e2b",
              kind: "organization",
              organizationId: "organization-cli-e2b",
            }),
          )
          const gateway: GatewayRef = { current: undefined }
          const runFork = Effect.runForkWith(yield* Effect.context<never>())
          let helloAccepted = 0
          const creates: Array<CreateRequest> = []
          const bootstraps: Array<BootstrapRequest> = []
          const operations: Array<Extract<ApiMessage, { readonly _tag: "MachineExecute" }>> = []
          const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
          const outcome: MachineOutcome = {
            _tag: "Success",
            value: {
              _tag: "NativeTool",
              result: {
                text: "hosted-mvp\n",
                truncated: false,
                exitCode: 0,
                stdout: "hosted-mvp\n",
                stderr: "",
              },
            },
          }
          const socket: Socket = {
            send: (frame) => {
              const message = Schema.decodeSync(Schema.fromJsonString(ApiMessage))(frame)
              if (message._tag === "ExecutorWelcome") helloAccepted += 1
              if (message._tag === "MachineExecute") {
                operations.push(message)
                runFork(
                  gateway.current!.receive(
                    socket,
                    encodeExecutorMessage({
                      _tag: "MachineResult",
                      access: message.access,
                      operationKey: message.operationKey,
                      attempt: message.attempt,
                      machineId: message.machineId,
                      requestDigest: message.requestDigest,
                      outcome,
                    }),
                  ),
                )
              }
            },
            close: (code, reason) => closes.push({ code, reason }),
          }
          const provider = Layer.succeed(
            Provider,
            Provider.of({
              create: (request) => {
                creates.push(request)
                return Effect.succeed({ sandboxId: "fake-e2b-sandbox-1", state: "running" as const })
              },
              bootstrap: (request) =>
                Effect.sync(() => {
                  bootstraps.push(request)
                  runFork(
                    gateway.current!.receive(
                      socket,
                      encodeExecutorMessage({
                        _tag: "ExecutorHello",
                        lifecycle: request.identity.lifecycle,
                        environmentDigest: request.identity.environmentDigest,
                        hello: {
                          minimumVersion: 1,
                          maximumVersion: 1,
                          fence: {
                            target: "orb",
                            assignmentId: creates[0]!.assignmentId,
                            assignmentGeneration: creates[0]!.generation,
                            instanceId: request.sandboxId,
                            executorId: `${creates[0]!.assignmentId}:g${creates[0]!.generation}`,
                            processIncarnation: "fake-e2b-host-1",
                          },
                          templateBuildId: creates[0]!.templateBuildId,
                          capabilities: { nativeTools: true, checkpoints: false, pty: false },
                          workspaceCapabilities,
                          cursors: { command: 0, event: 0, pty: 0 },
                          latestCheckpointId: null,
                          bootstrapToken: Redacted.value(request.credential),
                        },
                      }),
                    ),
                  )
                }),
              connect: (sandboxId) => Effect.succeed({ sandboxId, state: "running" as const }),
              host: (sandboxId, port) => Effect.succeed(`${port}-${sandboxId}.e2b.app`),
              updateNetwork: () => Effect.void,
              pauseFilesystem: () => Effect.succeed(true),
              kill: () => Effect.succeed(true),
              touch: () => Effect.void,
              inventory: Effect.succeed([]),
            }),
          )
          const controller = controllerLayer({
            appId: "rika",
            deploymentId: "integration-test",
            templateId: "ar7-template-alias",
            templateBuildId: "template-build-v1-immutable",
            apiUrl: "wss://api.example.test/api/v1/executors",
            controlEgress: ["api.example.test"],
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                provider,
                BunCrypto.layer,
                vaultLayer(workspaceEncryptionKey).pipe(
                  Layer.provide(Layer.succeed(ObjectStore, memoryObjectStore())),
                  Layer.provide(bunLayer),
                ),
                Layer.succeed(
                  Credentials,
                  Credentials.of({
                    issue: () => Effect.fail(CredentialError.make({ message: "unused" })),
                    revoke: () => Effect.void,
                  }),
                ),
              ),
            ),
          )
          const databaseLayer = HostedStore.layer({ url: Redacted.make(url), maxConnections: 8 })
          const shared = Layer.mergeAll(
            databaseLayer,
            AuthorizationPolicy.layer,
            BunCrypto.layer,
            ExecutionGateway.layerTest(),
            hostedModelRegistryTestLayer,
            hostedRepositoriesUnavailableLayer,
          )
          const executionReadinessCheck = Effect.succeed({
            backend: "postgres" as const,
            source: "rika-cli-e2e-integration",
            workerId: "rika-cli-e2e-integration",
          })
          const productLayer = hostedProductLayer({
            orb: {
              templateBuildId: "template-build-v1-immutable",
              providerScope: "integration-test",
            },
            promptAdmissionReadiness: executionReadinessCheck.pipe(Effect.as(true)),
          }).pipe(Layer.provide(shared))
          const environmentLayer = hostedEnvironmentLayer({
            encryptionKey: Redacted.make(Buffer.alloc(32, 1).toString("base64")),
            protectedEgressHosts: new Set([new URL(url).hostname]),
          }).pipe(Layer.provide(shared))
          const executorLayer = executorService.pipe(
            Layer.provide(controller),
            Layer.provide(environmentLayer),
            Layer.provideMerge(runnerExecutorLayer.pipe(Layer.provide(shared))),
            Layer.provide(shared),
          )
          yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis))
          const context = yield* Layer.build(
            Layer.mergeAll(productLayer, executorLayer).pipe(Layer.provideMerge(shared)),
          )
          const product = Context.get(context, HostedProduct)
          const executor = Context.get(context, Executor)
          gateway.current = executor.gateway
          const connection = yield* product.createConnection({
            principal: { userId: account.user.id, deviceId, clientId, dpopJkt: "dpop-thumbprint" },
            owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make(account.user.id) },
            executorKind: "orb",
          })
          const environment = Context.get(yield* Layer.build(environmentLayer), HostedEnvironment)
          const environmentPrincipal = { userId: account.user.id, deviceId, clientId }
          yield* environment.put({
            principal: environmentPrincipal,
            owner: { _tag: "PersonalOwner", userId: BetterAuthUserId.make(account.user.id) },
            scope: "personal",
            name: "PERSONAL_ONLY",
            classification: "plain",
            phases: ["runtime"],
            value: Redacted.make("personal-value"),
          })
          yield* environment.put({
            principal: environmentPrincipal,
            owner: {
              _tag: "OrganizationOwner",
              organizationId: OrganizationId.make("organization-cli-e2b"),
            },
            scope: "organization",
            name: "ORGANIZATION_ONLY",
            classification: "plain",
            phases: ["runtime"],
            value: Redacted.make("organization-value"),
          })
          const environmentOwners = yield* Effect.tryPromise(() =>
            databaseClient
              .select({ name: rikaHostedEnvironmentValues.name, ownerKind: rikaHostedOwners.kind })
              .from(rikaHostedEnvironmentValues)
              .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedEnvironmentValues.ownerId))
              .where(inArray(rikaHostedEnvironmentValues.name, ["PERSONAL_ONLY", "ORGANIZATION_ONLY"]))
              .orderBy(asc(rikaHostedEnvironmentValues.name)),
          )
          expect(environmentOwners).toEqual([
            { name: "ORGANIZATION_ONLY", ownerKind: "organization" },
            { name: "PERSONAL_ONLY", ownerKind: "personal" },
          ])
          let credential: Credential | undefined
          const privateJwk = yield* generate()
          const dependencies: HttpDependencies = {
            identity: {
              handle: () => Effect.die("unused"),
              identify: () => Effect.succeed({ userId: account.user.id, clientId, dpopJkt: "dpop-thumbprint" }),
              protectedResourceMetadata: Effect.die("unused"),
            } satisfies IdentityRuntime,
            directory: {
              ready: Effect.void,
              account: () => Effect.succeed(account),
            } satisfies IdentityDirectory,
            devices: {
              register: () => Effect.void,
              discard: () => Effect.void,
              authenticate: () => Effect.succeed(deviceId),
              list: () => Effect.succeed([]),
              revoke: () => Effect.succeed(false),
              revokeAll: () => Effect.void,
            } satisfies CliDeviceDirectory,
            product,
            threads: {
              issueTicket: () =>
                Effect.succeed({
                  ticket: "thread-ticket",
                  expiresAt: Timestamp.make("2026-08-21T07:00:00.000Z"),
                }),
              connect: () => Effect.die("The test Thread client handles the canonical command boundary"),
            },
            recovery: {
              inspect: () => Effect.succeed({ runId: "unused", status: "running" as const }),
              resolve: () => Effect.die("unused"),
            },
            executor,
            execution: {
              check: executionReadinessCheck,
              status: Effect.succeed({
                scan: { _tag: "Starting" as const },
                wakeup: { _tag: "Starting" as const },
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
          const api = makeRikaApiHandler(dependencies)
          let ticketRequests = 0
          const client = HttpClient.make((request) =>
            Effect.suspend(() => {
              const pathname = new URL(request.url).pathname
              if (pathname === "/api/auth/oauth2/token")
                return Effect.succeed(
                  Response.json({
                    access_token: "access-token",
                    refresh_token: "refresh-token",
                    expires_in: 600,
                    token_type: "DPoP",
                  }),
                )
              if (pathname === "/api/v1/thread-sessions") ticketRequests += 1
              return Effect.tryPromise(() => api.handler(webRequest(request))).pipe(Effect.orDie)
            }).pipe(
              Effect.map((value) => HttpClientResponse.fromWeb(request, value)),
              Effect.orDie,
            ),
          )
          const localServerSpawns = yield* Ref.make(0)
          const hostedHttp = HostedHttp.layer.pipe(
            Layer.provide(Layer.merge(BunCrypto.layer, Layer.succeed(HttpClient.HttpClient, client))),
          )
          const hostedDependencies = Layer.mergeAll(
            hostedHttp,
            BunCrypto.layer,
            Layer.succeed(
              ProfileStore,
              ProfileStore.of({
                load: Effect.succeed(
                  Option.some({
                    origin: "https://api.example.test",
                    owner: { kind: "personal" },
                    deviceId,
                    clientId,
                  }),
                ),
                save: () => Effect.void,
              }),
            ),
            Layer.succeed(
              CredentialStore,
              CredentialStore.of({
                load: () =>
                  Effect.succeed(
                    Option.some(
                      credential ?? {
                        refreshToken: Redacted.make("refresh-token"),
                        privateJwk: Schema.decodeSync(PrivateJwk)(privateJwk),
                      },
                    ),
                  ),
                save: (_origin, _device, value) =>
                  Effect.sync(() => {
                    credential = value
                  }),
                remove: () => Effect.succeed(true),
                serialized: (effect) => effect,
              }),
            ),
            Layer.succeed(Browser, Browser.of({ open: () => Effect.void })),
            Layer.succeed(
              OpenAiAuth.Service,
              OpenAiAuth.Service.of({
                loginBrowser: () => Effect.die("unused"),
                loginDevice: Effect.die("unused"),
                status: Effect.die("unused"),
                logout: Effect.die("unused"),
                acquire: Effect.die("unused"),
                refreshRejected: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(
              ThreadClient,
              ThreadClient.of({
                create: () => Effect.die("unused"),
                submit: ({ threadId, request, commandId }) => {
                  const base = {
                    principal: { userId: account.user.id, deviceId, clientId, dpopJkt: "dpop-thumbprint" },
                    threadId,
                    operationKey: commandId,
                    prompt: request.prompt.join("\n"),
                  }
                  const input: Parameters<typeof product.admitRun>[0] =
                    request.mode === undefined ? base : { ...base, mode: request.mode }
                  return product.admitRun(input).pipe(
                    Effect.flatMap((result) =>
                      result._tag === "Admitted"
                        ? Effect.succeed(result)
                        : Effect.fail(HostedError.make({ kind: "protocol", message: "Prompt was cancelled" })),
                    ),
                    Effect.mapError((error) => HostedError.make({ kind: "protocol", message: error.message })),
                  )
                },
                ensureService: () => Effect.die("unused"),
                stopService: () => Effect.die("unused"),
                openPortal: () => Effect.die("unused"),
              }),
            ),
          )
          const hostedCommand = Layer.effect(
            HostedCommand.Service,
            Effect.context<
              | Browser
              | import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
              | CredentialStore
              | import("effect").Crypto.Crypto
              | import("effect").FileSystem.FileSystem
              | Http
              | OpenAiAuth.Service
              | ProfileStore
              | ThreadClient
            >().pipe(
              Effect.map((services) =>
                HostedCommand.Service.of({ run: (input) => HostedCli.run(input).pipe(Effect.provide(services)) }),
              ),
            ),
          ).pipe(Layer.provide(hostedDependencies), Layer.provide(bunLayer))
          const cli = yield* Layer.build(
            Layer.mergeAll(
              bunLayer,
              TestConsole.layer,
              hostedCommand,
              Layer.succeed(
                ProductService,
                ProductService.of({ run: () => Ref.update(localServerSpawns, (current) => current + 1) }),
              ),
            ),
          ).pipe(Effect.provideService(HttpClient.HttpClient, client))
          yield* run(["--execute", "echo hosted-mvp", "--thread", connection.threadId]).pipe(Effect.provide(cli))
          expect(ticketRequests).toBe(1)
          yield* verifyQueuedTurn(databaseClient, connection.threadId, {
            helloAccepted,
            closes,
            operations,
            creates,
            bootstraps,
            localServerSpawns,
          })
          yield* Effect.tryPromise(api.dispose)
        } finally {
          if (migrated !== undefined) {
            const pool = migrated
            yield* Effect.tryPromise(() => pool.end())
          }
          yield* Effect.tryPromise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
          yield* Effect.tryPromise(() => admin.end())
        }
      }),
    ).pipe(Effect.provideService(HttpClient.HttpClient, unusedHttpClient)),
  )
})
