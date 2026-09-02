import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../../src/opentui/surface/service"
import {
  boundedTranscriptModel,
  maxBoundedTranscriptItems,
  maxMountedTranscriptEntries,
} from "../../../../src/opentui/rendering/transcript/window"
import { maxMountedTranscriptRows } from "../../../../src/presentation/transcript/window"
import { initial, type Model } from "../../../../src/state/model"
import {
  openTui,
  _insertText,
  _streamingShell,
  giantSubagentModel,
  collapsedSubagentModel,
} from "../../../support/surface/transcript/pane-geometry.fixture"

for (const historySize of [1, maxMountedTranscriptEntries + 1] as const) {
  test(`keeps composer updates bounded with ${historySize} transcript entries`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
        const entries = Array.from({ length: historySize }, (_, index) => ({
          role: "assistant" as const,
          text: `settled answer ${index}`,
          turnId: `turn-${index}`,
        }))
        const base: Model = { ...initial("/work", "high"), entries }
        const surface = new Surface(setup.renderer, {
          key: () => undefined,
          resize: () => undefined,
        })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = {
            get transcriptChildren() {
              return surface.transcriptDiagnostics().rows
            },
          }
          const mounted = [...state.transcriptChildren]
          for (let index = 0; index < 2; index += 1)
            surface.update({ ...base, input: `next ${index}`, cursor: `next ${index}`.length })

          expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
          expect(state.transcriptChildren.every((child, index) => child === mounted[index])).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}
test("moves the bounded transcript window to older mounted entries and keeps it while typing", () =>
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
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(surface.transcriptDiagnostics().windowEnd).toBe(historySize - 100)
        expect(firstBefore).toBe(300)
        expect(firstAfter).toBeLessThan(300)
        expect(firstAfter).toBeGreaterThan(200)
        expect(surface.transcriptDiagnostics().rows.length).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
        surface.update({ ...base, input: "next", cursor: 4 })
        expect(surface.transcriptDiagnostics().windowEnd).toBe(historySize - 100)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("every durable user and assistant message remains reachable by paging to the top", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const count = 700
      const entries = Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `MESSAGE_${String(index).padStart(4, "0")}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `message-${index}`,
        turnId: `turn-${index}`,
      }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({ ...initial("/work", "high"), entries, items, scrollFollow: true })
        yield* openTui(() => setup.flush())
        const seen = new Set<number>()
        let previousPosition = ""
        for (let page = 0; page < 200 && seen.size < count; page += 1) {
          for (const match of setup.captureCharFrame().matchAll(/MESSAGE_(\d{4})/gu)) seen.add(Number(match[1]))
          const diagnostics = surface.transcriptDiagnostics()
          const position = `${diagnostics.windowEnd}:${surface.transcriptScroll.scrollTop}`
          if (position === previousPosition) break
          previousPosition = position
          setup.mockInput.pressKey("\u001b[5~")
          yield* openTui(() => setup.flush())
        }

        expect(seen.size).toBe(count)
        expect(seen.has(0)).toBe(true)
        expect(seen.has(count - 1)).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("bounded transcript keeps visible entries when a collapsed subagent overflows the entry budget", () => {
  const model = collapsedSubagentModel(30, maxMountedTranscriptEntries + 60)
  const bounded = boundedTranscriptModel(model)
  expect(bounded.items.length).toBeLessThanOrEqual(maxBoundedTranscriptItems)
  expect(bounded.items.some((item) => item._tag === "Entry")).toBe(true)
})
test("keeps the older transcript visible while a collapsed subagent streams children", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
      try {
        surface.update(collapsedSubagentModel(30, 150))
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("answer 29")

        surface.update(collapsedSubagentModel(30, 260))
        yield* openTui(() => setup.flush())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Subagent working")
        expect(frame).toContain("answer 29")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("keeps mounted renderables bounded inside one giant expanded subagent tree", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(300)
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        const state = {
          get transcriptChildren() {
            return surface.transcriptDiagnostics().rows
          },
        }
        expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptRows * 2)
        expect(state.transcriptChildren.length).toBeGreaterThan(0)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("├ ✓ $ cmd-299")
        expect(frame).not.toContain("cmd-100 ")
        expect(boundedTranscriptModel(model).items.length).toBeLessThanOrEqual(maxMountedTranscriptEntries)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("keeps the bounded suffix of an oversized tool tree when a trailing message arrives", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const giant = { ...giantSubagentModel(300), scrollFollow: true }
      const tail = { role: "assistant" as const, text: "TRAILING_MESSAGE", turnId: "turn-tail" }
      const grown: Model = {
        ...giant,
        entries: [...giant.entries, tail],
        items: [...giant.items, { _tag: "Entry", index: giant.entries.length, id: "tail-answer", turnId: "turn-tail" }],
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
      try {
        surface.update(giant)
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("cmd-299")

        surface.update(grown)
        yield* openTui(() => setup.flush())
        const frame = setup.captureCharFrame()

        expect(frame).toContain("TRAILING_MESSAGE")
        expect(frame).toContain("cmd-299")
        expect(boundedTranscriptModel(grown).items.some((item) => item._tag === "Block")).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
