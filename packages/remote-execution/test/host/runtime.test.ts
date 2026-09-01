import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref, Semaphore } from "effect"
import { mutableExecutionEnvironment } from "../../src/host/execution-environment"
import { testing } from "../../src/host/service"
import type { IncomingMessage } from "../../src/protocol/messages"

type PhaseGrant = Extract<IncomingMessage, { readonly _tag: "PhaseEnvironmentGranted" }>

describe("hosted phase environment", () => {
  it.effect("replaces ambient native tool values and retains operation-scoped grants", () =>
    Effect.gen(function* () {
      const grants = yield* Ref.make(new Map<string, PhaseGrant>())
      const access = yield* Semaphore.make(1)
      const environment = mutableExecutionEnvironment()
      environment.replace({ SETUP_TOKEN: "setup-value" })
      yield* testing.applyPhaseGrant(
        {
          _tag: "PhaseEnvironmentGranted",
          phase: "runtime",
          digest: `sha256:${"b".repeat(64)}`,
          operationKey: null,
          values: { RUNTIME_TOKEN: "runtime-value" },
          redactedNames: ["RUNTIME_TOKEN"],
        },
        grants,
        environment.values,
        access,
      )
      expect({ ...environment.values }).toEqual({ RUNTIME_TOKEN: "runtime-value" })
      const operation = {
        _tag: "PhaseEnvironmentGranted" as const,
        phase: "runtime" as const,
        digest: `sha256:${"c".repeat(64)}`,
        operationKey: "operation-1",
        values: { OPERATION_TOKEN: "operation-value" },
        redactedNames: ["OPERATION_TOKEN"],
      }
      yield* testing.applyPhaseGrant(operation, grants, environment.values, access)
      expect((yield* Ref.get(grants)).get("operation-1")).toEqual(operation)
      expect({ ...environment.values }).toEqual({ RUNTIME_TOKEN: "runtime-value" })
    }),
  )
})
