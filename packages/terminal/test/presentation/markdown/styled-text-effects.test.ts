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

interface Probe {
  readonly transcriptScroll: { scrollTop: number; readonly scrollHeight: number }
  readonly transcriptViewport: { readonly mode: { readonly _tag: string } }
  dispatchTranscriptViewport: (event: { readonly _tag: string; readonly anchor?: unknown }) => void
  captureViewportAnchor: () => unknown
}

const detach = (probe: Probe) => {
  probe.dispatchTranscriptViewport({ _tag: "DetachCommanded", anchor: probe.captureViewportAnchor() })
}

test("expanding a block below the reading position does not move the viewport", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const tail = {
          _tag: "ToolCall" as const,
          id: "tail-tool",
          name: "bash",
          input: '{"command":"echo hi"}',
          status: "complete" as const,
          presentation: {
            family: "direct" as const,
            action: "shell" as const,
            activeLabel: "Running",
            completeLabel: "Ran",
          },
          detail: "echo hi",
          files: [],
          output: Array.from({ length: 40 }, (_, index) => `output line ${index}`).join("\n"),
        }
        const base: Model = {
          ...initial("/work", "medium"),
          entries: entries(60),
          blocks: [tail],
          items: [
            ...entries(60).map((_, index) => ({
              _tag: "Entry" as const,
              index,
              id: `entry-${index}`,
              turnId: `turn-${index}`,
            })),
            { _tag: "Block" as const, index: 0, id: "tail", turnId: "turn-tail" },
          ],
        }
        surface.update(base)
        yield* openTui(() => setup.flush())
        const probe = surface as unknown as Probe

        // Detach and park part-way up, so the tool block sits below the reading position.
        probe.transcriptScroll.scrollTop = Math.max(0, probe.transcriptScroll.scrollHeight - 200)
        detach(probe)
        expect(probe.transcriptViewport.mode._tag).toBe("Anchored")
        surface.update({ ...base, expandedRowKeys: [] })
        yield* openTui(() => setup.flush())
        const before = probe.transcriptScroll.scrollTop

        // Expanding the trailing tool grows content strictly below the anchor.
        surface.update({ ...base, expandedRowKeys: ["tool:tail-tool"] }, true)
        yield* openTui(() => setup.flush())

        expect(probe.transcriptScroll.scrollTop).toBe(before)
      } finally {
        surface.destroy()
      }
    }),
  ))

test("replacing the whole transcript while detached does not scroll the viewport", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const base: Model = {
          ...initial("/work", "medium"),
          entries: entries(60),
          items: entries(60).map((_, index) => ({
            _tag: "Entry" as const,
            index,
            id: `entry-${index}`,
            turnId: `turn-${index}`,
          })),
        }
        surface.update(base)
        yield* openTui(() => setup.flush())
        const probe = surface as unknown as Probe
        probe.transcriptScroll.scrollTop = Math.max(0, probe.transcriptScroll.scrollHeight - 200)
        detach(probe)
        expect(probe.transcriptViewport.mode._tag).toBe("Anchored")
        surface.update(base, true)
        yield* openTui(() => setup.flush())
        const before = probe.transcriptScroll.scrollTop

        // The anchored unit keys are all replaced, so the restore must not translate a total
        // content-height change into a scroll offset.
        const grown: Model = {
          ...base,
          entries: entries(120),
          items: entries(120).map((_, index) => ({
            _tag: "Entry" as const,
            index,
            id: `fresh-${index}`,
            turnId: `fresh-${index}`,
          })),
        }
        surface.update(grown, true)
        yield* openTui(() => setup.flush())

        expect(probe.transcriptScroll.scrollTop).toBe(before)
      } finally {
        surface.destroy()
      }
    }),
  ))
