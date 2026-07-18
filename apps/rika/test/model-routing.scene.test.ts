import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "pins every model role before scripted execution and restores it after resident restart",
  () =>
    Scene.run({
      script: [Scene.model.text("Routing scene completed.", 1_000), Scene.model.text("Routing Restart Proof")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Prove the admitted model routes.\r"),
        Scene.action.restartWhenTurn("Prove the admitted model routes.", "running", "threads", "continue", "--last"),
        Scene.action.writeAfter("Routing scene completed.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Routing scene completed.")
      expect(result.output).not.toContain("No previous thread")
      expect(result.turns).toHaveLength(1)
      expect(result.turns[0]).toMatchObject({ prompt: "Prove the admitted model routes.", status: "completed" })
      const route = result.turns[0]?.executionRoute as {
        readonly mode: string
        readonly main: { readonly alias: string; readonly effort: string; readonly fast: boolean }
        readonly oracle: { readonly alias: string; readonly effort: string; readonly fast: boolean }
        readonly title: { readonly alias: string; readonly effort: string; readonly fast: boolean }
        readonly compactionSummary: { readonly alias: string; readonly effort: string; readonly fast: boolean }
        readonly agents: Readonly<Record<string, { readonly alias: string; readonly effort: string }>>
      }
      expect(route).toMatchObject({
        mode: "medium",
        main: { alias: "terra", effort: "medium", fast: false },
        oracle: { alias: "sol", effort: "high", fast: false },
        title: { alias: "luna", effort: "low", fast: false },
        compactionSummary: { alias: "terra", effort: "medium", fast: false },
        agents: {
          librarian: { alias: "sol", effort: "high" },
          painter: { alias: "sol", effort: "high" },
          review: { alias: "sol", effort: "high" },
          readThread: { alias: "terra", effort: "medium" },
          task: { alias: "terra", effort: "medium" },
        },
      })
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      expect(result.names.some((name) => name.startsWith("resident-"))).toBe(true)
    }),
  70_000,
)
