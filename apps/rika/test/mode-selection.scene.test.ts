import { expect, test } from "vitest"
import { Scene } from "./scene"

const mainRoute = (turn: { readonly executionRoute: unknown }) =>
  (
    turn.executionRoute as {
      readonly mode: string
      readonly main: {
        readonly alias: string
        readonly effort: string
        readonly fast: boolean
        readonly providerOptions?: Readonly<Record<string, unknown>>
      }
      readonly oracle: { readonly effort: string; readonly fast: boolean }
    }
  ).main

test(
  "wraps the mode picker, applies its choice, separates fast mode, and preserves current and queued route pins across restart",
  () =>
    Scene.run({
      script: [
        Scene.model.text("CURRENT_ROUTE_COMPLETE", 3_000),
        Scene.model.text("Current route title"),
        Scene.model.text("QUEUED_ROUTE_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u0013"),
        Scene.action.writeAfter("Balanced intelligence", "\u001b[D"),
        Scene.action.writeAfter("Fast, low-cost", "\u001b[D"),
        Scene.action.writeAfter("most capable mode", "\u001b[C"),
        Scene.action.writeAfter("Fast, low-cost", "\u001b[C\u001b[C"),
        Scene.action.writeAfter("Deep reasoning", "\rCURRENT_HIGH_NORMAL\r", 100),
        Scene.action.writeAfter("CURRENT_HIGH_NORMAL", "\u000f", 100),
        Scene.action.writeAfter("Command Palette", "fast"),
        Scene.action.writeAfter("toggle fast mode", "\rQUEUED_HIGH_FAST\r", 100),
        Scene.action.restartWhenTurn("QUEUED_HIGH_FAST", "queued", "threads", "continue", "--last"),
        Scene.action.writeWhenTurnStatus("QUEUED_HIGH_FAST", "completed", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("The most capable mode for hard")
      expect(result.output).toContain("Fast, low-cost mode for small")
      expect(result.output).toContain("QUEUED_HIGH_FAST")
      expect(result.output).toContain("CURRENT_ROUTE_COMPLETE")
      expect(result.output).toContain("QUEUED_ROUTE_COMPLETE")
      expect(result.turns).toHaveLength(2)
      expect(result.turns.map(({ prompt, status }) => ({ prompt, status }))).toEqual([
        { prompt: "CURRENT_HIGH_NORMAL", status: "completed" },
        { prompt: "QUEUED_HIGH_FAST", status: "completed" },
      ])
      expect(result.turns.map((turn) => mainRoute(turn))).toMatchObject([
        { alias: "sol", effort: "xhigh", fast: false },
        { alias: "sol", effort: "xhigh", fast: true, providerOptions: { service_tier: "priority" } },
      ])
      expect(
        result.turns.map(
          (turn) =>
            turn.executionRoute as { readonly mode: string; readonly oracle: { effort: string; fast: boolean } },
        ),
      ).toMatchObject([
        { mode: "high", oracle: { effort: "max", fast: false } },
        { mode: "high", oracle: { effort: "max", fast: true } },
      ])
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "keeps picker previews unapplied after escape and toggles fast mode independently",
  () =>
    Scene.run({
      response: "ESCAPED_PICKER_COMPLETE",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u0013"),
        Scene.action.writeAfter("Balanced intelligence", "\u001b[D"),
        Scene.action.writeAfterDelay("\u001b\0\u000f", 300),
        Scene.action.writeAfter("Command Palette", "fast"),
        Scene.action.writeAfter("toggle fast mode", "\r\0\u000f"),
        Scene.action.writeAfterDelay("fast", 300),
        Scene.action.writeAfterDelay("\rESCAPED_PICKER_SUBMISSION\r", 300),
        Scene.action.writeAfter("ESCAPED_PICKER_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.turns).toHaveLength(1)
      expect(result.turns[0]).toMatchObject({ prompt: "ESCAPED_PICKER_SUBMISSION", status: "completed" })
      expect(result.turns[0]!.executionRoute).toMatchObject({
        mode: "medium",
        main: { alias: "terra", effort: "medium", fast: false },
        oracle: { alias: "sol", effort: "high", fast: false },
      })
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
