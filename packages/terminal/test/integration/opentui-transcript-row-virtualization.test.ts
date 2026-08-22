import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import {
  mountedTranscriptRowBudget,
  transcriptRenderableBandRows,
} from "../../src/presentation/transcript/terminal-transcript-window"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { openTui } from "./opentui-surface-characterization-5-support"

const giantEntryModel = (lines: number): Model => ({
  ...initial("/work", "medium"),
  entries: [
    {
      role: "assistant",
      text: Array.from({ length: lines }, (_, index) => `physical-line-${index.toString().padStart(5, "0")}`).join(
        "\n",
      ),
      turnId: "turn-giant",
    },
  ],
  items: [{ _tag: "Entry", index: 0, id: "entry-giant", turnId: "turn-giant" }],
})

/**
 * Bun 1.4 on Linux stalls this test inside the renderer flush with a 50k-line entry: the same
 * test passes on Bun 1.3 and on macOS under 1.4. Skip it there until OpenTUI pins down the
 * Linux regression; the virtualization logic itself stays covered on every other platform.
 */
const rowVirtualizationRunnable = process.platform !== "linux"

test.skipIf(!rowVirtualizationRunnable)(
  "mounts only viewport bands for one 50k-line entry and preserves Home/End semantics",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(giantEntryModel(50_000))
          yield* openTui(() => setup.flush())

          const tail = surface.transcriptDiagnostics()
          const mountedCeiling =
            mountedTranscriptRowBudget(surface.transcriptScroll.viewport.height) + transcriptRenderableBandRows
          expect(tail.rowTotal).toBeGreaterThan(49_000)
          expect(tail.mountedPhysicalRows).toBeLessThanOrEqual(mountedCeiling)
          expect(Math.max(...tail.rows.map((row) => row.height))).toBeLessThanOrEqual(transcriptRenderableBandRows)
          expect(setup.captureCharFrame()).toContain("physical-line-49999")
          const tailRows = [...tail.rows]

          surface.transcriptScroll.scrollTo(42)
          yield* openTui(() => setup.flush())

          const middle = surface.transcriptDiagnostics()
          expect(setup.captureCharFrame()).toContain("physical-line-00042")
          expect(middle.spacerRowsBefore).toBeLessThanOrEqual(surface.transcriptScroll.scrollTop)
          expect(middle.spacerRowsBefore + middle.mountedPhysicalRows + middle.spacerRowsAfter).toBe(middle.rowTotal)
          expect(middle.mountedPhysicalRows).toBeLessThanOrEqual(mountedCeiling)

          setup.mockInput.pressKey("\u001b[H")
          yield* openTui(() => setup.flush())

          const head = surface.transcriptDiagnostics()
          expect(surface.transcriptScroll.scrollTop).toBe(0)
          expect(setup.captureCharFrame()).toContain("physical-line-00000")
          expect(head.mountedPhysicalRows).toBeLessThanOrEqual(mountedCeiling)
          expect(tailRows.every((row) => row.isDestroyed)).toBe(true)

          setup.mockInput.pressKey("\u001b[F")
          yield* openTui(() => setup.flush())

          const followed = surface.transcriptDiagnostics()
          expect(followed.following).toBe(true)
          expect(setup.captureCharFrame()).toContain("physical-line-49999")
          expect(followed.mountedPhysicalRows).toBeLessThanOrEqual(mountedCeiling)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ),
)
