import { expect, it } from "@effect/vitest"
import { ExecutorTransportError } from "@rika/execution"
import { Effect, Inspectable, Schema } from "effect"
import { makeApiV2Application } from "../../src/application"
import { makeApiV2ProductionComposition, resolveApiV2ProductionDependencies } from "../../src/bootstrap/production"
import { runtimeStorageLayer } from "../../src/runtime/storage"
import { makeProductionHarness, orbBinding, productionConfig, runnerBinding } from "./production.harness"

const orbCreateBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  owner: { kind: "personal" },
  threadId: "new-orb-thread",
  target: "orb",
})

const applicationRequest = (application: Effect.Success<ReturnType<typeof makeApiV2Application>>, request: Request) =>
  application.handle({
    authority: application.authority,
    gateway: application.gateway,
    environment: application.environment,
    request,
  })

it.effect("owns one identity/product authority graph without allocating execution on startup or metadata paths", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeProductionHarness()
      const composition = yield* makeApiV2ProductionComposition(
        productionConfig,
        harness.dependencies,
        harness.services,
        runtimeStorageLayer({ bucket: "runtime", region: "us-east-1" }),
      )
      expect(composition.options.authority).toBe(composition.authority)
      expect(composition.options.product).toBe(composition.authority.product)
      expect(composition.options.runnerGateway).toBe(composition.runnerGateway)
      expect(composition.options.boxGateway).toBe(harness.dependencies.boxGateway)
      expect(composition.options.productControl?.identity).toBe(harness.services.identity)
      expect(composition.options.productControl?.directory).toBe(harness.services.directory)
      expect(composition.options.productControl?.devices).toBe(harness.services.devices)

      const application = yield* makeApiV2Application(composition.options)
      const health = yield* applicationRequest(application, new Request("http://rika.test/healthz"))
      expect(health.status).toBe(200)
      const rivetMetadata = yield* Effect.tryPromise(() =>
        application.registry.handler(new Request("http://rika.test/api/rivet/metadata")),
      )
      expect(rivetMetadata.status).toBe(200)
      const metadata = yield* applicationRequest(
        application,
        new Request("http://rika.test/api/v2/threads?limit=10", {
          headers: { authorization: "Bearer metadata-access" },
        }),
      )
      expect(metadata.status).toBe(200)
      expect(yield* Effect.tryPromise(() => metadata.text())).toContain("Metadata Thread")
      const created = yield* applicationRequest(
        application,
        new Request("http://rika.test/api/v2/threads", {
          method: "POST",
          headers: { authorization: "Bearer create-access", "content-type": "application/json" },
          body: orbCreateBody,
        }),
      )
      expect(created.status).toBe(201)
      expect(harness.state.createdThreads).toEqual(["new-orb-thread"])
      expect(harness.state.contextAllocations).toBe(0)
      expect(harness.state.orbAllocations).toBe(0)
      expect(harness.state.repositoryReads).toBe(0)
    }),
  ),
)

it.effect("routes Runner bindings through the authenticated gateway and delegates only Orb workspaces", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeProductionHarness()
      const composition = yield* makeApiV2ProductionComposition(
        productionConfig,
        harness.dependencies,
        harness.services,
        runtimeStorageLayer({ bucket: "runtime", region: "us-east-1" }),
      )
      const runner = yield* composition.options.workspace(runnerBinding)
      expect(runner.binding).toEqual(runnerBinding.workspaceBinding)
      expect(harness.state.orbAllocations).toBe(0)
      const authenticated = yield* composition.runnerGateway.bindingForThread({
        request: new Request("http://rika.test/api/v2/threads/runner-thread/executor", {
          headers: { authorization: "DPoP runner-access", dpop: "runner-proof" },
        }),
        threadId: "runner-thread",
      })
      expect(authenticated).toEqual(runnerBinding.workspaceBinding)
      expect(harness.state.runnerBindingReads).toBe(1)
      const orb = yield* composition.options.workspace(orbBinding)
      expect(orb.binding).toEqual(orbBinding.workspaceBinding)
      expect(harness.state.orbAllocations).toBe(1)
      expect(harness.state.contextAllocations).toBe(0)
      expect(harness.state.repositoryReads).toBe(0)
    }),
  ),
)

it.effect("passes the exact lazily resolved workspace proxy into each context factory call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeProductionHarness()
      const composition = yield* makeApiV2ProductionComposition(
        productionConfig,
        harness.dependencies,
        harness.services,
        runtimeStorageLayer({ bucket: "runtime", region: "us-east-1" }),
      )
      const runner = yield* composition.options.workspace(runnerBinding)
      yield* Effect.exit(composition.options.context({
        partition: runnerBinding.partition,
        binding: runnerBinding,
        workspace: runner,
        rebindWorkspace: () => Effect.void,
      }))
      expect(harness.state.contextAllocations).toBe(1)
      expect(harness.state.contextWorkspaces[0]?.binding).toEqual(runnerBinding.workspaceBinding)
      expect(harness.state.orbAllocations).toBe(0)
      const orb = yield* composition.options.workspace(orbBinding)
      yield* Effect.exit(composition.options.context({
        partition: orbBinding.partition,
        binding: orbBinding,
        workspace: orb,
        rebindWorkspace: () => Effect.void,
      }))
      expect(harness.state.contextAllocations).toBe(2)
      expect(harness.state.orbAllocations).toBe(1)
      expect(harness.state.contextWorkspaces[1]).toBe(harness.state.orbWorkspaces[0])
    }),
  ),
)

it.effect("maps workspace resolution failures without leaking transport details or invoking context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeProductionHarness()
      const secret = "workspace-transport-secret"
      const composition = yield* makeApiV2ProductionComposition(
        productionConfig,
        {
          ...harness.dependencies,
          orbWorkspace: () => Effect.fail(ExecutorTransportError.make({ phase: "connection", message: secret })),
        },
        harness.services,
        runtimeStorageLayer({ bucket: "runtime", region: "us-east-1" }),
      )
      const result = yield* Effect.result(composition.options.workspace(orbBinding))
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { phase: "connection", message: "Workspace Executor is unavailable" },
      })
      expect(Inspectable.toStringUnknown(result)).not.toContain(secret)
      expect(harness.state.contextAllocations).toBe(0)
    }),
  ),
)

it.effect("resolves the dependency factory once with the exact live service graph and process scope", () =>
  Effect.gen(function* () {
    const harness = makeProductionHarness()
    const events: string[] = ["services-ready"]
    let calls = 0
    let finalized = false
    const dependencies = yield* Effect.scoped(
      Effect.gen(function* () {
        const resolved = yield* resolveApiV2ProductionDependencies({
          services: harness.services,
          factory: (services) =>
            Effect.gen(function* () {
              calls += 1
              events.push("factory")
              expect(services).toBe(harness.services)
              expect(services.boxAssignments).toBe(harness.services.boxAssignments)
              expect(services.providerCredentials).toBe(harness.services.providerCredentials)
              expect(services.crypto).toBe(harness.services.crypto)
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized = true
                  events.push("factory-finalized")
                }),
              )
              return harness.dependencies
            }),
        })
        expect(finalized).toBe(false)
        return resolved
      }),
    )
    expect(dependencies).toBe(harness.dependencies)
    expect(calls).toBe(1)
    expect(finalized).toBe(true)
    expect(events).toEqual(["services-ready", "factory", "factory-finalized"])
  }),
)

it.effect("sanitizes synchronous dependency-factory failures as composition startup errors", () =>
  Effect.gen(function* () {
    const harness = makeProductionHarness()
    const secret = "factory-error-secret"
    const result = yield* Effect.result(
      Effect.scoped(
        resolveApiV2ProductionDependencies({
          services: harness.services,
          factory: () => {
            throw new Error(secret)
          },
        }),
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Success") return yield* Effect.die("Dependency factory failure was not retained")
    expect(result.failure).toMatchObject({ dependency: "composition", message: "composition initialization failed" })
    expect(Inspectable.toStringUnknown(result.failure)).not.toContain(secret)
  }),
)
