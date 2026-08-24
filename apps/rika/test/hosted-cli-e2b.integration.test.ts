import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import type { Account, CliDeviceDirectory, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import * as HostedPostgres from "@rika/product-store/postgres-layer"
import { ApiMessage, ExecutorMessage, type CellResponse } from "@rika/remote-execution/protocol"
import { Config, Context, Effect, FileSystem, Layer, Option, Random, Redacted, Ref, Schema } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { runMigration } from "../../../packages/identity/src/postgres"
import { identityMigrations } from "../../../packages/identity/src/migrations"
import { migrations as productMigrations } from "../../../packages/product-store/src/hosted/migrations"
import * as ExecutionPostgres from "../../../packages/execution/src/postgres"
import { layer as controllerLayer } from "../../../packages/e2b-executor/src/controller"
import { Credentials, CredentialError } from "../../../packages/e2b-executor/src/checkout"
import { ObjectStore, memoryObjectStore, vaultLayer } from "../../../packages/e2b-executor/src/checkpoint"
import { Provider, type BootstrapRequest, type CreateRequest } from "../../../packages/e2b-executor/src/provider"
import { type Gateway, type Socket } from "../../api/src/executor-gateway"
import { Executor, service as executorService } from "../../api/src/executor"
import { HostedEnvironment, layer as hostedEnvironmentLayer } from "../../api/src/hosted-environment"
import { HostedProduct, layer as hostedProductLayer } from "../../api/src/hosted-product"
import { testLayer as hostedModelRegistryTestLayer } from "../../api/src/hosted-model-registry"
import { testLayer as hostedRepositoriesTestLayer } from "../../api/src/hosted-repositories"
import { layer as runnerExecutorLayer } from "../../api/src/runner-executor"
import { HostedToolPolicy, layer as hostedToolPolicyLayer } from "../../api/src/hosted-tool-policy"
import { makeRikaApiHandler } from "../../api/src/api"
import type { HttpDependencies } from "../../api/src/http"
import * as HostedCommand from "../src/command/root/hosted-command-dispatch"
import { run } from "../src/command/root/rika-command"
import * as HostedCli from "../src/hosted/hosted-cli"
import * as HostedHttp from "../src/hosted/hosted-http"
import {
  Browser,
  CredentialStore,
  HostedError,
  Http,
  ProfileStore,
  ThreadClient,
  type Credential,
  type PrivateJwk,
} from "../src/hosted/hosted-contract"
import { generate } from "../src/hosted/hosted-dpop"
import { Service as ProductService } from "@rika/product/product-operation-service"
import { BetterAuthUserId, OrganizationId } from "@rika/product/hosted-model"

const databaseUrl = Effect.runSync(Config.option(Config.string("RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL"))).pipe(
  Option.getOrUndefined,
)
const live = databaseUrl !== undefined
const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const workspaceCapabilities = {
  environmentDigest: `sha256:${"1".repeat(64)}`,
  capturedAt: "2026-01-01T00:00:00.000Z",
  filesystem: { _tag: "Ready", detail: "available" },
  typescriptKernel: { _tag: "Ready", detail: "available" },
  git: { _tag: "Ready", detail: "available" },
  process: { _tag: "Ready", detail: "available" },
  pty: { _tag: "Unavailable", reason: "not required" },
  browser: { _tag: "Unavailable", reason: "not required" },
  services: { _tag: "Ready", detail: "available" },
  workspaceLifecycle: { _tag: "Ready", detail: "available" },
} as const
const deviceId = "device-cli-e2b"
const clientId = "client-cli-e2b"
const workspaceEncryptionKey = Redacted.make(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))

const account: Account = {
  user: {
    id: "user-cli-e2b",
    name: "Rika User",
    email: "rika@example.test",
    emailVerified: true,
    image: null,
  },
  memberships: [],
}

const migrate = (url: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* fileSystem.readFileString(fileURLToPath(migration.url))
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    yield* ExecutionPostgres.applySchema({ url, source: "rika-cli-e2b-integration" })
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* fileSystem.readFileString(fileURLToPath(migration.url))
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(false)
    }
    yield* ExecutionPostgres.applySchema({ url, source: "rika-cli-e2b-integration" })
    return pool
  })

const webRequest = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body._tag === "Uint8Array" ? request.body.body : undefined
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
  })
}

const unusedHttpClient = HttpClient.make(() => Effect.die("The integration test did not install its HTTP client"))

it.layer(BunServices.layer)((test) => {
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
          yield* Effect.tryPromise(() =>
            migrated!.query(
              `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
            VALUES ($1, 'Rika User', 'rika@example.test', true, now(), now())`,
              [account.user.id],
            ),
          )
          yield* Effect.tryPromise(() =>
            migrated!.query(
              `WITH inserted_organization AS (
                INSERT INTO "organization" (id, name, slug, created_at)
                VALUES ('organization-cli-e2b', 'Rika Organization', 'rika-organization', now())
                RETURNING id
              ), inserted_member AS (
                INSERT INTO "member" (id, organization_id, user_id, role, created_at)
                SELECT 'member-cli-e2b', id, $1, 'owner', now() FROM inserted_organization
                RETURNING organization_id
              )
              INSERT INTO rika_hosted_owners (id, kind, organization_id)
              SELECT 'organization-owner-cli-e2b', 'organization', organization_id FROM inserted_member`,
              [account.user.id],
            ),
          )
          let gateway: Gateway | undefined
          const runFork = Effect.runForkWith(yield* Effect.context<never>())
          let helloAccepted = 0
          const creates: Array<CreateRequest> = []
          const bootstraps: Array<BootstrapRequest> = []
          const operations: Array<Extract<ApiMessage, { readonly _tag: "CellExecute" }>> = []
          const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
          const response: CellResponse = {
            _tag: "Success",
            result: { exitCode: 0, stdout: "hosted-mvp\n", stderr: "" },
          }
          const socket: Socket = {
            send: (frame) => {
              const message = Schema.decodeUnknownSync(Schema.fromJsonString(ApiMessage))(frame)
              if (message._tag === "ExecutorWelcome") helloAccepted += 1
              if (message._tag === "CellExecute") {
                operations.push(message)
                runFork(
                  gateway!.receive(
                    socket,
                    encodeExecutorMessage({
                      _tag: "CellResult",
                      access: message.request.access,
                      operationKey: message.request.operationKey,
                      attempt: message.request.attempt,
                      response,
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
                    gateway!.receive(
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
                          capabilities: { cells: true, checkpoints: false, pty: false },
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
                  Layer.provide(BunServices.layer),
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
          const databaseLayer = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
          const shared = Layer.mergeAll(
            databaseLayer,
            AuthorizationPolicy.layer,
            BunCrypto.layer,
            hostedModelRegistryTestLayer,
            hostedRepositoriesTestLayer,
          )
          const executionReadinessCheck = Effect.succeed({
            backend: "postgres" as const,
            source: "rika-cli-e2e-integration",
            workerId: "rika-cli-e2e-integration",
          })
          const productLayer = hostedProductLayer({
            templateBuildId: "template-build-v1-immutable",
            providerScope: "integration-test",
            promptAdmissionReadiness: executionReadinessCheck.pipe(Effect.as(true)),
            provision: () => Effect.void,
          }).pipe(Layer.provide(shared))
          const environmentLayer = hostedEnvironmentLayer({
            encryptionKey: Redacted.make(Buffer.alloc(32, 1).toString("base64")),
            protectedEgressHosts: new Set([new URL(url).hostname]),
          }).pipe(Layer.provide(shared))
          const toolPolicyLayer = hostedToolPolicyLayer.pipe(Layer.provide(shared))
          const executorLayer = executorService.pipe(
            Layer.provide(controller),
            Layer.provide(environmentLayer),
            Layer.provide(toolPolicyLayer),
            Layer.provideMerge(runnerExecutorLayer.pipe(Layer.provide(shared))),
            Layer.provide(shared),
          )
          const context = yield* Layer.build(
            Layer.mergeAll(productLayer, executorLayer, toolPolicyLayer).pipe(Layer.provideMerge(shared)),
          )
          const product = Context.get(context, HostedProduct)
          const toolPolicy = Context.get(context, HostedToolPolicy)
          const executor = Context.get(context, Executor)
          gateway = executor.gateway
          const databaseTime = yield* Effect.tryPromise(() =>
            migrated!.query<{ readonly millis: string }>(
              "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS millis",
            ),
          )
          yield* TestClock.setTime(Number(databaseTime.rows[0]!.millis))
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
            migrated!.query<{ readonly name: string; readonly ownerKind: string }>(
              `SELECT environment.name, owner_record.kind AS "ownerKind"
              FROM rika_hosted_environment_values environment
              JOIN rika_hosted_owners owner_record ON owner_record.id = environment.owner_id
              WHERE environment.name IN ('PERSONAL_ONLY', 'ORGANIZATION_ONLY') ORDER BY environment.name`,
            ),
          )
          expect(environmentOwners.rows).toEqual([
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
            toolPolicy,
            threads: {
              issueTicket: () =>
                Effect.succeed({ ticket: "thread-ticket", expiresAt: "2026-08-21T07:00:00.000Z" as never }),
              connect: () => Effect.die("The test Thread client handles the canonical command boundary"),
            },
            recovery: {
              inspect: () => Effect.succeed([]),
              resolve: () => Effect.die("unused"),
            },
            executor,
            execution: {
              check: executionReadinessCheck,
              status: Effect.succeed({
                poll: { _tag: "Starting" as const },
                lastSuccessfulPollAt: undefined,
                lastFailure: undefined,
                active: 0,
                capacity: 1,
                oldestClaimAt: undefined,
                pollAgeMillis: undefined,
                lastSuccessfulPollAgeMillis: undefined,
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
                        privateJwk: privateJwk as PrivateJwk,
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
              ThreadClient,
              ThreadClient.of({
                create: () => Effect.die("unused"),
                submit: ({ threadId, request, commandId }) =>
                  product
                    .admitRun({
                      principal: { userId: account.user.id, deviceId, clientId, dpopJkt: "dpop-thumbprint" },
                      threadId,
                      operationKey: commandId,
                      prompt: request.prompt.join("\n"),
                      ...(request.mode === undefined ? {} : { mode: request.mode }),
                    })
                    .pipe(Effect.mapError((error) => HostedError.make({ kind: "protocol", message: error.message }))),
                ensureService: () => Effect.die("unused"),
                stopService: () => Effect.die("unused"),
                openPortal: () => Effect.die("unused"),
              }),
            ),
          )
          const hostedCommand = Layer.effect(
            HostedCommand.Service,
            Effect.context<
              Browser | CredentialStore | import("effect").Crypto.Crypto | Http | ProfileStore | ThreadClient
            >().pipe(
              Effect.map((services) =>
                HostedCommand.Service.of({ run: (input) => HostedCli.run(input).pipe(Effect.provide(services)) }),
              ),
            ),
          ).pipe(Layer.provide(hostedDependencies)) as Layer.Layer<typeof HostedCommand.Service>
          const cli = yield* Layer.build(
            Layer.mergeAll(
              BunServices.layer,
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
          const [thread, assignment, commands, events] = yield* Effect.all(
            [
              Effect.tryPromise(() =>
                migrated!.query(`SELECT executor_kind FROM rika_hosted_threads WHERE id = $1`, [connection.threadId]),
              ).pipe(Effect.orDie),
              Effect.tryPromise(() =>
                migrated!.query(`SELECT id, thread_id FROM rika_hosted_executor_assignments WHERE thread_id = $1`, [
                  connection.threadId,
                ]),
              ).pipe(Effect.orDie),
              Effect.tryPromise(() =>
                migrated!.query(`SELECT idempotency_key FROM rika_hosted_thread_commands WHERE thread_id = $1`, [
                  connection.threadId,
                ]),
              ).pipe(Effect.orDie),
              Effect.tryPromise(() =>
                migrated!.query(`SELECT event FROM rika_hosted_thread_events WHERE thread_id = $1`, [
                  connection.threadId,
                ]),
              ).pipe(Effect.orDie),
            ],
            { concurrency: "unbounded" },
          )
          expect(thread.rows).toEqual([{ executor_kind: "orb" }])
          expect(assignment.rows).toHaveLength(1)
          expect(assignment.rows[0]).toMatchObject({ thread_id: connection.threadId })
          expect(assignment.rows[0]?.id).not.toBe(connection.threadId)
          expect(helloAccepted).toBe(0)
          expect(closes).toEqual([])
          expect(commands.rows).toHaveLength(1)
          expect(operations).toHaveLength(0)
          expect(events.rows).toHaveLength(0)
          expect(creates).toHaveLength(0)
          expect(bootstraps).toHaveLength(0)
          expect(yield* Ref.get(localServerSpawns)).toBe(0)
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
