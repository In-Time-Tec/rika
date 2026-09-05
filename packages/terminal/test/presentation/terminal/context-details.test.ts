import { expect, test } from "vitest"
import { buildTranscript } from "../../../src/opentui/rendering/renderer"
import { completedCompactionIcon, renderBlock, sidebarFileRows } from "../../../src/opentui/rendering/block"
import { modePickerContent } from "../../../src/opentui/surface/composer/region"
import { contextDetails } from "../../../src/presentation/terminal/context-details"
import { initial } from "../../../src/state/model"
import { clampSidebarWidth } from "../../../src/state/layout/model"

const text = (chunks: ReadonlyArray<{ readonly text: string }>): string => chunks.map((chunk) => chunk.text).join("")

test("renders completed compaction rows without internal checkpoint identifiers", () => {
  const block = { _tag: "Compaction" as const, status: "complete" as const, checkpoint: "session:secret", summary: "" }
  expect(renderBlock(block)).toBe(`${completedCompactionIcon} Auto-compacted`)

  const model = initial("/work", "high")
  const transcript = buildTranscript({
    ...model,
    blocks: [block],
    items: [{ _tag: "Block", index: 0, id: "compaction", turnId: "turn" }],
  }).styled
  const label = transcript.chunks.filter((chunk) => "Auto-compacted".includes(chunk.text) && chunk.text.length === 1)
  expect(label.map((chunk) => chunk.fg)).toHaveLength("Auto-compacted".length)
  expect(new Set(label.map((chunk) => String(chunk.fg))).size).toBeGreaterThan(3)
})

test("uses padded full-size mode and context sections while compact content stays tight", () => {
  const model = initial("/work", "high")
  const mode = text(modePickerContent(model, 54).chunks)
  expect(mode).toContain("\n\n" + " ".repeat(54) + "\n\nAgent")
  expect(mode).toContain("\n\n" + " ".repeat(54) + "\n\nFast, low-cost")

  const context = text(
    contextDetails(
      {
        ...model,
        contextUsage: {
          _tag: "Available",
          inputTokens: 1_000,
          inputCacheRead: 900,
          inputTotal: 1_000,
          contextWindow: 10_000,
          reserveTokens: 1_000,
        },
      },
      54,
      16,
      0,
    ).chunks,
  )
  expect(context).toContain("\n\n" + " ".repeat(54) + "\n\nUsable")
  expect(context).toContain("\n\n" + " ".repeat(54) + "\n\nCost")
  expect(text(modePickerContent(model, 32).chunks)).not.toContain("├─ Route ")
})

test("renders honest empty states instead of Unknown when no usage exists yet", () => {
  const base = initial("/work", "high")

  const notStarted = text(contextDetails({ ...base, contextUsage: { _tag: "NotStarted" } }, 54, 16, 0).chunks)
  expect(notStarted).not.toContain("Unknown")
  expect(notStarted).toContain("Used        0")
  expect(notStarted).toContain("Available   922K")
  expect(notStarted).toContain("Usable     922K")
  expect(notStarted).toContain("Full       1.05M")
  expect(notStarted).toContain("No usage recorded yet")

  const notReported = text(contextDetails({ ...base, contextUsage: { _tag: "Unavailable" } }, 54, 16, 0).chunks)
  expect(notReported).not.toContain("Unknown")
  expect(notReported).toContain("Used        —")
  expect(notReported).toContain("Available   —")
  expect(notReported).toContain("Usable     922K")
  expect(notReported).toContain("Full       1.05M")
  expect(notReported).toContain("Context usage is not reported by this model")

  const loading = text(contextDetails({ ...base, contextUsage: { _tag: "Loading" }, busy: true }, 54, 16, 0).chunks)
  expect(loading).not.toContain("Unknown")
  expect(loading).toContain("Used        0")
  expect(loading).toContain("Full       1.05M")
  expect(loading).toContain("Cost       ····")

  const included = text(
    contextDetails(
      {
        ...base,
        contextUsage: {
          _tag: "Available",
          inputCacheRead: 0,
          inputTokens: 10,
          inputTotal: 10,
          contextWindow: 100,
          reserveTokens: 10,
        },
        usageCost: { _tag: "Included", includedAttempts: 2 },
      },
      54,
      16,
      0,
    ).chunks,
  )
  expect(included).toContain("Cost       Included in subscription")
  expect(included).not.toContain("$0.00")
})

test("uses a wider file sidebar with mode-accented title geometry and neutral content", () => {
  const model = {
    ...initial("/work", "ultra"),
    changedFilesOpen: true,
    changedFiles: { _tag: "Ready" as const, value: [{ path: "src/main.ts", status: "M" }] },
  }
  expect(model.sidebarWidth).toBe(52)
  expect(clampSidebarWidth(200, 120)).toBe(48)
  expect(clampSidebarWidth(200, 70)).toBe(28)
  const rows = sidebarFileRows(model, 40)
  const fileLabel = rows[1]?.chunks.find((chunk) => chunk.text === "main.ts")
  expect(String(fileLabel?.fg)).toContain("0.75")
})
