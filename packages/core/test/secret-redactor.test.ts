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

  test("registers common secret env names without registering public identifiers", () => {
    const entries = SecretRedactor.entriesFromEnv({
      AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-value",
      DATABASE_URL: "postgres://user:pass@localhost/rika",
      GH_TOKEN: "gh-token-value",
      OPENAI_API_KEY: "openai-api-key-value",
      PRIVATE_KEY: "private-key-value",
      RIKA_DATABASE_URL: "file:/tmp/rika.sqlite?password=secret",
      SERVICE_CREDENTIALS: "service-credentials-value",
      SERVICE_PASS: "service-pass-value",
      SERVICE_PASSWD: "service-passwd-value",
      STRIPE_SECRET_KEY: "stripe-secret-key-value",
      TOOL_APIKEY: "tool-apikey-value",
      CUSTOMER_ID: "customer-id-value",
      PUBLIC_KEY: "public-key-value",
      SERVICE_URL: "https://service.example/token",
    })

    expect(entries.map((entry) => entry.label).toSorted()).toEqual([
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "GH_TOKEN",
      "OPENAI_API_KEY",
      "PRIVATE_KEY",
      "RIKA_DATABASE_URL",
      "SERVICE_CREDENTIALS",
      "SERVICE_PASS",
      "SERVICE_PASSWD",
      "STRIPE_SECRET_KEY",
      "TOOL_APIKEY",
    ])
  })
})
