import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Effect, Redacted } from "effect"
import { Config, Diagnostics, IdGenerator, Runtime, SecretRedactor, TestHarness, Time } from "../src/index"

const config = {
  workspace_root: "/workspace",
  data_dir: "/workspace/.rika",
  default_mode: "deep3" as const,
}

describe("core runtime services", () => {
  test("provides injectable config", async () => {
    const result = await TestHarness.runPromise(Config.get(), TestHarness.testLayer({ config }))

    expect(result).toEqual(config)
  })

  test("reports missing required config with a typed error", async () => {
    const error = await TestHarness.runPromise(
      Config.requireEnv("RIKA_TOKEN").pipe(Effect.flip),
      TestHarness.testLayer(),
    )

    expect(error).toBeInstanceOf(Config.ConfigError)
    expect(error.key).toBe("RIKA_TOKEN")
  })

  test("returns required secrets as redacted values", async () => {
    const secret = await TestHarness.runPromise(
      Config.requireSecret("RIKA_API_KEY"),
      TestHarness.testLayer({ env: { RIKA_API_KEY: "secret-value" } }),
    )

    expect(JSON.stringify(secret)).toBe('"<redacted:RIKA_API_KEY>"')
    expect(Redacted.value(secret)).toBe("secret-value")
  })

  test("captures diagnostics in a memory layer", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []

    await TestHarness.runPromise(
      Diagnostics.emit({ level: "info", message: "hello", data: { ok: true } }),
      TestHarness.testLayer({ diagnostics }),
    )

    expect(diagnostics).toEqual([{ level: "info", message: "hello", data: { ok: true } }])
  })

  test("maps diagnostic fields to queryable telemetry attributes", () => {
    expect(
      Diagnostics.attributesFromFields({
        thread_id: "thread_test",
        duration_ms: 12,
        cached: false,
        nested: { tool: "shell" },
        skipped: null,
      }),
    ).toEqual({
      "rika.thread_id": "thread_test",
      "rika.duration_ms": 12,
      "rika.cached": false,
      "rika.nested": '{"tool":"shell"}',
    })
  })

  test("writes diagnostics to the log file from injected config env", async () => {
    const directory = await mkdtemp(`${tmpdir()}/rika-diagnostics-`)
    const path = `${directory}/session.ndjson`

    try {
      await Effect.runPromise(
        Diagnostics.emit({ level: "info", message: "configured-log", data: { thread_id: "thread_test" } }).pipe(
          Effect.provide(Diagnostics.layer),
          Effect.provide(SecretRedactor.layer),
          Effect.provide(Config.layerFromValues(config, { RIKA_LOG_FILE: path })),
        ),
      )

      const line = (await readFile(path, "utf8")).trim()
      expect(JSON.parse(line)).toMatchObject({
        level: "info",
        message: "configured-log",
        data: { thread_id: "thread_test" },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("provides controlled time and deterministic IDs", async () => {
    const program = Effect.gen(function* () {
      const now = yield* Time.nowMillis()
      const first = yield* IdGenerator.next("evt")
      const second = yield* IdGenerator.next("evt")
      return { now, first, second }
    })

    const result = await TestHarness.runPromise(program, TestHarness.testLayer({ now: 123, idStart: 41 }))

    expect(result).toEqual({ now: 123, first: "evt_41", second: "evt_42" })
  })

  test("runs a service through a managed runtime wrapper", async () => {
    const runtime = Runtime.makeRuntime(Config.Service, Config.layerFromValues(config))
    const result = await runtime.runPromise((service) => service.get)

    expect(result).toEqual(config)
  })
})
