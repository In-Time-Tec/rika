import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { Surface } from "../../../src/opentui/surface/service"
import { mountedTranscriptRowBudget, transcriptRenderableBandRows } from "../../../src/presentation/transcript/window"
import { initial, type Model } from "../../../src/state/model"
import { openTui } from "../transcript/projection.fixture"

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

test("mounts only viewport bands for one 50k-line entry and preserves Home/End semantics", () =>
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
  ))

test("shows omitted group membership and clears history feedback after a complete reload", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const base: Model = {
        ...initial("/work", "medium"),
        blocks: [
          {
            _tag: "SubagentGroup",
            id: "group",
            name: "Task",
            status: "complete",
            settled: true,
            memberIds: ["card-0", "card-1", "card-2", "card-3"],
            counts: {
              total: 4,
              complete: 4,
              queued: 0,
              running: 0,
              waiting: 0,
              cancelling: 0,
              failed: 0,
              cancelled: 0,
            },
          },
          ...Array.from({ length: 4 }, (_, index) => ({
            _tag: "SubagentCard" as const,
            id: `card-${index}`,
            name: `AGENT_${index}`,
            prompt: "Review",
            promptTruncated: false,
            summary: "",
            status: "complete" as const,
            activity: [],
          })),
        ],
        items: [
          { _tag: "Block", index: 0, id: "group-unit" },
          ...Array.from({ length: 4 }, (_, index) => ({
            _tag: "Block" as const,
            index: index + 1,
            id: `card-unit-${index}`,
            parentId: "group",
          })),
        ],
        expandedRowKeys: ["subagent-group:group"],
      }
      try {
        surface.update({
          ...base,
          transcriptTruncated: true,
          items: base.items.filter((item) => item.index === 0 || item.index >= 3),
        })
        yield* openTui(() => setup.flush())
        const partial = setup.captureCharFrame()
        expect(partial).toContain("4 agents finished")
        expect(partial).toContain("2 member cards outside this window")
        expect(partial).toContain("Loading earlier history")
        expect(partial).toContain("AGENT_2")
        expect(partial).toContain("AGENT_3")
        expect(partial).not.toContain("AGENT_0")
        surface.update(base)
        yield* openTui(() => setup.flush())
        const complete = setup.captureCharFrame()
        expect(complete).not.toContain("outside this window")
        expect(complete).not.toContain("Loading earlier history")
        for (let index = 0; index < 4; index++) expect(complete).toContain(`AGENT_${index}`)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
