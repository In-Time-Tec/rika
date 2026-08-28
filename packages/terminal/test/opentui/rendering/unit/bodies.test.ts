import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../../../src/opentui/surface/service"
import { initial, type Model } from "../../../../src/state/model"
import { renderCellBody } from "../../../../src/opentui/rendering/unit/bodies"
import {
  openTui,
  _insertText,
  styledTextValue,
  _streamingShell,
  _giantSubagentModel,
  _collapsedSubagentModel,
} from "./bodies.fixture"

test("keeps output-bound details internal in expanded cells", () => {
  const chunks: Array<string> = []
  renderCellBody(
    {
      _tag: "Cell",
      id: "bounded-cell",
      status: "complete",
      visual: "ts",
      source: { text: "const value = 42", lines: 1, truncated: false },
      output: { stdout: "42", stderr: "", droppedBytes: 13_100, droppedEvents: 0 },
      epoch: 1,
      notices: [{ kind: "restored", detail: "Restored value." }],
      files: [],
    },
    false,
    true,
    80,
    "⠿",
    (chunk) => chunks.push(chunk.text),
  )
  const rendered = chunks.join("")
  expect(rendered).toContain("truncated")
  expect(rendered).toContain("Restored value.")
  expect(rendered).not.toContain("Dropped 13100 bytes")
  expect(rendered).not.toContain("at the output bound")
})

test("shows all authored source when collapsed and caps long cells at fifteen lines", () => {
  const chunks: Array<string> = []
  const source = Array.from({ length: 18 }, (_, index) => `const value${index + 1} = ${index + 1}`).join("\n")
  renderCellBody(
    {
      _tag: "Cell",
      id: "long-cell",
      status: "running",
      visual: "ts",
      source: { text: source, lines: 18, truncated: false },
      output: { stdout: "hidden while collapsed", stderr: "", droppedBytes: 0, droppedEvents: 0 },
      epoch: 0,
      notices: [],
      files: [],
    },
    false,
    false,
    80,
    "⠿",
    (chunk) => chunks.push(chunk.text),
  )
  const rendered = chunks.join("")
  expect(rendered).toContain("const value1 = 1")
  expect(rendered).toContain("const value15 = 15")
  expect(rendered).not.toContain("const value16 = 16")
  expect(rendered).toContain("… 3 more lines · ▸")
  expect(rendered).not.toContain("hidden while collapsed")
  expect(rendered).not.toContain("ts")
})

test("ticks status and running-tool spinners every 100ms without rebuilding transcript bodies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      const running = {
        _tag: "ToolCall" as const,
        id: "long-running",
        name: "bash",
        input: '{"command":"sleep 5"}',
        status: "running" as const,
        presentation: {
          family: "shell" as const,
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
        detail: "sleep 5",
        output: "still running",
        files: [],
      }
      const model: Model = {
        ...initial("/work", "high"),
        width: 100,
        height: 30,
        busy: true,
        activity: { _tag: "Thinking", bytes: 20 },
        blocks: [running],
        items: [{ _tag: "Block", index: 0, id: "tool:long-running", turnId: "turn" }],
        expandedRowKeys: ["tool:long-running"],
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      const records = () => {
        const diagnostics = surface.transcriptDiagnostics()
        return new Map(diagnostics.keys.map((key, index) => [key, { renderable: diagnostics.rows[index]! }]))
      }
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const body = records().get("tool:long-running:body")!.renderable
        const firstBodyContent = body.content
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toContain("⠭")

        clock.advance(99)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toContain("⠭")
        clock.advance(1)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toMatch(/[⠀-⣿] sleep 5/u)
        expect(body.content).toBe(firstBodyContent)

        clock.advance(100)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≋ Thinking 5 tok")
        clock.advance(100)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Thinking 5 tok")
        clock.advance(100)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        clock.advance(100)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(body.content).toBe(firstBodyContent)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
test("advances context-detail active time with the injected clock and freezes closed intervals", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const epoch = 1_750_000_000_000
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      const surface = new Surface(
        setup.renderer,
        { key: () => undefined, resize: () => undefined },
        { clock, currentTimeMillis: () => epoch + clock.now() },
      )
      const active: Model = {
        ...initial("/work", "high"),
        width: 100,
        height: 30,
        contextDetailsOpen: true,
        usageTime: { _tag: "Available", accumulatedMillis: 0, activeSince: epoch },
      }
      try {
        surface.update(active)
        expect(styledTextValue(surface.palette.content)).toContain("◷ 0s")
        clock.advance(1_000)
        expect(styledTextValue(surface.palette.content)).toContain("◷ 1s")

        surface.update({
          ...active,
          usageTime: { _tag: "Available", accumulatedMillis: 1_000 },
        })
        clock.advance(2_000)
        expect(styledTextValue(surface.palette.content)).toContain("◷ 1s")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))
