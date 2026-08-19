import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { applyQueueDelta, replaceQueue, resetQueue } from "../../src/state/model/terminal-queue-state"
import { initial } from "../../src/state/model/terminal-state"
import { update } from "../../src/state/reducer/terminal-state-reducer"
import {
  openTui,
  _insertText,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./opentui-surface-characterization-14-support"
test("renders an inline hint on the selected queued row as the queue window moves", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 60, height: 14 }))
      const items = Array.from({ length: 8 }, (_, index) => ({ id: `q${index}`, prompt: `prompt number ${index}` }))
      const base = replaceQueue({ ...initial("/work", "medium"), busy: true, width: 60, height: 14 }, items)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({ ...base, queueSelection: "q0" })
        yield* openTui(() => setup.renderOnce())
        const top = setup.captureCharFrame()
        const topRows = top.split("\n")
        expect(top).not.toContain("queued 1/8")
        const topHintRow = topRows.find((row) => row.includes("Enter to steer"))
        expect(topHintRow).toContain("prompt")
        surface.update({ ...base, queueSelection: "q7" })
        yield* openTui(() => setup.renderOnce())
        const bottom = setup.captureCharFrame()
        const bottomRows = bottom.split("\n")
        expect(bottom).not.toContain("queued 8/8")
        const bottomHintRow = bottomRows.find((row) => row.includes("Enter to steer"))
        expect(bottomHintRow).toContain("prompt")
        expect(bottom).not.toContain("prompt number 0")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("shows the editing hint inline on the queued row being edited", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 80, height: 24 }, [
          { id: "a", prompt: "alpha" },
          { id: "b", prompt: "beta" },
        ]),
        queueSelection: "b",
        editingTurnId: "b",
        input: "beta edited",
        cursor: "beta edited".length,
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain("Editing queued")
        expect(frame).not.toContain("2/2")
        expect(frame).toContain("Enter save")
        expect(frame).toContain("Esc cancel")
        expect(rows.findIndex((row) => row.includes("Editing queued"))).toBe(
          rows.findIndex((row) => row.includes("beta")),
        )
        expect(surface.queueBox.height).toBe(4)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("keeps a steering row visible from local request through TenetKit acceptance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const base = resetQueue(
        {
          ...initial("/work", "medium"),
          busy: true,
          activeTurnId: "active",
          currentThreadId: "thread",
          width: 80,
          height: 24,
        },
        "thread",
        1,
        [{ id: "queued", prompt: "keep this visible" }],
      )
      const requested = {
        ...base,
        queueSelection: undefined,
        steeringRequests: [
          {
            requestId: "request",
            turnId: "active",
            text: "keep this visible",
            origin: "queue" as const,
            queuedTurnId: "queued",
          },
        ],
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(requested)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("steering: keep this visible")

        const withdrawn = applyQueueDelta(requested, "thread", 2, { _tag: "Removed", turnId: "queued" }, 0).model
        surface.update(withdrawn)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("steering: keep this visible")

        const accepted = {
          ...withdrawn,
          steeringRequests: [],
          pendingSteering: [
            {
              runId: "run",
              entryId: "entry",
              requestId: "request",
              turnId: "active",
              sequence: 1,
              text: "keep this visible",
            },
          ],
        }
        surface.update(accepted)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("steering: keep this visible")

        surface.update({ ...accepted, pendingSteering: [] })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).not.toContain("steering: keep this visible")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("removes a promoted prompt from the queue when it starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const base = resetQueue(
        { ...initial("/work", "medium"), busy: true, width: 80, height: 24, currentThreadId: "t" },
        "t",
        1,
        [
          { id: "a", prompt: "alpha" },
          { id: "b", prompt: "beta" },
        ],
      )
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("beta")
        const started = update(applyQueueDelta(base, "t", 2, { _tag: "Removed", turnId: "a" }).model, {
          _tag: "TurnStarted",
          turnId: "a",
          prompt: "alpha",
        })
        surface.update(started)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("beta")
        expect(frame).not.toContain("queued 1/1")
        expect(frame).not.toContain("queued 2/2")
        expect(frame).toContain("alpha")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("clamps an oversized focused queued prompt to the queue box with an indicator", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 40, height: 12 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 40, height: 12 }, [
          { id: "big", prompt: "x".repeat(400) },
        ]),
        queueSelection: "big",
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const text = (surface.queueText.content as unknown as { chunks: ReadonlyArray<{ text: string }> }).chunks
          .map((chunk) => chunk.text)
          .join("")
        expect(text).toContain("…")
        expect(text.length).toBeLessThan(40)
        const frame = setup.captureCharFrame()
        const row = frame.split("\n").find((candidate) => candidate.includes("Enter to steer"))
        expect(row).toContain("x")
        expect(row).not.toContain("Backspace to dequeue")
        expect(row).not.toContain("Ctrl+E to edit")
        expect(surface.queueBox.height).toBe(3)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
