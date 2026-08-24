import { BoxRenderable, SystemClock } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import * as TranscriptUnitOrder from "@rika/transcript/transcript-unit-order"
import type { Unit } from "@rika/transcript/transcript-unit"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { projectUnits } from "../../../src/presentation/transcript/projection"
import { Surface } from "../../../src/opentui/surface/service"
import { TranscriptPane } from "../../../src/opentui/surface/transcript/pane"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"
import { openTui } from "./projection.fixture"

const transcriptUnits = (count: number): ReadonlyArray<Unit> =>
  Array.from({ length: count }, (_, index): ReadonlyArray<Unit> => {
    const turnId = `preview-${index}`
    return [
      {
        key: `${turnId}:user`,
        turnId,
        order: TranscriptUnitOrder.unitOrder(`${turnId}:user`, index * 2),
        revision: index * 2,
        content: { _tag: "Entry", role: "user", text: `Question ${index} with enough text to exercise wrapping.` },
      },
      {
        key: `${turnId}:assistant`,
        turnId,
        order: TranscriptUnitOrder.unitOrder(`${turnId}:assistant`, index * 2 + 1),
        revision: index * 2 + 1,
        content: {
          _tag: "Entry",
          role: "assistant",
          text: `Answer ${index}. The preview uses the same measured transcript renderables as the main surface.`,
        },
      },
    ]
  }).flat()

const notificationUnits = (count: number): ReadonlyArray<Unit> => {
  const turnId = "preview-history"
  const notifications = Array.from({ length: count - 2 }, (_, index): Unit => {
    const key = `${turnId}:notification:${index}`
    return {
      key,
      turnId,
      order: TranscriptUnitOrder.unitOrder(key, index),
      revision: index + 1,
      content: {
        _tag: "Block",
        block: { _tag: "Notification", title: `Historical entry ${index}`, detail: `history ${index}` },
      },
    }
  })
  const userKey = `${turnId}:user`
  const finalKey = `${turnId}:assistant`
  return [
    {
      key: userKey,
      turnId,
      order: TranscriptUnitOrder.unitOrder(userKey, -1),
      revision: 0,
      content: { _tag: "Entry", role: "user", text: "Historical prompt" },
    },
    ...notifications,
    {
      key: finalKey,
      turnId,
      order: TranscriptUnitOrder.unitOrder(finalKey, count - 2),
      revision: count - 1,
      executionOutcome: { status: "complete" },
      content: { _tag: "Entry", role: "assistant", text: "Historical transcript complete" },
    },
  ]
}

const browserModel = (units: ReadonlyArray<Unit>, width = 140, height = 40): Model => {
  const transcript = projectUnits(initial("/workspace", "medium"), units)
  return {
    ...transcript,
    width,
    height,
    currentThreadId: "main-thread",
    threadSwitcher: { open: true, query: "", selected: 0, kind: "switch" },
    threads: [
      {
        id: "preview-thread",
        title: "Selected thread title",
        workspace: "/other/workspace",
        pinned: false,
        archived: false,
        status: "idle",
        unread: true,
        lastActivityAt: 0,
      },
    ],
    threadPreview: {
      _tag: "Ready",
      value: { threadId: "preview-thread", requestId: 1, units },
    },
  }
}

const text = (rows: ReturnType<TranscriptPane["diagnostics"]>["rows"]): ReadonlyArray<string> =>
  rows.map((row) => row.content.chunks.map((chunk) => chunk.text).join(""))

test("two transcript panes produce identical keyed renderables for the same document and width", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 30 }))
      const clock = new SystemClock()
      const first = new TranscriptPane(setup.renderer, { clock })
      const second = new TranscriptPane(setup.renderer, { clock })
      const firstRoot = new BoxRenderable(setup.renderer, { width: 60, height: 30 })
      const secondRoot = new BoxRenderable(setup.renderer, { width: 60, height: 30 })
      first.mount(firstRoot)
      second.mount(secondRoot)
      const model = { ...projectUnits(initial("/workspace", "medium"), transcriptUnits(8)), width: 60, height: 30 }
      try {
        first.update(model)
        second.update(model)
        expect(first.diagnostics().keys).toEqual(second.diagnostics().keys)
        expect(text(first.diagnostics().rows)).toEqual(text(second.diagnostics().rows))
        expect(first.diagnostics().rowTotal).toBe(second.diagnostics().rowTotal)
      } finally {
        first.destroy()
        second.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("thread preview starts at the real tail, scrolls independently to both edges, and owns its scrollbar geometry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 110, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const readyModel = browserModel(notificationUnits(440), 110, 30)
        surface.update({
          ...readyModel,
          threadPreview: { _tag: "Loading", threadId: "preview-thread", requestId: 1 },
        })
        yield* openTui(() => setup.flush())
        surface.update(readyModel)
        yield* openTui(() => setup.flush())
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Thread Preview")
        expect(frame).toContain("Historical transcript complete")
        expect(frame).not.toContain("unread · idle")
        expect(frame.match(/Selected thread title/g)).toHaveLength(1)
        const mainBefore = surface.transcriptScroll.scrollTop
        const tail = surface.threadPreviewDiagnostics()
        expect(tail.scrollTop).toBe(tail.scrollHeight - tail.viewportHeight)
        expect(tail.scrollbarPosition).toBe(tail.scrollbarSize - tail.scrollbarViewportSize)

        yield* openTui(() =>
          setup.mockMouse.scroll(
            tail.bounds.x + Math.floor(tail.bounds.width / 2),
            tail.bounds.y + Math.floor(tail.bounds.height / 2),
            "up",
            { delayMs: 0 },
          ),
        )
        yield* openTui(() => setup.flush())
        const scrolled = surface.threadPreviewDiagnostics()
        expect(scrolled.following).toBe(false)
        expect(scrolled.scrollTop).toBeLessThan(tail.scrollTop)
        expect(surface.transcriptScroll.scrollTop).toBe(mainBefore)

        setup.mockInput.pressKey("\u001b[H")
        yield* openTui(() => setup.flush())
        expect(surface.threadPreviewDiagnostics().scrollTop).toBe(0)
        setup.mockInput.pressKey("\u001b[F")
        yield* openTui(() => setup.flush())
        const restoredTail = surface.threadPreviewDiagnostics()
        expect(restoredTail.scrollTop).toBe(restoredTail.scrollHeight - restoredTail.viewportHeight)
        expect(restoredTail.scrollbarPosition).toBe(restoredTail.scrollbarSize - restoredTail.scrollbarViewportSize)

        const browser = surface as unknown as {
          readonly threadBrowser: { readonly transcript: TranscriptPane }
        }
        const scrollbar = browser.threadBrowser.transcript.scrollbar
        yield* openTui(() =>
          setup.mockMouse.scroll(
            scrollbar.slider.screenX,
            scrollbar.slider.screenY + Math.floor(scrollbar.slider.height / 2),
            "up",
            { delayMs: 0 },
          ),
        )
        yield* openTui(() => setup.flush())
        expect(surface.threadPreviewDiagnostics().scrollTop).toBeLessThan(restoredTail.scrollTop)
        expect(surface.transcriptScroll.scrollTop).toBe(mainBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("one scrollbar jump reaches the oldest content beyond the mounted item window", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 110, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(browserModel(notificationUnits(800), 110, 30))
        yield* openTui(() => setup.flush())
        const browser = surface as unknown as {
          readonly threadBrowser: { readonly transcript: TranscriptPane }
        }
        const scrollbar = browser.threadBrowser.transcript.scrollbar
        yield* openTui(() => setup.mockMouse.click(scrollbar.slider.screenX, scrollbar.slider.screenY))
        yield* openTui(() => setup.flush())
        expect(surface.threadPreviewDiagnostics().scrollbarPosition).toBe(0)
        expect(setup.captureCharFrame()).toContain("Historical prompt")

        yield* openTui(() =>
          setup.mockMouse.drag(
            scrollbar.slider.screenX,
            scrollbar.slider.screenY,
            scrollbar.slider.screenX,
            scrollbar.slider.screenY + scrollbar.slider.height,
          ),
        )
        yield* openTui(() => setup.flush())
        const tail = surface.threadPreviewDiagnostics()
        expect(tail.scrollTop).toBe(tail.scrollHeight - tail.viewportHeight)
        expect(tail.scrollbarPosition).toBe(tail.scrollbarSize - tail.scrollbarViewportSize)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("thread preview request identity rejects stale A to B to A results", () => {
  const requestedA1 = update(initial("/workspace", "medium"), {
    _tag: "ThreadPreviewRequested",
    threadId: "a",
    requestId: 1,
  })
  const requestedB = update(requestedA1, { _tag: "ThreadPreviewRequested", threadId: "b", requestId: 2 })
  const requestedA2 = update(requestedB, { _tag: "ThreadPreviewRequested", threadId: "a", requestId: 3 })
  const stale = update(requestedA2, {
    _tag: "ThreadPreviewLoaded",
    threadId: "a",
    requestId: 1,
    units: transcriptUnits(1),
  })
  expect(stale).toBe(requestedA2)
  const current = update(stale, {
    _tag: "ThreadPreviewLoaded",
    threadId: "a",
    requestId: 3,
    units: transcriptUnits(1),
  })
  expect(current.threadPreview._tag).toBe("Ready")
  if (current.threadPreview._tag === "Ready") expect(current.threadPreview.value.requestId).toBe(3)

  const staleFailure = update(requestedA2, {
    _tag: "ThreadPreviewFailed",
    threadId: "a",
    requestId: 1,
    message: "stale",
  })
  expect(staleFailure).toBe(requestedA2)
  const currentFailure = update(staleFailure, {
    _tag: "ThreadPreviewFailed",
    threadId: "a",
    requestId: 3,
    message: "current",
  })
  expect(currentFailure.threadPreview).toEqual({
    _tag: "Failed",
    threadId: "a",
    requestId: 3,
    message: "current",
  })
})

test("requesting B replaces the ready A preview with loading state", () => {
  const requestedA = update(initial("/workspace", "medium"), {
    _tag: "ThreadPreviewRequested",
    threadId: "a",
    requestId: 1,
  })
  const readyA = update(requestedA, {
    _tag: "ThreadPreviewLoaded",
    threadId: "a",
    requestId: 1,
    units: transcriptUnits(1),
  })
  const requestedB = update(readyA, {
    _tag: "ThreadPreviewRequested",
    threadId: "b",
    requestId: 2,
  })
  expect(requestedB.threadPreview).toEqual({ _tag: "Loading", threadId: "b", requestId: 2 })
})
