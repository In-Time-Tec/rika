import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"
import {
  openTui,
  _insertText,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./tool/detail.fixture"
test("keeps a followed transcript pinned to the bottom after markdown reflows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 30 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index} ${"word ".repeat(40)}`,
        turnId: `turn-${index}`,
      }))
      const model: Model = {
        ...initial("/work", "high"),
        width: 200,
        height: 30,
        entries,
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.update(update(model, { _tag: "Resized", width: 100, height: 30 }))
        yield* openTui(() => setup.flush())

        expect(surface.transcriptScroll.scrollTop).toBeGreaterThanOrEqual(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 1,
        )
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("suppresses programmatic scrollbar feedback and queued work after teardown", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const offsets = new Array<number>()
      const entries = Array.from({ length: 300 }, (_, index) => ({
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
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => offsets.push(offset),
      })
      try {
        surface.update({ ...initial("/work", "high"), entries, items, scrollFollow: false })
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(20)
        surface.transcriptScrollbar.scrollPosition = 10
        surface.destroy()
        yield* Effect.yieldNow
        expect(offsets).toEqual([])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("keeps a detached transcript window stable when live entries arrive", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
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
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptDiagnostics().virtualScrollTop - 1)
        yield* openTui(() => setup.flush())
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        surface.update({
          ...base,
          entries: [...entries, { role: "assistant", text: "answer 500", turnId: "turn-500" }],
          items: [...items, { _tag: "Entry", index: 500, id: "answer-500", turnId: "turn-500" }],
        })
        yield* openTui(() => setup.flush())
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
