import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref, Semaphore } from "effect"
import { testing } from "../src/host"

describe("hosted phase environment", () => {
  it("redacts active secret values from output and terminal responses", () => {
    const secret = "exact-secret-value"
    expect(testing.redactOutput(`before ${secret} after`, [secret])).toEqual({
      text: "before REDACTED after",
      truncated: false,
    })
    expect(
      testing.redactResponse(
        {
          _tag: "Success",
          result: { nested: [secret, `prefix-${secret}`], [secret]: "plain" },
        },
        [secret],
      ),
    ).toEqual({
      _tag: "Success",
      result: { nested: ["REDACTED", "prefix-REDACTED"], REDACTED: "plain" },
    })
  })

  it.effect("keeps phase values in memory and restarts kernels when runtime authorization changes", () =>
    Effect.gen(function* () {
      const grants = yield* Ref.make(new Map())
      const applied = yield* Ref.make(new Map([["session-1", `sha256:${"a".repeat(64)}`]]))
      const access = yield* Semaphore.make(1)
      const environment: Record<string, string> = { SETUP_TOKEN: "setup-value" }
      const restarts: Array<string> = []
      const executor = {
        execute: () => Effect.die("unused"),
        completeBinding: () => Effect.die("unused"),
        replayBindings: () => Effect.die("unused"),
        restart: (sessionId: string) => Effect.sync(() => restarts.push(sessionId)).pipe(Effect.asVoid),
      }
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
        environment,
        applied,
        executor,
        access,
      )
      expect(environment).toEqual({ RUNTIME_TOKEN: "runtime-value" })
      expect(restarts).toEqual(["session-1"])
      expect(yield* Ref.get(applied)).toEqual(new Map([["session-1", `sha256:${"b".repeat(64)}`]]))
      expect(yield* Ref.get(grants)).toEqual(new Map())
    }),
  )
})
