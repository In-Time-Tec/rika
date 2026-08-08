import { expect, it, test } from "@effect/vitest"
import { Pins } from "@batonfx/core"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import * as JavaScriptSandbox from "@rika/sandbox/javascript-sandbox"
import { Effect } from "effect"
import * as Program from "../src/baton-program"
import * as Registration from "../src/baton-registration"
import { configure } from "../src/baton-route"

const sandbox = JavaScriptSandbox.make()
const workspace = "/workspace"

test("every registration codec carries the single pre-1.0 schema baseline", () => {
  expect(Object.fromEntries(Object.entries(Registration.codecs).map(([name, { version }]) => [name, version]))).toEqual(
    {
      applicationContext: "1",
      modelRoute: "1",
      modelRegistryRoute: "1",
      compaction: "1",
      tool: "1",
      programSandbox: "1",
      programInput: "1",
      programOutput: "1",
      programAgentInput: "1",
    },
  )
})

it.effect("pins every registration under its own codec contract and version", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const configured = yield* configure({ executionRoute, workspace, sandbox })
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
      [Program.pins.input, Registration.codecs.programInput.codec],
      [Program.pins.output, Registration.codecs.programOutput.codec],
      [configured.programAuthority.sandbox, Registration.codecs.programSandbox.codec],
    ])
    const emitted = new Map(configured.registrations.map(({ pin, codec }) => [pin, codec] as const))
    for (const [pin, codec] of expected) expect([pin, emitted.get(pin)]).toEqual([pin, codec])
    for (const registration of configured.registrations) {
      const definition = Object.values(Registration.codecs).find(({ codec }) => codec === registration.codec)
      expect([registration.codec, registration.version]).toEqual([definition?.codec, definition?.version])
    }
  }),
)
