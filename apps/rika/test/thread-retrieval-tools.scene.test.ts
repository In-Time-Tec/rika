import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "renders local Thread retrieval calls without selecting a provider",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("find_thread", { query: "", limit: 1 }, "find-local-thread")]),
        Scene.model.text("Thread retrieval complete."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Find local context and inspect the missing Thread.\r"),
        Scene.action.writeAfter("complete.", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.timedOut, result.output).toBe(false)
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain("Explored")
      expect(result.clientLogs.indexOf("find-local-thread:requested")).toBeLessThan(
        result.clientLogs.indexOf("find-local-thread:result"),
      )
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
