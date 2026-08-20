import { expect, it, test } from "@effect/vitest"
import { Pins } from "tenetkit"
import { testExecutionRoute } from "@rika/product/execution-route-snapshot"
import { ExecutableRegistration } from "tenetkit/runtime"
import { Cause, Effect, Exit } from "effect"
import * as Registration from "../src/registration"
import { configure } from "./test-adapters"

const workspace = "/workspace"
const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const

test("every registration codec carries the single pre-1.0 schema baseline", () => {
  expect(Object.fromEntries(Object.entries(Registration.codecs).map(([name, { version }]) => [name, version]))).toEqual(
    {
      applicationContext: "1",
      modelRoute: "1",
      modelRegistryRoute: "1",
      compaction: "1",
      kernelProfile: "1",
      tool: "1",
    },
  )
})

it.effect("pins every registration under its own codec contract and version", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const configured = yield* configure({ executionRoute, workspace, kernel })
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

it.effect("fails reconstruction typed when the admitted kernel profile no longer matches the host", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const admitted = yield* configure({ executionRoute, workspace, kernel })
    const changed = yield* configure({
      executionRoute,
      workspace,
      kernel: { ...kernel, runtimeVersion: "9.9.9" },
    })
    const failure = yield* Effect.exit(
      Registration.verify({
        expected: changed.registrations,
        actual: admitted.registrations,
        required: ExecutableRegistration.requiredPins(changed.executable),
      }),
    )
    expect(Exit.isFailure(failure)).toBe(true)
    if (Exit.isFailure(failure)) {
      const pretty = Cause.pretty(failure.cause)
      expect(pretty).toContain("ExecutableRegistration")
      expect(pretty).toContain("registration pin is not required by the executable")
    }
  }),
)

it.effect("fails reconstruction typed when the host kernel profile drifts under an unchanged manifest", () =>
  Effect.gen(function* () {
    const executionRoute = testExecutionRoute()
    const admitted = yield* configure({ executionRoute, workspace, kernel })
    const drifted = yield* configure({
      executionRoute,
      workspace,
      kernel: { ...kernel, trustMode: "trusted-workspace" },
    })
    const pinOf = (configured: {
      readonly registrations: ReadonlyArray<{ readonly pin: string; readonly codec: string }>
    }) => configured.registrations.find(({ codec }) => codec === Registration.codecs.kernelProfile.codec)?.pin
    expect(pinOf(drifted)).not.toBe(pinOf(admitted))
    const failure = yield* Effect.exit(
      Registration.verify({
        expected: drifted.registrations,
        actual: admitted.registrations,
        required: ExecutableRegistration.requiredPins(drifted.executable),
      }),
    )
    expect(Exit.isFailure(failure)).toBe(true)
  }),
)
