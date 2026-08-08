import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Database } from "bun:sqlite"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import * as JavaScriptSandbox from "@rika/sandbox/javascript-sandbox"
import { Context, Effect, FileSystem, Layer, Random, Schema, Stream } from "effect"
import { configuredBackendLayer } from "../src/server/composition/server-execution-layer"

it.scoped("constructs the composed backend without initializing Baton or QuickJS", () =>
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

it.live("builds the composed backend with QuickJS through one composition root", () =>
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

it.live(
  "admits Programs under the production QuickJS sandbox identity of the composition root",
  () =>
    Effect.gen(function* () {
      const filename = `/tmp/rika-server-composition-identity-${yield* Random.nextInt}.db`
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            configuredBackendLayer({ filename, testModel: { response: "composition complete" } }),
          )
          const gateway = Context.get(context, ExecutionGateway.Service)
          const link = yield* gateway.startTurn({
            threadId: "thread-composition",
            turnId: "turn-composition",
            workspace: "/workspace/composition",
            prompt: "verify the composed sandbox identity",
            executionRoute: testExecutionRoute(),
          })
          yield* gateway.watchTurn(link).pipe(Stream.runDrain)
        }),
      )
      const database = new Database(filename, { readonly: true })
      const rows = database
        .query<
          { payload_json: string },
          []
        >("SELECT payload_json FROM baton_executable_registrations WHERE codec = 'rika-program-sandbox'")
        .all()
      database.close()
      expect(rows).toHaveLength(1)
      const registration = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ payload: Schema.Unknown })),
      )(rows[0]!.payload_json)
      expect(registration.payload).toEqual({
        ...JavaScriptSandbox.productionIdentity,
        workspace: "/workspace/composition",
      })
    }),
  60_000,
)
