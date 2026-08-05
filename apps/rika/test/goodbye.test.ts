import { expect, it } from "vitest"
import { homedir } from "node:os"
import { renderGoodbye } from "../src/interactive/input/goodbye-message"

const esc = String.fromCharCode(27)

const stripAnsi = (text: string): string => text.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "")

const cellColor = (text: string, glyph: string): readonly [number, number, number] | undefined => {
  const match = new RegExp(`${esc}\\[38;2;(\\d+);(\\d+);(\\d+)m${glyph.replace(/[.*+]/g, "\\$&")}`).exec(text)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

it("renders the Amp-parity shaded mark with title, workspace, and continue command", () => {
  const output = renderGoodbye({
    mode: "medium",
    workspace: `${homedir()}/projects/Rika`,
    threadId: "T-abc123",
    threadTitle: "New coding session",
  })
  expect(stripAnsi(output)).toBe(
    [
      "",
      "     .#*+:",
      "   *##%%#+--     New coding session",
      "  *#%##%@*=.:    ~/projects/Rika",
      "  +****=....:",
      "   =::......",
      "     .....",
      "",
      "rika threads continue T-abc123",
      "",
    ].join("\n"),
  )
})

it("mode-tints the mark so the brightest glyph tracks the mode color", () => {
  const medium = renderGoodbye({ mode: "medium", workspace: "/w", threadId: "t", threadTitle: "x" })
  expect(cellColor(medium, "@")).toEqual([53, 223, 145])
  const high = renderGoodbye({ mode: "high", workspace: "/w", threadId: "t", threadTitle: "x" })
  const [, , highBlue] = cellColor(high, "@")!
  expect(highBlue).toBeGreaterThan(200)
})

it("colors the workspace muted and omits the continue command without a thread", () => {
  const output = renderGoodbye({ mode: "medium", workspace: "/Users/dev/code" })
  expect(output).toContain(`${esc}[38;5;8m~/code${esc}[0m`)
  expect(output).not.toContain("rika threads continue")
})
