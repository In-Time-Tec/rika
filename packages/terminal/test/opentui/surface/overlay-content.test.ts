import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { Surface } from "../../../src/opentui/surface/service"
import { initial, type Model } from "../../../src/state/model"
import { replaceQueue } from "../../../src/state/queue/model"
import { update } from "../../../src/state/reducer/model"

const queue = [
  { id: "queued-1", prompt: "first queued prompt" },
  { id: "queued-2", prompt: "second queued prompt" },
  { id: "queued-3", prompt: "selected queued prompt" },
] as const

test("reflows queued content and hint with stable queue identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 }))
      const queuedModel = replaceQueue(
        { ...initial("/work", "high"), width: 80, height: 24, input: "draft", cursor: 5 },
        queue,
      )
      const queueIdentity = queuedModel.queue
      let model: Model = { ...queuedModel, queueSelection: "queued-3" }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* Effect.tryPromise(() => setup.renderOnce())
        const tallText = surface.queueText.content
        const tallHint = surface.queueHint.content
        const tallFrame = setup.captureCharFrame()
        expect(tallFrame).toContain("first queued prompt")
        expect(tallFrame).toContain("second queued prompt")
        expect(tallFrame).toContain("selected queued prompt")
        expect(model.queue).toBe(queueIdentity)

        model = { ...model, height: 10 }
        surface.update(model)
        yield* Effect.tryPromise(() => setup.renderOnce())
        const shortFrame = setup.captureCharFrame()
        expect(model.queue).toBe(queueIdentity)
        expect(surface.queueText.content).not.toBe(tallText)
        expect(surface.queueHint.content).not.toBe(tallHint)
        expect(shortFrame).toContain("selected queued prompt")
        expect(shortFrame).not.toContain("first queued prompt")
        expect(surface.queueBox.height).toBe(3)

        const multiline = {
          ...model,
          input: "line one\nline two\nline three\nline four",
          cursor: "line one\nline two\nline three\nline four".length,
        }
        const pasted = update(multiline, { _tag: "Pasted", text: "pasted line one\npasted line two" })
        expect(pasted.pastedText).toHaveLength(1)
        expect(pasted.input).toContain("\uE000")
        model = pasted
        surface.update(model)
        yield* Effect.tryPromise(() => setup.renderOnce())
        const multilineFrame = setup.captureCharFrame()
        expect(model.queue).toBe(queueIdentity)
        expect(surface.queueText.content).not.toBe(tallText)
        expect(surface.queueHint.content).not.toBe(tallHint)
        expect(surface.inputBox.height).toBeGreaterThan(5)
        expect(multilineFrame).toContain("selected queued prompt")
        expect(multilineFrame).toContain("Pasted text #1 +2 lines")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
