import { expect, it, test } from "@effect/vitest"
import { Pins } from "generalist"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { Effect } from "effect"
import * as Registration from "../../src/registration"
import { configure } from "../support/adapters"

const workspace = "/workspace"

test("every registration codec carries the single pre-1.0 schema baseline", () => {
  expect(Object.fromEntries(Object.entries(Registration.codecs).map(([name, { version }]) => [name, version]))).toEqual(
    {
      applicationContext: "2",
      modelRoute: "1",
      modelRegistryRoute: "1",
      compaction: "1",
      tool: "1",
    },
  )
})

it.effect("pins every registration under its own codec contract and version", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const configured = yield* configure({ executionRoute, workspace })
    const expected = new Map<string, string>([
      [
        Pins.makeCapability({
          ...Registration.codecs.applicationContext.identity,
          route: executionRoute,
          workspace,
        }),
        Registration.codecs.applicationContext.codec,
      ],
      [
        Pins.makeModel({ ...Registration.codecs.modelRoute.identity, route: executionRoute.main }),
        Registration.codecs.modelRoute.codec,
      ],
      [
        Pins.makeCapability({
          ...Registration.codecs.modelRegistryRoute.identity,
          registrationIdentity: executionRoute.main.registrationIdentity,
        }),
        Registration.codecs.modelRegistryRoute.codec,
      ],
      [
        Pins.makeCapability({
          ...Registration.codecs.compaction.identity,
          intent: executionRoute.compaction,
          limits: executionRoute.main.compaction,
          summaryModel: executionRoute.compactionSummary.registrationIdentity,
        }),
        Registration.codecs.compaction.codec,
      ],
    ])
    const emitted = new Map(configured.registrations.map(({ pin, codec }) => [pin, codec] as const))
    for (const [pin, codec] of expected) expect([pin, emitted.get(pin)]).toEqual([pin, codec])
    for (const registration of configured.registrations) {
      const definition = Object.values(Registration.codecs).find(({ codec }) => codec === registration.codec)
      expect([registration.codec, registration.version]).toEqual([definition?.codec, definition?.version])
    }
  }),
)
