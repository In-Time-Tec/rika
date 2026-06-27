import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Config, Diagnostics, IdGenerator, Runtime, TestHarness, Time } from "../src/index"

const config = {
  workspace_root: "/workspace",
  data_dir: "/workspace/.rika",
  default_mode: "deep" as const,
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

  test("captures diagnostics in a memory layer", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []

    await TestHarness.runPromise(
      Diagnostics.emit({ level: "info", message: "hello", data: { ok: true } }),
      TestHarness.testLayer({ diagnostics }),
    )

    expect(diagnostics).toEqual([{ level: "info", message: "hello", data: { ok: true } }])
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
