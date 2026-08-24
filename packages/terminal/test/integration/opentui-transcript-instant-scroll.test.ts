import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { maxMountedTranscriptEntries } from "../../src/opentui/rendering/opentui-render-transcript-window"
import { openTui } from "./opentui-surface-characterization-5-support"

const entryModel = (count: number): Model => {
  const entries = Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: `answer ${index}`,
    turnId: `turn-${index}`,
  }))
  return {
    ...initial("/work", "medium"),
    entries,
    items: entries.map((_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `entry-${index}`,
      turnId: `turn-${index}`,
    })),
  }
}

test("scrolls a large transcript back to its oldest unit without any mounted-window stall", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const model = entryModel(maxMountedTranscriptEntries * 2)
        surface.update(model)
        yield* openTui(() => setup.flush())
        for (let steps = 0; steps < 400; steps += 1) {
          setup.mockInput.pressKey("\u001b[5~")
          yield* openTui(() => setup.flush())
          if (setup.captureCharFrame().includes("answer 0") === true) break
        }
        expect(surface.transcriptScroll.scrollTop).toBe(0)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("answer 0")
        expect(surface.mountedTranscriptRowCount()).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("the scrollbar reports the full virtual document, not the mounted window", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const model = entryModel(maxMountedTranscriptEntries * 2)
        surface.update(model)
        yield* openTui(() => setup.flush())
        const diagnostics = surface.transcriptDiagnostics()
        expect(surface.transcriptScrollbar.scrollSize).toBe(diagnostics.virtualScrollHeight)
        expect(surface.transcriptScrollbar.scrollSize).toBeGreaterThan(surface.transcriptScroll.scrollHeight)
        expect(Math.abs(surface.transcriptScrollbar.scrollPosition - diagnostics.virtualScrollTop)).toBeLessThanOrEqual(
          1,
        )
        expect(surface.transcriptScrollbar.visible).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("Home jumps to the oldest mounted content and End re-follows the live tail", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const model = entryModel(500)
        surface.update(model)
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey("\u001b[H")
        yield* openTui(() => setup.flush())
        expect(surface.transcriptScroll.scrollTop).toBe(0)
        expect(setup.captureCharFrame()).toContain("answer 0")
        setup.mockInput.pressKey("\u001b[F")
        yield* openTui(() => setup.flush())
        const diagnostics = surface.transcriptDiagnostics()
        expect(surface.transcriptScroll.scrollTop).toBeGreaterThanOrEqual(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 1,
        )
        expect(diagnostics.following).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
