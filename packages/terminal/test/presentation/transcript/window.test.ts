import { expect, test } from "vitest"
import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import { Schema } from "effect"
import { boundedTranscriptModel, maxMountedTranscriptEntries } from "../../../src/opentui/rendering/transcript/window"
import { windowUnitToolCall, model } from "../../opentui/rendering/transcript/window.fixture"

const isTranscriptBlock = Schema.is(TranscriptPresentationModel.Block)

test("keeps nested ancestors and the newest child suffix within the transcript limit", () => {
  const layout: ReadonlyArray<{
    readonly id: string
    readonly family: "agent" | "explore"
    readonly parentId?: string
  }> = [
    { id: "agent", family: "agent" },
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `agent-tool-${index}`,
      family: "explore" as const,
      parentId: "agent",
    })),
    { id: "nested", family: "agent", parentId: "agent" },
    ...Array.from({ length: maxMountedTranscriptEntries + 50 }, (_, index) => ({
      id: `nested-child-${index}`,
      family: "explore" as const,
      parentId: "nested",
    })),
  ]
  const blocks = layout.map((entry) => windowUnitToolCall(entry.id, entry.family))
  const state = model({
    blocks,
    items: layout.map((entry, index) =>
      entry.parentId === undefined
        ? { _tag: "Block" as const, index, id: `tool:${entry.id}`, turnId: "turn" }
        : { _tag: "Block" as const, index, id: `tool:${entry.id}`, turnId: "child", parentId: entry.parentId },
    ),
    expandedRowKeys: ["tool:agent", "tool:nested"],
  })

  const bounded = boundedTranscriptModel(state)
  const mountedIds = new Set(
    bounded.blocks.flatMap((block) => (isTranscriptBlock(block) && block._tag === "ToolCall" ? [block.id] : [])),
  )

  expect([...mountedIds].some((id) => id.startsWith("nested-child-"))).toBe(true)
  expect(mountedIds.has("nested")).toBe(true)
  expect(mountedIds.has("agent")).toBe(true)
  expect(mountedIds.size).toBeLessThanOrEqual(maxMountedTranscriptEntries)
  expect(mountedIds.has("agent-tool-29")).toBe(false)
})
test("bounds large transcript histories before mounting", () => {
  const bounded = boundedTranscriptModel(
    model({
      entries: Array.from({ length: maxMountedTranscriptEntries + 1_000 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      })),
    }),
  )

  expect(bounded.entries).toHaveLength(maxMountedTranscriptEntries)
  expect(bounded.entries[0]?.text).toBe("answer 1000")
})
