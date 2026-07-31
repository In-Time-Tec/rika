import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { initial, type Model } from "../../src/state/model/terminal-state"
import {
  openTui,
  _insertText,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./opentui-surface-characterization-6.test-support"
test("mounts entries appended below a detached transcript that fits the mount budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 40 }, (_, index) => ({
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
      const state = surface as unknown as { readonly transcriptWindowEnd: number }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        const heightBefore = surface.transcriptScroll.scrollHeight

        const grownEntries = [
          ...entries,
          ...Array.from({ length: 20 }, (_, index) => ({
            role: "assistant" as const,
            text: `answer ${40 + index}`,
            turnId: `turn-${40 + index}`,
          })),
        ]
        const grownItems = grownEntries.map((_, index) => ({
          _tag: "Entry" as const,
          index,
          id: `answer-${index}`,
          turnId: `turn-${index}`,
        }))
        surface.update({ ...base, entries: grownEntries, items: grownItems })
        yield* openTui(() => setup.flush())

        // The appended entries mount below the viewport: the window tracks the tail
        // and the content grows, while the detached reading position stays put.
        expect(state.transcriptWindowEnd).toBe(60)
        expect(surface.transcriptScroll.scrollHeight).toBeGreaterThan(heightBefore)
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("reports prepend anchor geometry without requesting another page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const requested = new Array<number>()
      const geometry = new Array<number>()
      const entries = Array.from({ length: 200 }, (_, index) => ({
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
        scroll: (offset) => requested.push(offset),
        scrollGeometry: (offset) => geometry.push(offset),
      })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScrollbar.scrollPosition = Math.max(0, surface.transcriptScroll.scrollTop - 1)
        yield* openTui(() => setup.flush())
        yield* Effect.yieldNow
        requested.length = 0
        const older = Array.from({ length: 50 }, (_, index) => ({
          role: "assistant" as const,
          text: `older ${index}`,
          turnId: `older-${index}`,
        }))
        surface.update(
          {
            ...base,
            entries: [...older, ...entries],
            items: [
              ...older.map((_, index) => ({
                _tag: "Entry" as const,
                index,
                id: `older-${index}`,
                turnId: `older-${index}`,
              })),
              ...items.map((item) => Object.assign({}, item, { index: item.index + older.length })),
            ],
          },
          true,
        )
        yield* openTui(() => setup.flush())
        expect(requested).toEqual([])
        expect(geometry).toHaveLength(1)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
