import { expect, it } from "@effect/vitest"
import { ModelRegistry, SandboxExecutor } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as JavaScriptSandbox from "@rika/javascript-sandbox/javascript-sandbox"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Cause, Context, Effect, Exit, Layer, Random, Stream } from "effect"
import { layer } from "../src/baton-execution"
import type { SandboxService } from "../src/baton-execution"

const storeExists = (filename: string) => Effect.promise(() => Bun.file(filename).exists())

const withoutSandbox = Context.makeUnsafe<SandboxService>(new Map())

const registryLayer = (fixture: TestModel.Fixture) =>
  ModelRegistry.layer([Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })])

const routeWithIdentity = (identity: string) => {
  const route = testExecutionRoute()
  return {
    ...route,
    main: {
      ...route.main,
      registrationIdentity: identity as typeof route.main.registrationIdentity,
      candidates: route.main.candidates.map((candidate) =>
        Object.assign({}, candidate, { registrationIdentity: identity as typeof candidate.registrationIdentity }),
      ),
    },
  }
}

it.live("requires the SandboxExecutor service before initializing any Baton store", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-baton-sandbox-required-${yield* Random.nextInt}.db`
    const exit = yield* Effect.exit(
      Effect.scoped(Layer.build(layer({ filename }))).pipe(Effect.provide(withoutSandbox)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(
      "Service not found: @batonfx/core/program/sandbox-executor/SandboxExecutor",
    )
    expect(yield* storeExists(filename)).toBe(false)
  }),
)

it.live("captures the provided SandboxExecutor without invoking it during build", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-baton-sandbox-captured-${yield* Random.nextInt}.db`
    let calls = 0
    const sandbox = SandboxExecutor.layerTest((): Effect.Effect<unknown, SandboxExecutor.ExecutionFailure, never> => {
      calls += 1
      return Effect.fail(SandboxExecutor.SandboxExecutionFailure.make({ message: "must not run" }))
    })
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer({ filename }).pipe(Layer.provide(sandbox)))
        const gateway = Context.get(context, ExecutionGateway.Service)
        expect(Object.keys(gateway).toSorted()).toEqual([
          "approveTurn",
          "cancelTurn",
          "denyTurn",
          "inspectTurn",
          "startTurn",
          "steerTurn",
          "watchTurn",
        ])
      }),
    )
    expect(calls).toBe(0)
    expect(yield* storeExists(filename)).toBe(true)
  }),
)

it.live(
  "runs a full Turn through the layer with the provided SandboxExecutor",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-baton-sandbox-turn-${yield* Random.nextInt}.db`
      const fixture = yield* TestModel.make([TestModel.turn([TestModel.text("sandboxed response")])], {
        provider: "test",
        model: "test",
        registrationKey: "sandbox-capture-route",
      })
      let calls = 0
      const sandbox = SandboxExecutor.layerTest((): Effect.Effect<unknown, SandboxExecutor.ExecutionFailure, never> => {
        calls += 1
        return Effect.fail(SandboxExecutor.SandboxExecutionFailure.make({ message: "must not run" }))
      }, JavaScriptSandbox.productionIdentity)
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            layer({ filename, modelServices: registryLayer(fixture) }).pipe(Layer.provide(sandbox)),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const link = yield* gateway.startTurn({
            threadId: "thread-sandbox",
            turnId: "turn-sandbox",
            workspace: "/workspace",
            prompt: "run with the sandbox wired",
            executionRoute: routeWithIdentity("sandbox-capture-route"),
          })
          const events = yield* gateway.watchTurn(link).pipe(Stream.runCollect)
          const view = yield* gateway.inspectTurn(link)
          return { events: [...events], view }
        }),
      )
      expect(
        result.events.some((change) =>
          (change._tag === "ProjectionSnapshot" ? change.units : change.upsert).some(
            (unit) =>
              unit.content._tag === "Entry" &&
              unit.content.role === "assistant" &&
              unit.content.text === "sandboxed response",
          ),
        ),
      ).toBe(true)
      expect(result.view.status).toBe("completed")
      expect(calls).toBe(0)
    }),
  60_000,
)
