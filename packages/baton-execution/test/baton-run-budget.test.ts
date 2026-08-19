import { expect, it } from "@effect/vitest"
import { ModelRegistry } from "tenetkit"
import { TestModel } from "tenetkit/test"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Database } from "bun:sqlite"
import { Context, Effect, Layer, Random, Stream } from "effect"
import { sqliteLayer as layer } from "./baton-test-adapters"

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

const allocationOf = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = allocationOf(entry)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const budget = record.budget as { readonly allocation?: unknown } | undefined
  if (budget?.allocation !== undefined) return budget.allocation
  for (const entry of Object.values(record)) {
    const nested = allocationOf(entry)
    if (nested !== undefined) return nested
  }
  return undefined
}

/**
 * The allocation the durable driver charges against, read from Baton's own persisted state.
 *
 * A manifest assertion cannot prove this. Baton's host resolves the effective budget as
 * `resolved.agent.budget ?? agentBudget`, and `Agent.make` omits the property entirely when the
 * option is undefined, so an agent pinning an empty manifest budget can still be charged against
 * Baton's built-in 1,000,000-token default. Only the driver checkpoint shows what actually applies.
 */
const driverAllocation = (filename: string, runId: string): unknown => {
  const database = new Database(filename, { readonly: true })
  try {
    const row = database
      .query<
        { readonly driver_checkpoint_json: string | null },
        [string]
      >("SELECT driver_checkpoint_json FROM baton_runs WHERE run_id = ?")
      .get(runId)
    return row?.driver_checkpoint_json == null ? undefined : allocationOf(JSON.parse(row.driver_checkpoint_json))
  } finally {
    database.close()
  }
}

it.live(
  "charges a started run against no budget dimension so Baton's default ceiling never applies",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const filename = `/tmp/rika-run-budget-${yield* Random.nextInt}.db`
        const rootFixture = yield* TestModel.make([TestModel.turn([TestModel.text("DONE")])], {
          provider: "test",
          model: "test",
          registrationKey: "budget-root",
        })
        const route = testExecutionRoute()
        const context = yield* Layer.build(layer({ filename, modelServices: registryLayer(rootFixture) }))
        const gateway = Context.get(context, ExecutionGateway.Service)

        const receipt = yield* gateway.startTurn({
          threadId: "thread-budget",
          turnId: "turn-budget",
          workspace: "/workspace",
          prompt: "work",
          executionRoute: {
            ...route,
            tokenBudget: 12_000,
            main: withIdentity(route.main, "budget-root"),
            title: withIdentity(route.title, "budget-root"),
          },
        })
        yield* gateway.watchTurn(receipt).pipe(Stream.runCollect)

        const allocation = driverAllocation(filename, receipt.runId)
        expect(allocation, "the durable driver must record an allocation").toBeDefined()
        expect(allocation, "no dimension may be charged, not even a routed tokenBudget").toEqual({})
      }),
    ),
  60_000,
)
