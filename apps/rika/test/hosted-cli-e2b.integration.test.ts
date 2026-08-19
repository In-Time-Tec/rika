import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import type { Account, CliDeviceDirectory, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import * as HostedPostgres from "@rika/product-store/postgres-layer"
import { HostMessage, type CellResponse, type ControllerMessage } from "@rika/remote-execution/protocol"
import { Context, Effect, Layer, Option, Random, Redacted, Ref, Schema } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Pool } from "pg"
import { runMigration } from "../../../packages/identity/src/postgres"
import { identityMigrations } from "../../../packages/identity/src/migrations"
import { migrations as productMigrations } from "../../../packages/product-store/src/hosted/migrations"
import * as ExecutionPostgres from "../../../packages/execution/src/postgres"
import { layer as controllerLayer } from "../../../packages/e2b-executor/src/controller"
import { Credentials, CredentialError } from "../../../packages/e2b-executor/src/checkout"
import { Inspector, InspectionError } from "../../../packages/e2b-executor/src/checkpoint"
import { Provider, type BootstrapRequest, type CreateRequest } from "../../../packages/e2b-executor/src/provider"
import { type Gateway, type Socket } from "../../control-plane/src/executor-gateway"
import { Executor, service as executorService } from "../../control-plane/src/executor"
import { HostedProduct, layer as hostedProductLayer } from "../../control-plane/src/hosted-product"
import { makeControlPlaneApiHandler } from "../../control-plane/src/api"
import type { HttpDependencies } from "../../control-plane/src/http"
import * as HostedCommand from "../src/command/root/hosted-command-dispatch"
import { run } from "../src/command/root/rika-command"
import * as HostedCli from "../src/hosted/hosted-cli"
import * as HostedHttp from "../src/hosted/hosted-http"
import { Browser, CredentialStore, Http, ProfileStore, type Credential, type PrivateJwk } from "../src/hosted/hosted-contract"
import { generate } from "../src/hosted/hosted-dpop"
import { Service as ProductService } from "@rika/product/product-operation-service"

const databaseUrl = Bun.env.RIKA_HOSTED_POSTGRES_TEST_DATABASE_URL
const live = databaseUrl !== undefined
const encodeHostMessage = Schema.encodeSync(Schema.fromJsonString(HostMessage))
const organizationId = "organization-cli-e2b"
const memberId = "member-cli-e2b"
const deviceId = "device-cli-e2b"
const clientId = "client-cli-e2b"

const account: Account = {
  user: {
    id: "user-cli-e2b",
    name: "Rika User",
    email: "rika@example.test",
    emailVerified: true,
    image: null,
  },
  memberships: [
    {
      id: memberId,
      role: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      organization: { id: organizationId, name: "Rika", slug: "rika", logo: null },
    },
  ],
}

const migrate = (url: string) =>
  Effect.gen(function* () {
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    yield* ExecutionPostgres.applySchema({ url, source: "rika-cli-e2b-integration" })
    for (const migration of [...identityMigrations, ...productMigrations]) {
      const sql = yield* Effect.promise(() => Bun.file(migration.url).text())
      expect(yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })).toBe(false)
    }
    yield* ExecutionPostgres.applySchema({ url, source: "rika-cli-e2b-integration" })
    return pool
  })

const webRequest = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body._tag === "Uint8Array" ? request.body.body : undefined
  return new Request(request.url, { method: request.method, headers: request.headers, ...(body === undefined ? {} : { body }) })
}

const unusedHttpClient = HttpClient.make(() => Effect.die("The integration test did not install its HTTP client"))

it.effect.skipIf(!live)("drives the routed CLI through HTTP, PostgreSQL, and a fenced fake E2B executor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = `rika_cli_e2b_${Math.abs(yield* Random.nextInt)}`
      const admin = new Pool({ connectionString: databaseUrl })
      yield* Effect.promise(() => admin.query(`CREATE DATABASE "${database}"`))
      const parsed = new URL(databaseUrl!)
      parsed.pathname = `/${database}`
      const url = parsed.toString()
      let migrated: Pool | undefined
      try {
        migrated = yield* migrate(url)
        yield* Effect.promise(() =>
          migrated!.query(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
            VALUES ($1, 'Rika User', 'rika@example.test', true, now(), now())`, [account.user.id]),
        )
        yield* Effect.promise(() =>
          migrated!.query(`INSERT INTO "organization" (id, name, slug, created_at)
            VALUES ($1, 'Rika', 'rika-cli-e2b', now())`, [organizationId]),
        )
        yield* Effect.promise(() =>
          migrated!.query(`INSERT INTO member (id, organization_id, user_id, role, created_at)
            VALUES ($1, $2, $3, 'owner', now())`, [memberId, organizationId, account.user.id]),
        )
        let gateway: Gateway | undefined
        const runFork = Effect.runForkWith(yield* Effect.context<never>())
        let helloAccepted = 0
        const creates: Array<CreateRequest> = []
        const bootstraps: Array<BootstrapRequest> = []
        const operations: Array<Extract<ControllerMessage, { readonly _tag: "CellExecute" }>> = []
        const closes: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = []
        const response: CellResponse = {
          _tag: "Success",
          result: { exitCode: 0, stdout: "hosted-mvp\n", stderr: "" },
        }
        const socket: Socket = {
          send: (frame) => {
            const message = JSON.parse(frame) as ControllerMessage
            if (message._tag === "ExecutorWelcome") helloAccepted += 1
            if (message._tag === "CellExecute") {
              operations.push(message)
              runFork(
                gateway!.receive(
                  socket,
                  encodeHostMessage({ _tag: "CellResult", operationKey: message.request.operationKey, response }),
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
                    encodeHostMessage({
                      _tag: "ExecutorHello",
                      hello: {
                        minimumVersion: 1,
                        maximumVersion: 1,
                        fence: {
                          target: "e2b",
                          assignmentId: creates[0]!.assignmentId,
                          assignmentGeneration: creates[0]!.generation,
                          instanceId: request.sandboxId,
                          executorId: `${creates[0]!.assignmentId}:g${creates[0]!.generation}`,
                          processIncarnation: "fake-e2b-host-1",
                        },
                        templateBuildId: creates[0]!.templateBuildId,
                        capabilities: { cells: true, checkpoints: false, pty: false },
                        cursors: { command: 0, event: 0, pty: 0 },
                        latestCheckpointId: null,
                        bootstrapToken: Redacted.value(request.credential),
                      },
                    }),
                  ),
                )
              }),
            connect: (sandboxId) => Effect.succeed({ sandboxId, state: "running" as const }),
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
          controllerUrl: "wss://control.example.test/api/v1/executors",
          allowedEgress: ["control.example.test", "github.com", "api.github.com"],
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              provider,
              BunCrypto.layer,
              Layer.succeed(
                Inspector,
                Inspector.of({ inspect: () => Effect.fail(InspectionError.make({ message: "unused" })) }),
              ),
              Layer.succeed(
                Credentials,
                Credentials.of({ issue: () => Effect.fail(CredentialError.make({ message: "unused" })) }),
              ),
            ),
          ),
        )
        const databaseLayer = HostedPostgres.layer({ url: Redacted.make(url), maxConnections: 8 })
        const shared = Layer.mergeAll(databaseLayer, AuthorizationPolicy.layer, BunCrypto.layer)
        const productLayer = hostedProductLayer({
          templateBuildId: "template-build-v1-immutable",
          providerScope: "integration-test",
        }).pipe(Layer.provide(shared))
        const executorLayer = executorService.pipe(Layer.provide(controller), Layer.provide(shared))
        const context = yield* Layer.build(Layer.merge(productLayer, executorLayer).pipe(Layer.provideMerge(shared)))
        const product = Context.get(context, HostedProduct)
        const executor = Context.get(context, Executor)
        gateway = executor.gateway
        const databaseTime = yield* Effect.promise(() =>
          migrated!.query<{ readonly millis: string }>(
            "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS millis",
          ),
        )
        yield* TestClock.setTime(Number(databaseTime.rows[0]!.millis))
        const connection = yield* product.createConnection({
          authority: { organizationId, memberId, deviceId, clientId, dpopJkt: "dpop-thumbprint" },
          placement: "e2b",
        })
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
          executor,
          execution: { check: Effect.die("unused") },
          production: false,
        }
        const api = makeControlPlaneApiHandler(dependencies)
        let operationRetry: Parameters<typeof api.handler>[0] | undefined
        const client = HttpClient.make((request) =>
          Effect.promise(() => {
            const pathname = new URL(request.url).pathname
            if (pathname === "/api/auth/oauth2/token")
              return Promise.resolve(
                Response.json({
                  access_token: "access-token",
                  refresh_token: "refresh-token",
                  expires_in: 600,
                  token_type: "DPoP",
                }),
              )
            const web = webRequest(request)
            if (pathname.endsWith("/operations")) operationRetry = web.clone() as Parameters<typeof api.handler>[0]
            return api.handler(web)
          }).pipe(Effect.map((value) => HttpClientResponse.fromWeb(request, value))),
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
                  origin: "https://control.example.test",
                  organization: organizationId,
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
                    credential ?? { refreshToken: Redacted.make("refresh-token"), privateJwk: privateJwk as PrivateJwk },
                  ),
                ),
              save: (_origin, _device, value) =>
                Effect.sync(() => {
                  credential = value
                }),
              remove: () => Effect.succeed(true),
            }),
          ),
          Layer.succeed(Browser, Browser.of({ open: () => Effect.void })),
        )
        const hostedCommand = Layer.effect(
          HostedCommand.Service,
          Effect.context<Browser | CredentialStore | import("effect").Crypto.Crypto | Http | ProfileStore>().pipe(
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
        expect(operationRetry).toBeDefined()
        const retried = yield* Effect.promise(() => api.handler(operationRetry!))
        expect(retried.status).toBe(200)
        expect(yield* Effect.promise(() => retried.json())).toEqual({ output: "hosted-mvp\n" })
        const [thread, assignment, commands, events] = yield* Effect.promise(() =>
          Promise.all([
            migrated!.query(`SELECT executor_kind FROM rika_hosted_threads WHERE id = $1`, [connection.threadId]),
            migrated!.query(`SELECT id, thread_id FROM rika_hosted_executor_assignments WHERE thread_id = $1`, [connection.threadId]),
            migrated!.query(`SELECT idempotency_key FROM rika_hosted_thread_commands WHERE thread_id = $1`, [connection.threadId]),
            migrated!.query(`SELECT event FROM rika_hosted_thread_events WHERE thread_id = $1`, [connection.threadId]),
          ]),
        )
        expect(thread.rows).toEqual([{ executor_kind: "e2b" }])
        expect(assignment.rows).toEqual([{ id: connection.threadId, thread_id: connection.threadId }])
        expect(helloAccepted).toBe(1)
        expect(closes).toEqual([])
        expect(commands.rows).toHaveLength(1)
        expect(operations).toHaveLength(1)
        expect(operations[0]?.request.operationKey).toBe(commands.rows[0]?.idempotency_key)
        expect(operations[0]?.request.toolCallId).toBe(commands.rows[0]?.idempotency_key)
        expect(events.rows).toHaveLength(1)
        expect(events.rows[0]?.event).toMatchObject({
          _tag: "CellResult",
          operationKey: commands.rows[0]?.idempotency_key,
          response,
        })
        expect(creates).toHaveLength(1)
        expect(bootstraps).toHaveLength(1)
        expect(creates[0]?.environment).not.toHaveProperty("DATABASE_URL")
        expect(yield* Ref.get(localServerSpawns)).toBe(0)
        yield* Effect.promise(api.dispose)
      } finally {
        yield* Effect.promise(() => migrated?.end() ?? Promise.resolve())
        yield* Effect.promise(() => admin.query(`DROP DATABASE "${database}" WITH (FORCE)`))
        yield* Effect.promise(() => admin.end())
      }
    }),
  ).pipe(Effect.provideService(HttpClient.HttpClient, unusedHttpClient)),
)
