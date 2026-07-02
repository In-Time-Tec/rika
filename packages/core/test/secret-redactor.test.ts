import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SecretRedactor, TestHarness } from "../src/index"

describe("SecretRedactor", () => {
  test("redacts deterministically with longest-first matching", async () => {
    const result = await TestHarness.runPromise(
      Effect.gen(function* () {
        yield* SecretRedactor.register([
          { label: "SHORTER", value: "token-abc" },
          { label: "LONGER", value: "token-abcdef" },
        ])
        const first = yield* SecretRedactor.redact("value token-abcdef and token-abc")
        const second = yield* SecretRedactor.redact("value token-abcdef and token-abc")
        return { first, second }
      }),
      TestHarness.testLayer(),
    )

    expect(result.first).toBe("value [REDACTED:LONGER] and [REDACTED:SHORTER]")
    expect(result.second).toBe(result.first)
  })

  test("uses a stable label tie-breaker for duplicate values", async () => {
    const result = await TestHarness.runPromise(
      Effect.gen(function* () {
        yield* SecretRedactor.register([
          { label: "Z_TOKEN", value: "duplicate-secret" },
          { label: "A_TOKEN", value: "duplicate-secret" },
        ])
        return yield* SecretRedactor.redact("duplicate-secret")
      }),
      TestHarness.testLayer(),
    )

    expect(result).toBe("[REDACTED:A_TOKEN]")
  })

  test("ignores values shorter than eight characters", async () => {
    const result = await TestHarness.runPromise(
      Effect.gen(function* () {
        yield* SecretRedactor.register([
          { label: "SHORT", value: "short" },
          { label: "LONG", value: "long-secret" },
        ])
        return yield* SecretRedactor.redact("short long-secret")
      }),
      TestHarness.testLayer(),
    )

    expect(result).toBe("short [REDACTED:LONG]")
  })

  test("redacts JSON string leaves without changing non-string leaves", async () => {
    const result = await TestHarness.runPromise(
      Effect.gen(function* () {
        yield* SecretRedactor.register([{ label: "API_TOKEN", value: "json-secret-value" }])
        return yield* SecretRedactor.redactJson({
          text: "before json-secret-value after",
          nested: ["json-secret-value", 42, true, null],
        })
      }),
      TestHarness.testLayer(),
    )

    expect(result).toEqual({
      text: "before [REDACTED:API_TOKEN] after",
      nested: ["[REDACTED:API_TOKEN]", 42, true, null],
    })
  })
})
