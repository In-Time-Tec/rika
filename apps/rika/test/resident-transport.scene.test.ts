import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "keeps the real TUI on one authenticated resident feed across deterministic turns",
  () =>
    Scene.run({
      script: [
        Scene.model.text("Resident turn one complete."),
        Scene.model.text("Resident transport"),
        Scene.model.text("Resident turn two complete."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run the first resident turn.\r"),
        Scene.action.writeAfter("Resident turn one complete.", "Run the second resident turn.\r"),
        Scene.action.writeAfter("Resident turn two complete.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.timedOut, result.output).toBe(false)
      expect(result.exitCode, result.output).toBe(0)
      expect(result.actionsCompleted).toBe(3)
      expect(result.output).toContain("Resident turn one complete.")
      expect(result.output).toContain("Resident turn two complete.")
      expect(result.diagnostics).toContain("resident.connection.accepted")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
