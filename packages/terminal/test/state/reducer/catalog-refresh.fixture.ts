import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"
import { filteredThreads } from "../../../src/state/thread/navigation"
import { thread } from "../../support/surface/thread-browser.fixture"
import { openTui } from "./model.fixture"

test("renders refresh loading, failure and recovery while retaining titles and selection by identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 140, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const base = initial("/work", "high")
      let model: Model = {
        ...base,
        width: 140,
        height: 30,
        threads: [thread({ id: "a", title: "Keep this title" }), thread({ id: "b", title: "Selected thread" })],
        threadSwitcher: { ...base.threadSwitcher, open: true, selected: 1 },
        threadSidebar: { ...base.threadSidebar, selected: 1 },
      }
      try {
        for (const [status, label] of [
          ["loading", "Refreshing threads"],
          ["failed", "Refresh failed · Ctrl+R retry"],
          ["loading", "Refreshing threads"],
        ] as const) {
          model = update(model, { _tag: "ThreadsRefreshChanged", status })
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          expect(setup.captureCharFrame()).toContain(label)
          expect(setup.captureCharFrame()).toContain("Keep this title")
          expect(filteredThreads(model)[model.threadSwitcher.selected]?.id).toBe("b")
        }
        model = update(model, {
          _tag: "ThreadsReplaced",
          threads: [
            thread({ id: "b", title: "Updated selected title" }),
            thread({ id: "a", title: "Keep this title" }),
          ],
        })
        model = update(model, { _tag: "ThreadsRefreshChanged", status: "idle" })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("Updated selected title")
        expect(setup.captureCharFrame()).not.toContain("Refresh failed")
        expect(setup.captureCharFrame()).not.toContain("Refreshing threads")
        expect(filteredThreads(model)[model.threadSwitcher.selected]?.id).toBe("b")
        expect(model.threads[model.threadSidebar.selected]?.id).toBe("b")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
