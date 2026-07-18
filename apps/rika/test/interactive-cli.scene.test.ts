import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "starts the TUI with the CLI prompt, mode, and workspace",
  () =>
    Scene.run({
      arguments: ["Inspect", "this", "workspace", "--mode", "high", "--workspace", "."],
      response: "Interactive CLI prompt completed.",
      actions: [Scene.action.writeAfter("Interactive CLI prompt completed.", "\u0003", 100)],
    }).then((result) => {
      expect(result.output).toContain("Welcome to Rika")
      expect(result.output).toContain("Inspect this workspace")
      expect(result.output).toContain("Interactive CLI prompt completed.")
      expect(result.output).toContain("high")
      expect(result.diagnostics).toContain("tui.renderer.started")
      expect(result.diagnostics).toContain("operation.completed")
      expect(result.diagnostics).toContain('"rika.model.backend.kind":"test-response"')
    }),
  40_000,
)
