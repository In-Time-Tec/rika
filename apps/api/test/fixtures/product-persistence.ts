import { BunCrypto } from "@effect/platform-bun"
import { makeProductClient } from "@rika/client/product"
import { WorkspaceExecutorRunnerFrame, workspaceExecutorWebSocketProtocol } from "@rika/execution"
import type { ThreadCreateRequestEncoded } from "@rika/product/thread-creation"
import type * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Crypto, Effect, Layer, Schema } from "effect"
import type { CliDeviceDirectory, IdentityDirectory, IdentityRuntime } from "@rika/identity"
import { AuthorizationPolicy } from "@rika/product/hosted-authorization"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { layer as clientAuthorityLayer } from "@rika/product-store/client-authority"
import { ProductRepository, layer as productRepositoryLayer } from "@rika/product-store/product-repository"
import { RunnerRegistrations, layer as runnerRegistrationsLayer } from "@rika/product-store/runner-registrations"
import * as DurabilityTesting from "generalist/testing/durability"
import { expect } from "vitest"
import { makeApiV2Application } from "../../src/application"
import { makeRepositoryProductAuthority } from "../../src/product/authority"
import { makeProductControl } from "../../src/product/control"
import { makeThreadBindingReader } from "../../src/executor/binding"
import { makeRunnerGateway } from "../../src/executor/runner-gateway"
import { prepareRunnerUpgrade } from "../../src/transport/runner-upgrade"

interface ProductRequest {
  readonly path: string
  readonly method: "GET" | "POST" | "PUT"
  readonly body?: Schema.Json
}

const responseJson = (response: Response) =>
  Effect.tryPromise(() => response.text()).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))))

export const qualifyProductPersistence = <E>(input: {
  readonly baseUrl: string
  readonly identity: IdentityRuntime
  readonly directory: IdentityDirectory
  readonly devices: CliDeviceDirectory
  readonly postgres: Context.Context<PgClient.PgClient>
  readonly userId: string
  readonly deviceId: string
  readonly request: (request: ProductRequest) => Effect.Effect<Request, E>
}): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        Layer.mergeAll(
          productRepositoryLayer,
          runnerRegistrationsLayer,
          clientAuthorityLayer,
          AuthorizationPolicy.layer,
          BunCrypto.layer,
        ).pipe(Layer.provide(Layer.succeedContext(input.postgres))),
      )
      const repository = Context.get(services, ProductRepository)
      const clientAuthority = Context.get(services, HostedClientAuthority)
      const product = makeProductControl({
        executorPolicy: { buildId: "test-build", protocolVersion: 1 },
        product: repository,
        runners: Context.get(services, RunnerRegistrations),
        authorization: Context.get(services, AuthorizationPolicy),
        crypto: Context.get(services, Crypto.Crypto),
        clientAuthority,
        repositories: { resolve: () => Effect.die("Unexpected repository checkout for an unlinked fixture") },
        orb: { templateBuildId: "test-snapshot-policy", providerScope: "test-box-policy" },
      })
      const authority = makeRepositoryProductAuthority({
        identity: input.identity,
        devices: input.devices,
        product: repository,
        clientAuthority,
        crypto: Context.get(services, Crypto.Crypto),
        environment: "product-control-test",
        binding: () => Effect.die("Metadata must not resolve an execution binding"),
      })
      const bucket = yield* DurabilityTesting.make()
      const gateway = {
        ensureRootSession: () => Effect.die("Metadata must not create a Generalist Session"),
        handle: () => Effect.die("Metadata must not dispatch to a Generalist Runtime"),
      }
      const application = yield* makeApiV2Application({
        authority,
        product: authority.product,
        productControl: { identity: input.identity, directory: input.directory, devices: input.devices, product },
        environment: "product-control-test",
        storage: Layer.merge(DurabilityTesting.layer(bucket), BunCrypto.layer),
        revision: "product-control-test",
        workspace: () => Effect.die("Metadata must not acquire an Executor"),
        context: () => Effect.die("Metadata must not materialize execution context"),
        gateway,
      })
      const handle = (request: ProductRequest) =>
        input.request(request).pipe(
          Effect.flatMap((incoming) =>
            application.handle({
              authority,
              gateway,
              environment: "product-control-test",
              request: incoming,
            }),
          ),
        )
      const client = makeProductClient({
        baseUrl: input.baseUrl,
        transport: {
          request: (request) =>
            application.handle({ authority, gateway, environment: "product-control-test", request }),
        },
        requestHeaders: ({ method, url }) =>
          Effect.gen(function* () {
            if (method !== "GET" && method !== "POST" && method !== "PUT")
              return yield* Effect.die("Unexpected fixture request method")
            const target = new URL(url)
            const request = yield* input.request({ method, path: `${target.pathname}${target.search}` })
            return Object.fromEntries(request.headers.entries())
          }).pipe(Effect.orDie),
      })
      const context = yield* handle({ method: "GET", path: "/api/v1/me/context" })
      expect(context.status).toBe(200)
      expect(yield* responseJson(context)).toMatchObject({ account: { id: input.userId }, projects: [] })
      const registered = yield* handle({
        method: "PUT",
        path: "/api/v2/runners/product-control-checkout",
        body: {
          protocolVersion: 2,
          workspaceIdentity: "product-control-workspace",
          repository: { identity: "product-control-repository" },
          nativeToolRuntime: { runtime: "bun", runtimeVersion: "1.4.0", trustMode: "trusted-local" },
          capabilities: { nativeTools: true, checkpoints: false, pty: false },
        },
      })
      expect(registered.status).toBe(204)
      const creation: ThreadCreateRequestEncoded = {
        owner: { kind: "personal" },
        threadId: "product-control-thread",
        target: "runner",
        runnerTarget: { deviceId: input.deviceId, checkoutFingerprint: "product-control-checkout" },
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const created = yield* client.createThread(creation)
        expect(created).toEqual({ threadId: "product-control-thread" })
      }
      const ownerId = yield* repository.personalOwnerId(input.userId)
      if (ownerId === undefined) return yield* Effect.die("The authenticated account did not resolve a Personal Owner")
      const binding = yield* repository.threadExecutionContext(ownerId, "product-control-thread")
      expect(binding).toMatchObject({
        workspaceId: "product-control-workspace",
        executorKind: "runner",
        generation: "1",
        hasTurns: false,
      })
      const readBinding = makeThreadBindingReader({ product: repository, environment: "product-control-test" })
      const runnerBinding = yield* readBinding({ ownerId, threadId: "product-control-thread" })
      expect(runnerBinding?.workspaceBinding).toMatchObject({
        workspaceId: "product-control-workspace",
        generation: 1,
        buildId: "test-build",
        protocolVersion: 1,
        placement: { _tag: "Runner", checkoutFingerprint: "product-control-checkout" },
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sent: string[] = []
          const runnerGateway = yield* makeRunnerGateway({
            identity: input.identity,
            devices: input.devices,
            directory: input.directory,
            product: repository,
            environment: "product-control-test",
          })
          const request = yield* input.request({
            method: "GET",
            path: "/api/v2/threads/product-control-thread/executor",
          })
          request.headers.set("sec-websocket-protocol", workspaceExecutorWebSocketProtocol)
          const prepared = yield* prepareRunnerUpgrade({
            request,
            threadId: "product-control-thread",
            gateway: runnerGateway,
          })
          if (prepared instanceof Response) return yield* Effect.die("The real DPoP Runner upgrade was rejected")
          yield* Effect.addFinalizer(() => prepared.close)
          yield* prepared.opened({
            send: (frame) => {
              sent.push(frame)
            },
            close: () => {},
          })
          yield* prepared.receive(
            yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))({
              _tag: "Enroll",
              binding: prepared.connection.executor.binding,
            }),
          )
          expect(yield* prepared.connection.ready).toEqual(runnerBinding?.workspaceBinding)
          expect(sent).toHaveLength(1)
          const replay = yield* prepareRunnerUpgrade({
            request,
            threadId: "product-control-thread",
            gateway: runnerGateway,
          })
          if (!(replay instanceof Response)) return yield* Effect.die("A replayed DPoP proof was accepted")
          expect(replay.status).toBe(401)
        }),
      )
      expect(yield* client.listThreads()).toMatchObject({
        threads: [{ id: "product-control-thread", target: "runner" }],
      })
      const incompatible = yield* handle({
        method: "POST",
        path: "/api/v2/threads",
        body: { owner: { kind: "personal" }, threadId: "product-control-thread", target: "orb" },
      })
      expect(incompatible.status).toBe(409)
      const replacement = yield* client.createThread({
        ...creation,
        threadId: "product-control-replacement",
        archiveThreadId: "product-control-thread",
      })
      expect(replacement).toEqual({ threadId: "product-control-replacement" })
      const afterArchive = yield* handle({ method: "GET", path: "/api/v2/threads" })
      expect(yield* responseJson(afterArchive)).toMatchObject({ threads: [{ id: "product-control-replacement" }] })
      const rows = yield* repository.threadMetadataList({ ownerId, limit: 50 })
      expect(rows.threads.map((thread) => thread.id)).toEqual(["product-control-replacement"])
      for (let attempt = 0; attempt < 2; attempt += 1)
        expect(yield* client.archiveThread("product-control-replacement")).toEqual({
          threadId: "product-control-replacement",
          archived: true,
        })
      const afterDirectArchive = yield* handle({ method: "GET", path: "/api/v2/threads" })
      expect(yield* responseJson(afterDirectArchive)).toMatchObject({ threads: [] })
      expect(yield* repository.threadExecutionContext(ownerId, "product-control-replacement")).toMatchObject({
        workspaceId: "product-control-workspace",
        executorKind: "runner",
        generation: "1",
        hasTurns: false,
      })
      yield* client.createThread({ owner: { kind: "personal" }, threadId: "box-policy-thread", target: "orb" })
      const boxBinding = yield* readBinding({ ownerId, threadId: "box-policy-thread" })
      expect(boxBinding?.workspaceBinding).toMatchObject({
        generation: 1,
        buildId: "test-build",
        protocolVersion: 1,
        placement: { _tag: "Orb" },
      })
      const reopened = yield* Layer.build(
        productRepositoryLayer.pipe(Layer.provide(Layer.succeedContext(input.postgres))),
      )
      const reread = makeThreadBindingReader({
        product: Context.get(reopened, ProductRepository),
        environment: "product-control-test",
      })
      expect(yield* reread({ ownerId, threadId: "box-policy-thread" })).toEqual(boxBinding)
    }),
  ).pipe(Effect.orDie)
