import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { initial, type Model } from "../../../src/state/model"
import { openTui } from "../transcript/projection.fixture"

const transcript = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: `settled answer ${index}`,
    turnId: `turn-${index}`,
  }))

test("treats every scrollbar write inside a transcript sync as programmatic, not as a user scroll", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const base: Model = { ...initial("/work", "medium"), entries: transcript(60) }
        surface.update(base)
        yield* openTui(() => setup.flush())
        expect(surface.transcriptDiagnostics().following).toBe(true)
        surface.update({ ...base, entries: transcript(90), width: 90, height: 26 })
        yield* openTui(() => setup.flush())
        expect(surface.transcriptDiagnostics().following).toBe(true)
        expect(surface.transcriptScrollbar.scrollPosition).toBeGreaterThan(0)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("accepts a user scrollbar change immediately after synchronizing geometry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({ ...initial("/work", "medium"), entries: transcript(60) })
        yield* openTui(() => setup.flush())
        expect(surface.transcriptDiagnostics().following).toBe(true)
        yield* openTui(() =>
          setup.mockMouse.click(surface.transcriptScrollbar.slider.screenX, surface.transcriptScrollbar.slider.screenY),
        )
        yield* openTui(() => setup.flush())
        expect(surface.transcriptDiagnostics().following).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
