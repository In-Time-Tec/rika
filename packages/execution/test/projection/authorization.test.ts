import { expect, it } from "@effect/vitest"
import { ModelRegistry, Response as AiResponse } from "tenetkit"
import { TestModel } from "tenetkit/test"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Layer, Random, Stream } from "effect"
import { memoryLayer as layer } from "../support/adapters"

const registryLayer = (...fixtures: ReadonlyArray<TestModel.Fixture>) =>
  ModelRegistry.layer(
    fixtures.map((fixture) => Effect.succeed({ ...fixture.registration, isAvailabilityFailure: () => false })),
  )

type RouteModel = ReturnType<typeof testExecutionRoute>["main"]

const withIdentity = (model: RouteModel, identity: string): RouteModel => ({
  ...model,
  registrationIdentity: identity as typeof model.registrationIdentity,
  candidates: model.candidates.map((candidate) =>
    Object.assign({}, candidate, { registrationIdentity: identity as typeof candidate.registrationIdentity }),
  ),
})

it.live(
  "completes above TenetKit's default token ceiling because Rika pins no budget dimension",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const filename = `/tmp/rika-run-budget-${yield* Random.nextInt}.db`
        const rootFixture = yield* TestModel.make(
          [
            TestModel.turn([TestModel.text("DONE")], {
              usage: AiResponse.Usage.make({
                inputTokens: {
                  total: 1_100_000,
                  uncached: 1_100_000,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              }),
            }),
          ],
          { provider: "test", model: "test", registrationKey: "budget-root" },
        )
        const route = testExecutionRoute()
        const context = yield* Layer.build(layer({ dataRoot: filename, modelServices: registryLayer(rootFixture) }))
        const gateway = Context.get(context, ExecutionGateway.Service)

        const receipt = yield* gateway.startTurn({
          threadId: "thread-budget",
          turnId: "turn-budget",
          workspaceId: "/workspace",
          prompt: "work",
          executionRoute: {
            ...route,
            tokenBudget: 12_000,
            main: withIdentity(route.main, "budget-root"),
            title: withIdentity(route.title, "budget-root"),
          },
        })
        yield* gateway.watchTurn(receipt).pipe(Stream.runCollect)
        expect(yield* gateway.inspectTurn(receipt)).toMatchObject({ status: "completed" })
      }),
    ),
  60_000,
)
