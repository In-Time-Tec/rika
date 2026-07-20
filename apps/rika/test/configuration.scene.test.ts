import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "shows the workspace shell permission prompt when it overrides a global allow",
  () =>
    Scene.run({
      globalSettings: { permissions: { shell: "allow" } },
      workspaceSettings: { permissions: { shell: "ask" } },
      script: [
        Scene.model.turn([Scene.model.toolCall("bash", { command: "printf configured-shell" }, "bash")]),
        Scene.model.text("Configured shell completed."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Check the configured shell permission.\r"),
        Scene.action.writeAfter("shell [pending]", "\r"),
        Scene.action.writeWhenTurnStatus("Check the configured shell permission.", "completed", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("shell [pending]")
      expect(result.output).toContain("configured-shell")
      expect(result.clientLogs).toContain('"rika.event.type":"tool.result.received"')
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
