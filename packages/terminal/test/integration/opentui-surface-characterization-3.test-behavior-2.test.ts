import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { update } from "../../src/state/reducer/terminal-state-reducer"
import {
  openTui,
  _insertText,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./opentui-surface-characterization-3-support"
test("does not report follow when a pending down-wheel timer settles at the followed bottom", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = { ...initial("/work", "high"), entries, items }
      let scrollCalls = 0
      let followCalls = 0
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            scrollCalls += 1
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            followCalls += 1
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { animate: false, clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 2,
        )
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        // Simulate native wheel movement reaching the tail before Rika's
        // coalesced timer observes settled geometry.
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        clock.advance(16)
        yield* openTui(() => setup.flush())

        expect(surface.transcriptScroll.scrollTop).toBe(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height,
        )
        expect(scrollCalls).toBe(0)
        expect(followCalls).toBe(0)
        expect(model.scrollFollow).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
