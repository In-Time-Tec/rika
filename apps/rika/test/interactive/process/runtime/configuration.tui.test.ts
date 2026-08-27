import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../../support/tui-app.harness"

const route = (contextWindow: number, reserveTokens: number) => ({
  name: "GPT-5.6 Sol",
  effort: "xhigh",
  fast: false,
  contextWindow,
  reserveTokens,
})

test("restores remembered mode context before the first turn and updates it on mode switch", () =>
  TuiApp.run(
    Effect.gen(function* () {
      const app = yield* TuiApp.tuiApp({
        height: 36,
        modeConfiguration: {
          routes: {
            low: { main: route(10_000, 1_000), oracle: route(10_000, 1_000) },
            medium: { main: route(20_000, 2_000), oracle: route(20_000, 2_000) },
            high: { main: route(30_000, 3_000), oracle: route(30_000, 3_000) },
            ultra: { main: route(40_000, 4_000), oracle: route(40_000, 4_000) },
          },
          defaultMode: "medium",
          rememberedMode: "ultra",
        },
      })

      expect(app.frame()).toMatch(/ctx [ᗧᗤ].* 0% .* ultra/u)
      app.pressKey("y", { ctrl: true })
      const initialDetails = yield* app.waitFrame("Context & Usage")
      expect(initialDetails).toContain("Used        0")
      expect(initialDetails).toContain("Available   36K")
      expect(initialDetails).toContain("Full       40K")
      app.pressEscape()

      app.pressKey("s", { ctrl: true })
      const frame = yield* app.waitFrame("The most capable mode")
      expect(frame).toMatch(/ctx .* ultra/u)
      app.pressArrow("left")
      app.pressEnter()
      expect(yield* app.waitFrame("high")).toMatch(/ctx [ᗧᗤ].* 0% .* high/u)

      app.pressKey("y", { ctrl: true })
      const switchedDetails = yield* app.waitFrame("Context & Usage")
      expect(switchedDetails).toContain("Available   27K")
      expect(switchedDetails).toContain("Full       30K")

      app.pressEscape()
      yield* app.quit
    }),
  ))
