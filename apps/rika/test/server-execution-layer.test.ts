import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { Context, Effect, FileSystem, Layer, Random } from "effect"
import { configuredBackendLayer } from "../src/server/composition/server-execution-layer"

it.effect("constructs the composed backend without initializing TenetKit", () =>
  Effect.gen(function* () {
    const filename = `/tmp/rika-server-composition-${yield* Random.nextInt}.db`
    const backend = configuredBackendLayer({ filename })
    const typed: Layer.Layer<ExecutionGateway.Service, ExecutionGateway.StartTurnFailure, never> = backend
    expect(typed).toBeDefined()
    const services = yield* Layer.build(BunServices.layer)
    const fileSystem = Context.get(services, FileSystem.FileSystem)
    expect(yield* fileSystem.exists(filename)).toBe(false)
  }),
)

it.live("builds the composed backend through one composition root", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const filename = `/tmp/rika-server-composition-build-${yield* Random.nextInt}.db`
      const context = yield* Layer.build(configuredBackendLayer({ filename }))
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
  ),
)
