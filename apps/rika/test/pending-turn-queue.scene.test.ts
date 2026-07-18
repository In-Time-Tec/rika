import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "edits and removes pending turns before promoting the FIFO head",
  () =>
    Scene.run({
      script: [
        Scene.model.text("ACTIVE_DONE", 6_000),
        Scene.model.text("Pending queue controls"),
        Scene.model.text("FIFO_PROMOTED"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run the active turn slowly.\r"),
        Scene.action.writeAfter("Run the active turn slowly.", "Keep this FIFO prompt.\r"),
        Scene.action.writeAfter("Keep this FIFO prompt.", "Remove this pending prompt.\r"),
        Scene.action.writeAfter("Remove this pending prompt.", "\u001b[A\u0005", 100),
        Scene.action.writeAfter("Editing queued", "\u0015Edited then removed.\r"),
        Scene.action.writeAfter("Edited then removed.", "\u007f", 100),
        Scene.action.writeAfter("FIFO_PROMOTED", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("Editing queued")
      expect(result.output).toContain("Edited then removed.")
      expect(result.output).toContain("ACTIVE_DONE")
      expect(result.output).toContain("FIFO_PROMOTED")
      expect(result.output.indexOf("ACTIVE_DONE")).toBeLessThan(result.output.indexOf("FIFO_PROMOTED"))
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  40_000,
)
