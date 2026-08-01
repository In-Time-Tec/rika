import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface, maxMountedTranscriptEntries } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model, update } from "../../src/state/model/terminal-state"
import {
  openTui,
  _insertText,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./opentui-surface-characterization-4.test-support"
test("coalesces rapid wheel offsets into one report per frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 400 }, (_, index) => ({
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
      const offsets = new Array<number>()
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            offsets.push(offset)
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
        },
        { clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        for (let index = 0; index < 20; index += 1)
          yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))

        expect(offsets).toHaveLength(1)
        clock.advance(15)
        expect(offsets).toHaveLength(1)
        clock.advance(1)
        expect(offsets).toHaveLength(2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("moves the bounded transcript window forward by one measured page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const historySize = maxMountedTranscriptEntries + 300
      const entries = Array.from({ length: historySize }, (_, index) => ({
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
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[6~")
        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        const state = surface as unknown as {
          readonly transcriptWindowEnd: number
          readonly transcriptAnchorScrollBy: number
        }
        expect(state.transcriptWindowEnd).toBe(historySize)
        expect(firstAfter).toBeGreaterThan(firstBefore)
        expect(firstAfter).toBeLessThan(firstBefore + 50)
        expect(state.transcriptAnchorScrollBy).toBe(0)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
