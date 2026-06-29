import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Output, Version } from "../src/index"

describe("CLI version command", () => {
  test("formats the pinned Amp-compatible version line", () => {
    expect(Version.versionText(new Date("2026-06-29T09:00:00.000Z"))).toBe(
      "0.0.1782665646-g2f0017 (released 2026-06-28T16:54:06.000Z, 16h ago)",
    )
  })

  test("prints the Amp-compatible version line", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Version.executeCommand({ type: "version" }).pipe(Effect.provide(Layer.mergeAll(Output.memoryLayer(output)))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout[0]).toStartWith("0.0.1782665646-g2f0017 (released 2026-06-28T16:54:06.000Z, ")
  })
})
