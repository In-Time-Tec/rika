import { expect, test } from "vitest"
import { Schema } from "effect"
import { initial, type Model } from "../../../src/state/model"
import { maxInMemoryTranscriptUnits, trimTranscriptTimeline } from "../../../src/state/transcript/timeline-bounds"
import {
  transcriptVirtualIndex,
  itemPositionAtVirtualRow,
  virtualRowOfItemPosition,
} from "../../../src/presentation/transcript/viewport/virtual-index"

const TranscriptItems = Schema.Array(
  Schema.Union([
    Schema.TaggedStruct("Entry", {
      index: Schema.Finite,
      id: Schema.optional(Schema.String),
      turnId: Schema.optional(Schema.String),
      rootTurnId: Schema.optional(Schema.String),
      parentId: Schema.optional(Schema.String),
    }),
    Schema.TaggedStruct("Block", {
      index: Schema.Finite,
      id: Schema.optional(Schema.String),
      turnId: Schema.optional(Schema.String),
      rootTurnId: Schema.optional(Schema.String),
      parentId: Schema.optional(Schema.String),
    }),
  ]),
)

const entryModel = (count: number, text: (index: number) => string): Model => {
  const entries = Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: text(index),
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

test("trimTranscriptTimeline keeps the newest units and remaps entry indexes", () => {
  const model = entryModel(12, (index) => `answer ${index}`)
  const trimmed = trimTranscriptTimeline(model, 10)
  expect(trimmed.items).toHaveLength(10)
  expect(trimmed.entries).toHaveLength(10)
  expect(trimmed.entries[0]?.text).toBe("answer 2")
  expect(trimmed.entries.at(-1)?.text).toBe("answer 11")
  expect(trimmed.items[0]).toMatchObject({ _tag: "Entry", index: 0, id: "entry-2" })
  expect(trimmed.items.at(-1)).toMatchObject({ _tag: "Entry", index: 9, id: "entry-11" })
  expect(model.items).toHaveLength(12)
})

test("trimTranscriptTimeline never splits a parent-child subtree at the boundary", () => {
  const parent = {
    _tag: "Block" as const,
    block: {
      _tag: "ToolCall" as const,
      id: "tool-a",
      name: "read",
      input: "a",
      status: "complete" as const,
      presentation: {
        family: "explore" as const,
        action: "read",
        activeLabel: "Reading",
        completeLabel: "Read",
      },
      detail: "read a",
      files: [],
    },
  }
  const children = Array.from({ length: 8 }, (_, index) => ({
    _tag: "Entry" as const,
    index,
    id: `child-${index}`,
    parentId: "tool-a",
    turnId: "turn-a",
    order: undefined,
    rootTurnId: undefined,
  }))
  const leading = Array.from({ length: 6 }, (_, index) => ({
    role: "assistant" as const,
    text: `leading ${index}`,
    turnId: `turn-${index}`,
  }))
  const childEntries = children.map((child) => ({
    role: "assistant" as const,
    text: `child ${child.id}`,
    turnId: "turn-a",
  }))
  const model: Model = {
    ...initial("/work", "medium"),
    blocks: [parent.block],
    entries: [...leading, ...childEntries],
    items: [
      ...leading.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `leading-${index}`,
        turnId: `turn-${index}`,
      })),
      { _tag: "Block" as const, index: 0, id: "tool-a", turnId: "turn-a" },
      ...children.map((child, index) => ({
        _tag: "Entry" as const,
        index: leading.length + index,
        id: child.id,
        parentId: "tool-a",
        turnId: "turn-a",
      })),
    ],
  }
  const trimmed = trimTranscriptTimeline(model, 10)
  const keptItems = Schema.decodeUnknownSync(TranscriptItems)(trimmed.items)
  const keptKeys = keptItems.map((item) => item.id)
  expect(keptKeys).toContain("tool-a")
  expect(keptKeys.filter((key) => key?.startsWith("child-"))).toHaveLength(8)
  expect(keptKeys.filter((key) => key?.startsWith("leading-"))).toHaveLength(1)
  expect(keptKeys).toHaveLength(10)
  for (const item of keptItems) if (item.parentId !== undefined) expect(keptKeys).toContain(item.parentId)
})

test("trimTranscriptTimeline is a no-op at or below the cap", () => {
  const model = entryModel(20_000, (index) => `answer ${index}`)
  expect(trimTranscriptTimeline(model, maxInMemoryTranscriptUnits)).toBe(model)
  expect(trimTranscriptTimeline(model, 20_001)).toBe(model)
})

test("transcriptVirtualIndex estimates rows and maps rows to item positions", () => {
  const model = entryModel(6, (index) => "x".repeat(20 * (index + 1)))
  const width = 40
  const index = transcriptVirtualIndex(model, width)
  expect(index.rowsPerItem).toHaveLength(6)
  expect(index.totalRows).toBeGreaterThan(0)
  for (let position = 0; position < 6; position += 1) {
    expect(virtualRowOfItemPosition(index, position)).toBe(index.prefix[position])
  }
  for (let position = 0; position < 6; position += 1) {
    const start = index.prefix[position]!
    const end = index.prefix[position + 1]!
    expect(itemPositionAtVirtualRow(index, start)).toBe(position)
    expect(itemPositionAtVirtualRow(index, Math.max(0, end - 1))).toBe(position)
  }
  expect(itemPositionAtVirtualRow(index, index.totalRows + 100)).toBe(5)
  expect(itemPositionAtVirtualRow(index, -5)).toBe(0)
})

test("transcriptVirtualIndex handles an empty timeline", () => {
  const index = transcriptVirtualIndex(initial("/work", "medium"), 80)
  expect(index.totalRows).toBe(0)
  expect(itemPositionAtVirtualRow(index, 0)).toBe(0)
  expect(virtualRowOfItemPosition(index, 0)).toBe(0)
})
