import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Config } from "../src/index"

describe("Config", () => {
  test("parses compaction auto and reserved token settings from env", async () => {
    const values = await Effect.runPromise(
      Config.get().pipe(
        Effect.provide(
          Config.layerFromEnv(
            {
              RIKA_MODE: "rush",
              RIKA_COMPACTION_AUTO: "false",
              RIKA_COMPACTION_RESERVED: "12345",
              RIKA_COMPACTION_PRUNE: "false",
              RIKA_COMPACTION_PRUNE_PROTECT: "40000",
              RIKA_COMPACTION_PRUNE_MINIMUM: "20000",
            },
            "/workspace/rika-config-test",
          ),
        ),
      ),
    )

    expect(values).toMatchObject({
      default_mode: "rush",
      compaction_auto: false,
      compaction_reserved: 12_345,
      compaction_prune: false,
      compaction_prune_protect: 40_000,
      compaction_prune_minimum: 20_000,
    })
  })
})
