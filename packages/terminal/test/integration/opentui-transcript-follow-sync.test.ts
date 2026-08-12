import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { openTui } from "./opentui-surface-characterization-5-support"

const transcript = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: `settled answer ${index}`,
    turnId: `turn-${index}`,
  }))

interface ScrollbarProbe {
  readonly transcriptViewport: { readonly mode: { readonly _tag: string } }
  readonly transcriptScrollbar: {
    scrollSize: number
    viewportSize: number
    scrollPosition: number
    readonly slider: { readonly screenX: number; readonly screenY: number }
  }
  syncTranscriptScrollbar: () => void
}

test("treats every scrollbar write inside a transcript sync as programmatic, not as a user scroll", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const base: Model = { ...initial("/work", "medium"), entries: transcript(60) }
        surface.update(base)
        yield* openTui(() => setup.flush())
        const probe = surface as unknown as ScrollbarProbe
        expect(probe.transcriptViewport.mode._tag).toBe("Following")

        // syncTranscriptScrollbar writes scrollSize, viewportSize and scrollPosition. Each of
        // those setters re-enters the scrollbar onChange handler. Record which of those writes
        // are seen while the programmatic guard is engaged: it must be all of them, otherwise a
        // sync is misread as a user scroll and detaches the transcript from Following.
        const seenWhileGuarded: Array<boolean> = []
        const guard = () => (surface as unknown as { readonly scrollbarSyncing: boolean }).scrollbarSyncing
        const scrollbar = probe.transcriptScrollbar
        const observe = <K extends "scrollSize" | "viewportSize" | "scrollPosition">(key: K) => {
          let value = scrollbar[key]
          Object.defineProperty(scrollbar, key, {
            configurable: true,
            get: () => value,
            set: (next: number) => {
              seenWhileGuarded.push(guard())
              value = next
            },
          })
        }
        observe("scrollSize")
        observe("viewportSize")
        observe("scrollPosition")

        probe.syncTranscriptScrollbar()

        expect(seenWhileGuarded.length).toBeGreaterThanOrEqual(3)
        expect(seenWhileGuarded.every((guarded) => guarded)).toBe(true)
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
        const probe = surface as unknown as ScrollbarProbe
        probe.syncTranscriptScrollbar()
        expect(probe.transcriptViewport.mode._tag).toBe("Following")
        yield* openTui(() =>
          setup.mockMouse.click(probe.transcriptScrollbar.slider.screenX, probe.transcriptScrollbar.slider.screenY),
        )
        yield* openTui(() => setup.flush())
        expect(probe.transcriptViewport.mode._tag).toBe("Anchored")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
