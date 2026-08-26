import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../../support/tui-app.harness"

const label = { name: "GPT-5.6 Sol", effort: "xhigh", fast: false }

test("restores the remembered mode in both the footer and mode picker", () =>
  TuiApp.run(
    Effect.gen(function* () {
      const app = yield* TuiApp.tuiApp({
        height: 36,
        modeConfiguration: {
          routes: {
            low: { main: label, oracle: label },
            medium: { main: label, oracle: label },
            high: { main: label, oracle: label },
            ultra: { main: label, oracle: label },
          },
          defaultMode: "medium",
          rememberedMode: "ultra",
        },
      })

      app.pressKey("s", { ctrl: true })
      const frame = yield* app.waitFrame("The most capable mode")
      expect(frame).toMatch(/ctx .* ultra/u)

      app.pressEscape()
      yield* app.quit
    }),
  ))
