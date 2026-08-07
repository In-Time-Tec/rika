import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { maxMountedTranscriptEntries } from "../../src/opentui/rendering/opentui-render-transcript-window"
import { maxMountedTranscriptRows } from "../../src/presentation/transcript/terminal-transcript-window"

import { openTui, _insertText, _streamingShell, giantSubagentModel } from "./opentui-surface-characterization-2-support"
test("keeps a large expanded subagent tree in one mounted row window", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(maxMountedTranscriptEntries - 300)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/cmd-(\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        const state = surface.transcriptDiagnostics()
        expect(state.windowEnd).toBe(model.items.length)
        expect(state.rowTotal).toBeGreaterThan(240)
        expect(state.rowTotal).toBeLessThan(maxMountedTranscriptRows)
        expect(Number(/cmd-(\d+)/.exec(setup.captureCharFrame())?.[1])).toBe(firstBefore)
        expect(state.rows.length).toBeLessThanOrEqual(maxMountedTranscriptRows * 2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("keeps the scrollbar geometry consistent across backward transcript-window growth", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(maxMountedTranscriptEntries + 300)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(surface.transcriptScrollbar.scrollSize).toBe(surface.transcriptScroll.scrollHeight)
        expect(surface.transcriptScrollbar.viewportSize).toBeGreaterThanOrEqual(1)
        expect(surface.transcriptScrollbar.scrollPosition).toBe(surface.transcriptScroll.scrollTop)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
