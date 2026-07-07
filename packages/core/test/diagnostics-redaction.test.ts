import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { Config, Diagnostics, SecretRedactor, TestHarness } from "../src/index"

const config = {
  workspace_root: "/workspace",
  data_dir: "/workspace/.rika",
  default_mode: "smart" as const,
}

describe("Diagnostics redaction", () => {
  test("redactEntry uses the registered secret redactor", async () => {
    const secret = "direct-redact-entry-secret"

    const redacted = await TestHarness.runPromise(
      Effect.gen(function* () {
        yield* SecretRedactor.register([{ label: "FAKE_API_KEY", value: secret }])
        return yield* Diagnostics.redactEntry({
          level: "info",
          message: `message ${secret}`,
          data: { output: `data ${secret}` },
        })
      }),
      TestHarness.testLayer(),
    )

    expect(JSON.stringify(redacted)).toContain("[REDACTED:FAKE_API_KEY]")
    expect(JSON.stringify(redacted)).not.toContain(secret)
  })

  test("redacts direct diagnostic entries before they reach memory sinks", async () => {
    const secret = "diagnostic-secret-value"
    const diagnostics: Array<Diagnostics.Entry> = []

    await TestHarness.runPromise(
      Effect.gen(function* () {
        yield* SecretRedactor.register([{ label: "FAKE_API_KEY", value: secret }])
        yield* Diagnostics.emit({
          level: "info",
          message: "direct",
          data: { output: `raw ${secret}` },
        })
      }),
      TestHarness.testLayer({ diagnostics }),
    )

    expect(JSON.stringify(diagnostics)).toContain("[REDACTED:FAKE_API_KEY]")
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
  })

  test("redacts Diagnostics.event fields and failure text before emitting", async () => {
    const secret = "event-secret-value"
    const diagnostics: Array<Diagnostics.Entry> = []

    await TestHarness.runPromise(
      Effect.gen(function* () {
        yield* SecretRedactor.register([{ label: "FAKE_API_KEY", value: secret }])
        yield* Diagnostics.event(
          "diagnostics.redaction",
          (fields) =>
            Effect.gen(function* () {
              fields.detail = `field ${secret}`
              return yield* Effect.fail(new Error(`boom ${secret}`))
            }),
          { seed: `seed ${secret}` },
        ).pipe(Effect.flip)
      }),
      TestHarness.testLayer({ diagnostics }),
    )

    expect(JSON.stringify(diagnostics)).toContain("[REDACTED:FAKE_API_KEY]")
    expect(JSON.stringify(diagnostics)).not.toContain(secret)
  })

  test("redacts file diagnostics", async () => {
    const directory = await mkdtemp(`${tmpdir()}/rika-diagnostics-redaction-`)
    const path = `${directory}/session.ndjson`
    const secret = "file-diagnostic-secret"

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Diagnostics.emit({
            level: "info",
            message: "file",
            data: { output: `raw ${secret}` },
          })
        }).pipe(
          Effect.provide(Diagnostics.layer),
          Effect.provide(SecretRedactor.layerFromEntries([{ label: "FAKE_API_KEY", value: secret }])),
          Effect.provide(Config.layerFromValues(config, { RIKA_LOG_FILE: path })),
        ),
      )

      const contents = await readFile(path, "utf8")
      expect(contents).toContain("[REDACTED:FAKE_API_KEY]")
      expect(contents).not.toContain(secret)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
