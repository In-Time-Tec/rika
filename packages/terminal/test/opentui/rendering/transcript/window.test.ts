import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Clock, Effect } from "effect"
import stringWidth from "string-width"
import { Surface } from "../../../../src/opentui/surface/service"
import {
  boundedTranscriptModel,
  maxBoundedTranscriptItems,
  maxMountedTranscriptEntries,
} from "../../../../src/opentui/rendering/transcript/window"
import * as transcriptWindow from "../../../../src/opentui/rendering/transcript/window"
import type { Model } from "../../../../src/state/model"
import { update } from "../../../../src/state/reducer/model"
import type { TranscriptBlock, TranscriptItem } from "../../../../src/state/transcript/model"
import { handlers, model } from "./window.fixture"
import { openTui, styledTextValue } from "../../../support/surface/transcript/pane-geometry.fixture"

test("reflows mounted assistant markdown when the terminal width shrinks", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 66 }))
      const surface = new Surface(setup.renderer, handlers())
      try {
        const markdown = [
          "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega repeat every paragraph word",
          "",
          "| Layer | Owner | Detail |",
          "|---|---|---|",
          "| durable execution | Generalist | preserves every table word while wrapping narrow cells |",
          "",
          "```ts",
          "const blankRowRhythmMarker = preserveEveryCodeTokenAcrossTheNarrowTerminalWidth",
          "```",
        ].join("\n")
        const wide = model({
          width: 200,
          height: 66,
          entries: [{ role: "assistant", text: markdown, turnId: "turn-1" }],
        })
        surface.update(wide)
        const rows = () => surface.transcriptDiagnostics().rows
        const text = () =>
          rows()
            .map((row) => styledTextValue(row.content))
            .join("\n")
        const mounted = [...rows()]
        expect(
          text()
            .split("\n")
            .some((line) => stringWidth(line) > 100),
        ).toBe(true)

        surface.update(update(wide, { _tag: "Resized", width: 100, height: 30 }))
        const narrowed = text()

        expect(rows()).toEqual(mounted)
        expect(narrowed.split("\n").every((line) => stringWidth(line) <= 100)).toBe(true)
        for (const word of [
          "alpha",
          "omega",
          "durable",
          "execution",
          "Generalist",
          "preserves",
          "wrapping",
          "blankRowRhythmMarker",
          "preserveEveryCodeTokenAcrossTheNarrowTerminalWidth",
        ])
          expect(narrowed).toContain(word)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps a 4000-chunk transcript resize reflow bounded", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 66 }))
      const surface = new Surface(setup.renderer, handlers())
      try {
        const source = Array.from(
          { length: 4_000 },
          (_, index) => `LONG_CHUNK_${String(index).padStart(4, "0")};`,
        ).join("")
        const wide = model({
          width: 200,
          height: 66,
          entries: [{ role: "assistant", text: source, turnId: "turn-1" }],
        })
        surface.update(wide)

        const startedAt = yield* Clock.currentTimeMillis
        surface.update(update(wide, { _tag: "Resized", width: 100, height: 30 }))
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt
        const text = surface
          .transcriptDiagnostics()
          .rows.map((row) => styledTextValue(row.content))
          .join("")

        expect(text).toContain("LONG_CHUNK_3999")
        expect(elapsed).toBeLessThan(1_000)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps unchanged keyed transcript renderables across composer updates", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const surface = new Surface(setup.renderer, handlers())
      try {
        const state = model({
          entries: [
            { role: "user", text: "question", turnId: "turn-1" },
            { role: "assistant", text: "answer", turnId: "turn-1" },
          ],
        })
        surface.update(state)
        const before = [...surface.transcriptDiagnostics().rows]
        expect(before).toHaveLength(3)
        expect(before[0]).not.toBe(before[2])
        expect(before[1] === undefined ? undefined : styledTextValue(before[1].content)).toBe(" ")
        surface.update({ ...state, input: "next", cursor: 4 })
        const after = surface.transcriptDiagnostics().rows

        expect(after).toEqual(before)
        expect(after.every((child, index) => child === before[index])).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("limits transcript formatting input before reconciliation", () => {
  const historySize = maxMountedTranscriptEntries + 800
  const state = model({
    entries: Array.from({ length: historySize }, (_, index): Model["entries"][number] => ({
      role: "assistant",
      text: `answer ${index}`,
      turnId: `turn-${index}`,
    })),
    items: Array.from(
      { length: historySize },
      (_, index): TranscriptItem => ({
        _tag: "Entry",
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }),
    ),
  })

  const bounded = boundedTranscriptModel(state)

  expect(bounded.entries).toHaveLength(maxMountedTranscriptEntries)
  expect(bounded.items).toHaveLength(maxMountedTranscriptEntries)
  expect(bounded.entries[0]?.text).toBe("answer 800")
  expect(bounded.items[0]).toEqual({
    _tag: "Entry",
    index: 0,
    id: "answer-800",
    turnId: "turn-800",
  })
  const older = boundedTranscriptModel(state, maxMountedTranscriptEntries + 200)
  expect(older.entries).toHaveLength(maxMountedTranscriptEntries)
  expect(older.entries[0]?.text).toBe("answer 200")
  expect(older.entries.at(-1)?.text).toBe(`answer ${maxMountedTranscriptEntries + 199}`)
})

test("keeps a subagent parent within the bounded suffix when its children exceed the limit", () => {
  const parent: TranscriptBlock = {
    _tag: "ToolCall",
    id: "agent",
    name: "oracle",
    input: "{}",
    status: "running",
    presentation: {
      family: "agent",
      action: "oracle",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    },
    detail: "Review the code",
    files: [],
  }
  const children = Array.from(
    { length: maxMountedTranscriptEntries + 5 },
    (_, index): TranscriptBlock => ({
      _tag: "ToolCall",
      id: `child-${index}`,
      name: "read",
      input: `{"path":"src/${index}.ts"}`,
      status: "complete",
      presentation: {
        family: "explore",
        action: "read",
        activeLabel: "Exploring",
        completeLabel: "Explored",
        counter: "file",
      },
      detail: `src/${index}.ts`,
      files: [],
    }),
  )
  const state = model({
    blocks: [parent, ...children],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      ...children.map(
        (_, index): TranscriptItem => ({
          _tag: "Block",
          index: index + 1,
          id: `tool:child-${index}`,
          turnId: "child",
          parentId: "agent",
        }),
      ),
    ],
  })

  const bounded = boundedTranscriptModel(state)

  expect(bounded.items).toHaveLength(children.length + 1)
  expect(bounded.blocks[0]).toMatchObject({ _tag: "ToolCall", id: "agent" })
  expect(bounded.items[0]).toMatchObject({ _tag: "Block", index: 0, id: "tool:agent" })
})

// Defect #361 characterization: directional transcript window selection.
// A top window fills oldest-first from source item zero; a bottom window fills
// newest-first from the final item; a middle window keeps its anchor mounted.

const flatEntryState = (count: number): Model =>
  model({
    entries: Array.from({ length: count }, (_, index) => ({
      role: "assistant" as const,
      text: `answer ${index}`,
      turnId: `turn-${index}`,
    })),
    items: Array.from(
      { length: count },
      (_, index): TranscriptItem => ({
        _tag: "Entry",
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }),
    ),
  })

const unitBlock = (id: string, family: "agent" | "explore") => ({
  _tag: "ToolCall" as const,
  id,
  name: family === "agent" ? "task" : "read",
  input: "{}",
  status: "complete" as const,
  presentation: {
    family,
    action: family === "agent" ? "task" : "read",
    activeLabel: "Working",
    completeLabel: "Done",
  },
  detail: id,
  files: [],
})

const selectedIds = (bounded: { readonly items: ReadonlyArray<TranscriptItem> }): ReadonlySet<string> =>
  new Set(bounded.items.map((item) => item.id).filter((id): id is string => id !== undefined))

test("selects the oldest flat items for a top window", () => {
  // The suffix-only end selection has no oldest-first top window; Home needs
  // oldestWindowRange(total, budget) to fill from source item zero.
  const oldestWindowRange = (transcriptWindow as unknown as { oldestWindowRange?: unknown }).oldestWindowRange
  expect(typeof oldestWindowRange).toBe("function")
  const state = flatEntryState(20_000)
  const range = (oldestWindowRange as (total: number, budget: number) => unknown)(
    state.items.length,
    maxMountedTranscriptEntries,
  )
  const bounded = (
    boundedTranscriptModel as unknown as (
      state: Model,
      range: unknown,
    ) => { readonly items: ReadonlyArray<TranscriptItem> }
  )(state, range)
  expect(bounded.items.length).toBeLessThanOrEqual(maxMountedTranscriptEntries)
  expect(bounded.items[0]?.id).toBe("answer-0")
})

test("selects the newest flat items for a bottom window", () => {
  // Mirror of the top window: End needs newestWindowRange(total, budget) to
  // fill newest-first up to the final item.
  const newestWindowRange = (transcriptWindow as unknown as { newestWindowRange?: unknown }).newestWindowRange
  expect(typeof newestWindowRange).toBe("function")
  const state = flatEntryState(20_000)
  const range = (newestWindowRange as (total: number, budget: number) => unknown)(
    state.items.length,
    maxMountedTranscriptEntries,
  )
  const bounded = (
    boundedTranscriptModel as unknown as (
      state: Model,
      range: unknown,
    ) => { readonly items: ReadonlyArray<TranscriptItem> }
  )(state, range)
  expect(bounded.items.length).toBeLessThanOrEqual(maxMountedTranscriptEntries)
  expect(bounded.items.at(-1)?.id).toBe("answer-19999")
})

test("selects the oldest children from an oversized first root unit", () => {
  const childCount = 700
  const tailCount = 700
  const blocks = [unitBlock("root", "agent"), ...Array.from({ length: childCount }, (_, index) => unitBlock(`child-${index}`, "explore"))]
  const items: Array<TranscriptItem> = [
    { _tag: "Block", index: 0, id: "tool:root", turnId: "turn-first" },
    ...Array.from(
      { length: childCount },
      (_, index): TranscriptItem => ({
        _tag: "Block",
        index: index + 1,
        id: `tool:child-${index}`,
        turnId: "turn-first",
        parentId: "root",
      }),
    ),
    ...Array.from(
      { length: tailCount },
      (_, index): TranscriptItem => ({ _tag: "Entry", index, id: `tail-${index}`, turnId: `turn-tail-${index}` }),
    ),
  ]
  const state = model({
    blocks,
    entries: Array.from({ length: tailCount }, (_, index) => ({
      role: "assistant" as const,
      text: `tail ${index}`,
      turnId: `turn-tail-${index}`,
    })),
    items,
    expandedRowKeys: ["tool:root"],
  })
  const bounded = boundedTranscriptModel(state, childCount + 1)
  const selected = selectedIds(bounded)
  expect(bounded.items.length).toBeLessThanOrEqual(maxMountedTranscriptEntries)
  expect(selected.has("tool:root")).toBe(true)
  expect(selected.has("tool:child-0")).toBe(true)
  expect(selected.has("tool:child-699")).toBe(false)
})

test("selects the newest children from an oversized last root unit", () => {
  const visibleChildren = 650
  const collapsedChildren = 500
  const headCount = 100
  const blocks = [
    unitBlock("root", "agent"),
    unitBlock("middle-visible", "agent"),
    unitBlock("middle-collapsed", "agent"),
    ...Array.from({ length: visibleChildren }, (_, index) => unitBlock(`visible-${index}`, "explore")),
    ...Array.from({ length: collapsedChildren }, (_, index) => unitBlock(`collapsed-${index}`, "explore")),
  ]
  const items: Array<TranscriptItem> = [
    ...Array.from(
      { length: headCount },
      (_, index): TranscriptItem => ({ _tag: "Entry", index, id: `head-${index}`, turnId: `turn-head-${index}` }),
    ),
    { _tag: "Block", index: 0, id: "tool:root", turnId: "turn-last" },
    { _tag: "Block", index: 1, id: "tool:middle-visible", turnId: "turn-last", parentId: "root" },
    { _tag: "Block", index: 2, id: "tool:middle-collapsed", turnId: "turn-last", parentId: "root" },
    ...Array.from(
      { length: visibleChildren },
      (_, index): TranscriptItem => ({
        _tag: "Block",
        index: index + 3,
        id: `tool:visible-${index}`,
        turnId: "turn-last",
        parentId: "middle-visible",
      }),
    ),
    ...Array.from(
      { length: collapsedChildren },
      (_, index): TranscriptItem => ({
        _tag: "Block",
        index: index + 3 + visibleChildren,
        id: `tool:collapsed-${index}`,
        turnId: "turn-last",
        parentId: "middle-collapsed",
      }),
    ),
  ]
  const state = model({
    blocks,
    entries: Array.from({ length: headCount }, (_, index) => ({
      role: "assistant" as const,
      text: `head ${index}`,
      turnId: `turn-head-${index}`,
    })),
    items,
    expandedRowKeys: ["tool:root", "tool:middle-visible"],
  })
  const bounded = boundedTranscriptModel(state)
  const selected = selectedIds(bounded)
  expect(selected.has("tool:root")).toBe(true)
  expect(selected.has("tool:visible-649")).toBe(true)
  expect(selected.has("tool:visible-0")).toBe(false)
  expect(bounded.items.length).toBeLessThanOrEqual(maxMountedTranscriptEntries)
})

test("does not charge collapsed descendants to the visible item budget", () => {
  const collapsedCount = 1100
  const tailCount = 100
  const blocks = [unitBlock("root", "agent"), ...Array.from({ length: collapsedCount }, (_, index) => unitBlock(`child-${index}`, "explore"))]
  const state = model({
    blocks,
    entries: Array.from({ length: tailCount }, (_, index) => ({
      role: "assistant" as const,
      text: `tail ${index}`,
      turnId: `turn-tail-${index}`,
    })),
    items: [
      { _tag: "Block", index: 0, id: "tool:root", turnId: "turn-first" },
      ...Array.from(
        { length: collapsedCount },
        (_, index): TranscriptItem => ({
          _tag: "Block",
          index: index + 1,
          id: `tool:child-${index}`,
          turnId: "turn-first",
          parentId: "root",
        }),
      ),
      ...Array.from(
        { length: tailCount },
        (_, index): TranscriptItem => ({ _tag: "Entry", index, id: `tail-${index}`, turnId: `turn-tail-${index}` }),
      ),
    ],
    expandedRowKeys: [],
  })
  const bounded = boundedTranscriptModel(state)
  const selected = selectedIds(bounded)
  for (let index = 0; index < tailCount; index += 1) expect(selected.has(`tail-${index}`)).toBe(true)
  expect(bounded.items.length).toBeLessThanOrEqual(maxMountedTranscriptEntries)
  expect(bounded.items.filter((item) => item.id?.startsWith("tool:child-") ?? false)).toHaveLength(0)
})

test("preserves every required ancestor for a partial nested window", () => {
  const leafCount = 100
  const fillerCount = 499
  const lateFillerCount = 4400
  const blocks = [unitBlock("leaf", "explore"), unitBlock("middle", "agent"), unitBlock("root", "agent")]
  const items: Array<TranscriptItem> = [
    ...Array.from(
      { length: leafCount },
      (_, index): TranscriptItem => ({
        _tag: "Block",
        index: 0,
        id: `tool:leaf-${index}`,
        turnId: "turn-nested",
        parentId: "middle",
      }),
    ),
    { _tag: "Block", index: 1, id: "tool:middle", turnId: "turn-nested", parentId: "root" },
    ...Array.from(
      { length: fillerCount },
      (_, index): TranscriptItem => ({ _tag: "Entry", index, id: `fill-${index}`, turnId: `turn-fill-${index}` }),
    ),
    ...Array.from(
      { length: lateFillerCount },
      (_, index): TranscriptItem => ({
        _tag: "Entry",
        index: index + fillerCount,
        id: `late-${index}`,
        turnId: `turn-late-${index}`,
      }),
    ),
    { _tag: "Block", index: 2, id: "tool:root", turnId: "turn-nested" },
  ]
  const state = model({
    blocks,
    entries: Array.from({ length: fillerCount + lateFillerCount }, (_, index) => ({
      role: "assistant" as const,
      text: `fill ${index}`,
      turnId: `turn-fill-${index}`,
    })),
    items,
    expandedRowKeys: ["tool:root", "tool:middle"],
  })
  const bounded = boundedTranscriptModel(state, maxMountedTranscriptEntries)
  const selected = selectedIds(bounded)
  for (const item of bounded.items) {
    if (item.parentId === undefined) continue
    expect(selected.has(`tool:${item.parentId}`)).toBe(true)
  }
})

test("centers an anchored window without dropping the anchor unit", () => {
  const unitCount = 500
  const unitSize = 10
  const blocks = Array.from({ length: unitCount * unitSize }, (_, position) => {
    const unit = Math.floor(position / unitSize)
    return unitBlock(position % unitSize === 0 ? `unit-${unit}` : `unit-${unit}-child-${position % unitSize}`, position % unitSize === 0 ? "agent" : "explore")
  })
  const items: Array<TranscriptItem> = Array.from({ length: unitCount * unitSize }, (_, position): TranscriptItem => {
    const unit = Math.floor(position / unitSize)
    return position % unitSize === 0
      ? { _tag: "Block", index: position, id: `tool:unit-${unit}`, turnId: "turn" }
      : {
          _tag: "Block",
          index: position,
          id: `tool:unit-${unit}-child-${position % unitSize}`,
          turnId: "turn",
          parentId: `unit-${unit}`,
        }
  })
  const state = model({
    blocks,
    entries: [],
    items,
    expandedRowKeys: Array.from({ length: unitCount }, (_, unit) => `tool:unit-${unit}`),
  })
  const windowHasAnchor = (end: number): boolean => selectedIds(boundedTranscriptModel(state, end)).has("tool:unit-100")
  expect(windowHasAnchor(1600)).toBe(true)
  expect(windowHasAnchor(1400)).toBe(true)
  expect(windowHasAnchor(1800)).toBe(true)
})

test("keeps structural items below the structural budget", () => {
  const collapsedCount = 1100
  const headCount = 100
  const blocks = [unitBlock("root", "agent"), ...Array.from({ length: collapsedCount }, (_, index) => unitBlock(`child-${index}`, "explore"))]
  const state = model({
    blocks,
    entries: Array.from({ length: headCount }, (_, index) => ({
      role: "assistant" as const,
      text: `head ${index}`,
      turnId: `turn-head-${index}`,
    })),
    items: [
      ...Array.from(
        { length: headCount },
        (_, index): TranscriptItem => ({ _tag: "Entry", index, id: `head-${index}`, turnId: `turn-head-${index}` }),
      ),
      { _tag: "Block", index: 0, id: "tool:root", turnId: "turn-last" },
      ...Array.from(
        { length: collapsedCount },
        (_, index): TranscriptItem => ({
          _tag: "Block",
          index: index + 1,
          id: `tool:child-${index}`,
          turnId: "turn-last",
          parentId: "root",
        }),
      ),
    ],
    expandedRowKeys: [],
  })
  const bounded = boundedTranscriptModel(state)
  const structuralItems = bounded.items.length + bounded.blocks.length + bounded.entries.length
  expect(structuralItems).toBeLessThanOrEqual(maxBoundedTranscriptItems)
})
