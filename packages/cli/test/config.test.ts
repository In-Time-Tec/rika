import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CliConfig, Output } from "../src/index"

describe("CLI config commands", () => {
  test("prints the Amp-compatible keymap", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      CliConfig.executeCommand({ type: "config", action: "keymap" }).pipe(
        Effect.provide(Layer.mergeAll(Output.memoryLayer(output))),
      ),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout).toEqual([CliConfig.keymapText])
  })
})
