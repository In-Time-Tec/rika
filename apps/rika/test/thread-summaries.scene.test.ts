import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "shows projected edit totals and clears unread state when switching back to a completed thread",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "apply_patch",
            {
              patchText: "*** Begin Patch\n*** Add File: summary.txt\n+alpha\n+beta\n*** End Patch",
            },
            "summary-edit",
          ),
        ]),
        Scene.model.text("DONE"),
        Scene.model.object({ title: "Summary edit" }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Edit file.\r"),
        Scene.action.writeAfter("DONE", "\u000f", 500),
        Scene.action.writeAfter("Command Palette", "new thread\r"),
        Scene.action.writeAfterDelay("\u001c", 500),
        Scene.action.writeAfterDelay("\u0014", 500),
        Scene.action.writeAfter("Switch Thread", "\u001b[B\r"),
        Scene.action.writeAfter("DONE", "\u0014"),
        Scene.action.writeAfter("Switch Thread", "\u001b[A\r"),
        Scene.action.writeAfterDelay("\u001c", 500),
        Scene.action.writeAfter("Edit file", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Edit file")
      expect(result.output).toContain("+2")
      expect(result.output.lastIndexOf(" ○ Edit file")).toBeGreaterThanOrEqual(0)
      expect(result.output.lastIndexOf("   Edit file")).toBeGreaterThan(result.output.lastIndexOf(" ○ Edit file"))
      expect(result.diagnostics).toContain('"rika.model.backend.kind":"test-script"')
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
