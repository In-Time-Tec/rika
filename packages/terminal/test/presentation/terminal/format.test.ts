import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { initial, type Model } from "../../../src/state/model"
import { openTui } from "../transcript/projection.fixture"

const entries = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: `answer ${index}`,
    turnId: `turn-${index}`,
  }))

class ProbeSurface extends Surface {
  public get windowEnd(): number {
    return this.transcriptWindowEnd
  }
  public scrollTranscript(): void {
    this.handleTranscriptScroll()
  }
}

test("paging is requested on approach, before the user reaches the top edge", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new ProbeSurface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const base: Model = {
          ...initial("/work", "medium"),
          entries: entries(900),
          items: entries(900).map((_, index) => ({
            _tag: "Entry" as const,
            index,
            id: `entry-${index}`,
            turnId: `turn-${index}`,
          })),
        }
        surface.update(base)
        yield* openTui(() => setup.flush())
        const before = surface.windowEnd

        // Park well short of the top edge. The old design only paged at scrollTop <= 1,
        // so the user hit an unmaterialized edge and the restore jumped.
        surface.transcriptScroll.scrollTop = 20
        surface.scrollTranscript()
        yield* openTui(() => setup.flush())

        expect(surface.transcriptScroll.scrollTop).toBeGreaterThan(1)
        expect(surface.windowEnd).not.toBe(before)
      } finally {
        surface.destroy()
      }
    }),
  ))

test("a scroll reversal within the overscan margin does not remount transcript rows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new ProbeSurface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const base: Model = {
          ...initial("/work", "medium"),
          entries: entries(400),
          items: entries(400).map((_, index) => ({
            _tag: "Entry" as const,
            index,
            id: `entry-${index}`,
            turnId: `turn-${index}`,
          })),
        }
        surface.update(base)
        yield* openTui(() => setup.flush())
        const identity = () => surface.transcriptDiagnostics().rows

        const mounted = [...identity()]
        const start = surface.transcriptScroll.scrollTop
        surface.transcriptScroll.scrollTop = Math.max(0, start - 5)
        surface.scrollTranscript()
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTop = start
        surface.scrollTranscript()
        yield* openTui(() => setup.flush())

        const after = identity()
        expect(after.length).toBe(mounted.length)
        expect(after.every((row, index) => row === mounted[index])).toBe(true)
      } finally {
        surface.destroy()
      }
    }),
  ))
