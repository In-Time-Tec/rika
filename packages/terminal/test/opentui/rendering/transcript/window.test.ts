import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Clock, Effect } from "effect"
import stringWidth from "string-width"
import { Surface } from "../../../../src/opentui/surface/service"
import {
  boundedTranscriptModel,
  maxMountedTranscriptEntries,
} from "../../../../src/opentui/rendering/transcript/window"
import { type Model } from "../../../../src/state/model"
import { update } from "../../../../src/state/reducer/model"
import { type TranscriptBlock, type TranscriptItem } from "../../../../src/state/transcript/model"
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
          "| durable execution | TenetKit | preserves every table word while wrapping narrow cells |",
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
        const text = () => rows().map((row) => styledTextValue(row.content)).join("\n")
        const mounted = [...rows()]
        expect(text().split("\n").some((line) => stringWidth(line) > 100)).toBe(true)

        surface.update(update(wide, { _tag: "Resized", width: 100, height: 30 }))
        const narrowed = text()

        expect(rows()).toEqual(mounted)
        expect(narrowed.split("\n").every((line) => stringWidth(line) <= 100)).toBe(true)
        for (const word of [
          "alpha",
          "omega",
          "durable",
          "execution",
          "TenetKit",
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
        const source = Array.from({ length: 4_000 }, (_, index) =>
          `LONG_CHUNK_${String(index).padStart(4, "0")};`).join("")
        const wide = model({
          width: 200,
          height: 66,
          entries: [{ role: "assistant", text: source, turnId: "turn-1" }],
        })
        surface.update(wide)

        const startedAt = yield* Clock.currentTimeMillis
        surface.update(update(wide, { _tag: "Resized", width: 100, height: 30 }))
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt
        const text = surface.transcriptDiagnostics().rows.map((row) => styledTextValue(row.content)).join("")

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
    items: Array.from({ length: historySize }, (_, index): TranscriptItem => ({
      _tag: "Entry",
      index,
      id: `answer-${index}`,
      turnId: `turn-${index}`,
    })),
  })

  const bounded = boundedTranscriptModel(state)

  expect(bounded.entries).toHaveLength(maxMountedTranscriptEntries)
  expect(bounded.items).toHaveLength(maxMountedTranscriptEntries)
  expect(bounded.entries[0]?.text).toBe("answer 800")
  expect(bounded.items[0]).toEqual({ _tag: "Entry", index: 0, id: "answer-800", turnId: "turn-800" })
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
  const children = Array.from({ length: maxMountedTranscriptEntries + 5 }, (_, index): TranscriptBlock => ({
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
  }))
  const state = model({
    blocks: [parent, ...children],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      ...children.map((_, index): TranscriptItem => ({
        _tag: "Block",
        index: index + 1,
        id: `tool:child-${index}`,
        turnId: "child",
        parentId: "agent",
      })),
    ],
  })

  const bounded = boundedTranscriptModel(state)

  expect(bounded.items).toHaveLength(children.length + 1)
  expect(bounded.blocks[0]).toMatchObject({ _tag: "ToolCall", id: "agent" })
  expect(bounded.items[0]).toMatchObject({ _tag: "Block", index: 0, id: "tool:agent" })
})
