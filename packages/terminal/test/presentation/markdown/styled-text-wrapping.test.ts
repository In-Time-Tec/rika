import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../src/opentui/surface/service"
import { initial, type Model } from "../../../src/state/model"
import { maxMountedTranscriptEntries } from "../../../src/opentui/rendering/transcript/window"
import { openTui } from "../transcript/projection.fixture"

const entryModel = (count: number): Model => {
  const entries = Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: `answer ${index}`,
    turnId: `turn-${index}`,
  }))
  return {
    ...initial("/work", "medium"),
    entries,
    items: entries.map((_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `entry-${index}`,
      turnId: `turn-${index}`,
    })),
  }
}

test("scrolls a large transcript back to its oldest unit without any mounted-window stall", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const model = entryModel(maxMountedTranscriptEntries * 2)
        surface.update(model)
        yield* openTui(() => setup.flush())
        for (let steps = 0; steps < 400; steps += 1) {
          setup.mockInput.pressKey("\u001b[5~")
          yield* openTui(() => setup.flush())
          if (setup.captureCharFrame().includes("answer 0") === true) break
        }
        expect(surface.transcriptScroll.scrollTop).toBe(0)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("answer 0")
        expect(surface.mountedTranscriptRowCount()).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("the scrollbar reports the full virtual document, not the mounted window", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const model = entryModel(maxMountedTranscriptEntries * 2)
        surface.update(model)
        yield* openTui(() => setup.flush())
        const diagnostics = surface.transcriptDiagnostics()
        expect(surface.transcriptScrollbar.scrollSize).toBe(diagnostics.virtualScrollHeight)
        expect(surface.transcriptScrollbar.scrollSize).toBeGreaterThan(surface.transcriptScroll.scrollHeight)
        expect(Math.abs(surface.transcriptScrollbar.scrollPosition - diagnostics.virtualScrollTop)).toBeLessThanOrEqual(
          1,
        )
        expect(surface.transcriptScrollbar.visible).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("Home jumps to the oldest mounted content and End re-follows the live tail", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const model = entryModel(500)
        surface.update(model)
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey("\u001b[H")
        yield* openTui(() => setup.flush())
        expect(surface.transcriptScroll.scrollTop).toBe(0)
        expect(setup.captureCharFrame()).toContain("answer 0")
        setup.mockInput.pressKey("\u001b[F")
        yield* openTui(() => setup.flush())
        const diagnostics = surface.transcriptDiagnostics()
        expect(surface.transcriptScroll.scrollTop).toBeGreaterThanOrEqual(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 1,
        )
        expect(diagnostics.following).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

// Defect #361 characterization: Home/End and anchor-preserving viewport updates.
// The frame's first content row is the top visible anchor; the scrollbar column
// is stripped so scrollbar-thumb movement never counts as viewport movement.
const firstContentRow = (frame: string): string | undefined =>
  frame
    .split("\n")
    .map((line) => line.slice(0, -1).trim())
    .find((line) => line.length > 0)

const homeKey = (): string => String.fromCharCode(27) + "[H"
const endKey = (): string => String.fromCharCode(27) + "[F"

const homeTranscript = (): Model => {
  const entries: Model["entries"] = [
    { role: "user", text: "oldest-user-marker row", turnId: "turn-oldest" },
    { role: "assistant", text: "oldest-assistant-marker row", turnId: "turn-oldest" },
  ]
  const blocks: Model["blocks"] = [
    {
      _tag: "ToolCall",
      id: "big-root",
      name: "task",
      input: "{}",
      status: "complete",
      presentation: { family: "agent", action: "task", activeLabel: "Working", completeLabel: "Done" },
      detail: "big-root",
      files: [],
    },
  ]
  const items: Model["items"] = [
    { _tag: "Entry", index: 0, id: "entry-oldest-user", turnId: "turn-oldest" },
    { _tag: "Entry", index: 1, id: "entry-oldest-assistant", turnId: "turn-oldest" },
    { _tag: "Block", index: 0, id: "tool:big-root", turnId: "turn-big" },
  ]
  const childCount = 700
  for (let index = 0; index < childCount; index += 1) {
    blocks.push({
      _tag: "ToolCall",
      id: `big-child-${index}`,
      name: "read",
      input: "{}",
      status: "complete",
      presentation: { family: "explore", action: "read", activeLabel: "Reading", completeLabel: "Read" },
      detail: `big-child-${index}`,
      files: [],
    })
    items.push({
      _tag: "Block",
      index: blocks.length - 1,
      id: `tool:big-child-${index}`,
      turnId: "turn-big",
      parentId: "big-root",
    })
  }
  const totalItems = 20_000
  for (let index = items.length; index < totalItems; index += 1) {
    const tailIndex = index - (childCount + 3)
    entries.push({ role: "assistant", text: `tail-answer ${tailIndex}`, turnId: `turn-tail-${tailIndex}` })
    items.push({ _tag: "Entry", index: entries.length - 1, id: `tail-${tailIndex}`, turnId: `turn-tail-${tailIndex}` })
  }
  return { ...initial("/work", "medium"), entries, blocks, items, expandedRowKeys: ["tool:big-root"] }
}

test("Home shows the oldest user and assistant messages in a twenty-thousand-item transcript", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(homeTranscript())
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey(homeKey())
        yield* openTui(() => setup.flush())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("oldest-user-marker")
        expect(frame).toContain("oldest-assistant-marker")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("End restores follow mode after Home", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(homeTranscript())
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey(homeKey())
        yield* openTui(() => setup.flush())
        expect(surface.transcriptDiagnostics().following).toBe(false)
        setup.mockInput.pressKey(endKey())
        yield* openTui(() => setup.flush())
        const diagnostics = surface.transcriptDiagnostics()
        expect(diagnostics.following).toBe(true)
        expect(surface.transcriptScroll.scrollTop).toBeGreaterThanOrEqual(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 1,
        )
        expect(setup.captureCharFrame()).toContain("tail-answer 19296")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("history insertion preserves the top visible anchor", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const baseEntries: Model["entries"] = Array.from({ length: 200 }, (_, index) => ({
          role: "assistant" as const,
          text: `base-answer ${index}`,
          turnId: `turn-base-${index}`,
        }))
        const baseItems: Model["items"] = baseEntries.map((_, index) => ({
          _tag: "Entry" as const,
          index,
          id: `base-${index}`,
          turnId: `turn-base-${index}`,
        }))
        let model: Model = { ...initial("/work", "medium"), entries: baseEntries, items: baseItems }
        surface.update(model)
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey(homeKey())
        yield* openTui(() => setup.flush())
        const anchor = firstContentRow(setup.captureCharFrame())
        expect(anchor).toBe("base-answer 0")
        const historyCount = 650
        const historyEntries: Model["entries"] = Array.from({ length: historyCount }, (_, index) => ({
          role: "assistant" as const,
          text: `history-answer ${index}`,
          turnId: `turn-history-${index}`,
        }))
        model = {
          ...model,
          entries: [...historyEntries, ...model.entries],
          items: [
            ...historyEntries.map(
              (_, index): Model["items"][number] => ({
                _tag: "Entry" as const,
                index,
                id: `history-${index}`,
                turnId: `turn-history-${index}`,
              }),
            ),
            ...model.items.map(
              (item): Model["items"][number] =>
                typeof item === "object" && item !== null && "index" in item && (item as { _tag?: unknown })._tag === "Entry"
                  ? { ...(item as { _tag: "Entry"; index: number }), index: (item as { index: number }).index + historyCount }
                  : item,
            ),
          ],
        }
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(firstContentRow(setup.captureCharFrame())).toBe(anchor)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("streaming below a detached viewport does not move the visible anchor", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        const baseEntries: Model["entries"] = Array.from({ length: 200 }, (_, index) => ({
          role: "assistant" as const,
          text: `base-answer ${index}`,
          turnId: `turn-base-${index}`,
        }))
        let model: Model = {
          ...initial("/work", "medium"),
          entries: baseEntries,
          items: baseEntries.map((_, index): Model["items"][number] => ({
            _tag: "Entry" as const,
            index,
            id: `base-${index}`,
            turnId: `turn-base-${index}`,
          })),
        }
        surface.update(model)
        yield* openTui(() => setup.flush())
        setup.mockInput.pressKey(homeKey())
        yield* openTui(() => setup.flush())
        const anchor = firstContentRow(setup.captureCharFrame())
        const scrollTop = surface.transcriptScroll.scrollTop
        for (let index = 200; index < 260; index += 1) {
          model = {
            ...model,
            entries: [...model.entries, { role: "assistant", text: `streamed ${index}`, turnId: `turn-stream-${index}` }],
            items: [
              ...model.items,
              { _tag: "Entry", index, id: `streamed-${index}`, turnId: `turn-stream-${index}` },
            ],
          }
          surface.update(model)
        }
        yield* openTui(() => setup.flush())
        expect(surface.transcriptDiagnostics().following).toBe(false)
        expect(surface.transcriptScroll.scrollTop).toBe(scrollTop)
        expect(firstContentRow(setup.captureCharFrame())).toBe(anchor)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
