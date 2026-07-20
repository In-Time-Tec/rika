import { expect, test } from "vitest"
import { Scene } from "./scene"

const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, value))

const screenEverShowed = (raw: string, needle: string): boolean => {
  const rows = 30
  const cols = 100
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "))
  let row = 0
  let col = 0
  let found = false
  const check = () => {
    if (!found) found = grid.some((cells) => cells.join("").includes(needle))
  }
  const clearAll = () => {
    for (const cells of grid) cells.fill(" ")
  }
  const scrollUp = () => {
    grid.shift()
    grid.push(Array.from({ length: cols }, () => " "))
  }
  let index = 0
  while (index < raw.length) {
    const character = raw[index]!
    if (character === "\u001b") {
      const kind = raw[index + 1]
      if (kind === "[") {
        let end = index + 2
        while (end < raw.length && !/[@-~]/.test(raw[end]!)) end += 1
        const body = raw.slice(index + 2, end)
        const final = raw[end]
        const parameters = body
          .replace(/^[?>]/, "")
          .split(";")
          .map((part) => Number.parseInt(part, 10))
        const first = Number.isNaN(parameters[0] ?? Number.NaN) ? undefined : parameters[0]
        if (final === "H" || final === "f") {
          check()
          row = clamp((first ?? 1) - 1, rows)
          col = clamp((parameters[1] ?? 1) - 1, cols)
        } else if (final === "A") row = clamp(row - (first ?? 1), rows)
        else if (final === "B") row = clamp(row + (first ?? 1), rows)
        else if (final === "C") col = clamp(col + (first ?? 1), cols)
        else if (final === "D") col = clamp(col - (first ?? 1), cols)
        else if (final === "G") col = clamp((first ?? 1) - 1, cols)
        else if (final === "d") row = clamp((first ?? 1) - 1, rows)
        else if (final === "J") {
          check()
          if (first === undefined || first === 0)
            for (let target = row; target < rows; target += 1) grid[target]!.fill(" ", target === row ? col : 0)
          else if (first === 1)
            for (let target = 0; target <= row; target += 1) grid[target]!.fill(" ", 0, target === row ? col + 1 : cols)
          else clearAll()
        } else if (final === "K") {
          check()
          if (first === undefined || first === 0) grid[row]!.fill(" ", col)
          else if (first === 1) grid[row]!.fill(" ", 0, col + 1)
          else grid[row]!.fill(" ")
        } else if (final === "S") for (let count = 0; count < (first ?? 1); count += 1) scrollUp()
        else if (final === "h" || final === "l") {
          if (body.startsWith("?1049")) {
            check()
            clearAll()
            row = 0
            col = 0
          }
        }
        index = end + 1
        continue
      }
      if (kind === "]") {
        let end = index + 2
        while (end < raw.length && raw[end] !== "\u0007" && !(raw[end] === "\u001b" && raw[end + 1] === "\\")) end += 1
        index = raw[end] === "\u0007" ? end + 1 : end + 2
        continue
      }
      if (kind === "M") {
        row = clamp(row - 1, rows)
        index += 2
        continue
      }
      index += kind === "(" || kind === ")" ? 3 : 2
      continue
    }
    if (character === "\r") col = 0
    else if (character === "\n") {
      if (row === rows - 1) scrollUp()
      else row += 1
    } else if (character === "\b") col = clamp(col - 1, cols)
    else if (character === "\t") col = clamp((col + 8) & ~7, cols)
    else if (character >= " ") {
      grid[row]![col] = character
      col = clamp(col + 1, cols)
    }
    index += 1
  }
  check()
  return found
}

test(
  "expands a failed child run to its durable failure reason",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Fail deterministically." }, "failed-child")]),
        Scene.model.failure("deterministic child failure"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Delegate work that may fail.\r"),
        Scene.action.writeAfter("Subagent failed", "\t", 100),
        Scene.action.writeAfter("Subagent failed ▸", "\r"),
        Scene.action.writeAfter("deterministic child failure", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Subagent failed")
      expect(result.output).toContain("deterministic child failure")
      expect(result.output).not.toContain("Subagent finished")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  30_000,
)

test(
  "expands, collapses, and re-expands nested child responses deterministically",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Coordinate nested work." }, "depth-one")]),
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Complete the nested check." }, "depth-two")]),
        Scene.model.turn([
          Scene.model.toolCall("read", { path: "nested-evidence.ts", read_range: [1, 20] }, "nested-read"),
        ]),
        Scene.model.text("Depth two verified the boundary."),
        Scene.model.text("Depth one synthesized the nested result."),
        Scene.model.text("Parent received the nested result."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Coordinate nested work.\r"),
        Scene.action.writeAfter("Parent received the nested result.", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("Depth one synthesized", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("Depth two verified", "\r", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("Depth two verified", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output.match(/Subagent finished/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(screenEverShowed(result.rawOutput, "Depth one synthesized the nested result.")).toBe(true)
      expect(screenEverShowed(result.rawOutput, "Depth two verified the boundary.")).toBe(true)
      expect(screenEverShowed(result.rawOutput, "nested-evidence.ts")).toBe(true)
      expect(screenEverShowed(result.rawOutput, "Parent received the nested result.")).toBe(true)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "preserves the specialist identity and response of an Oracle child run",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("oracle", { prompt: "Review the boundary." }, "oracle-child")]),
        Scene.model.text("The boundary is sound."),
        Scene.model.text("Parent accepted the Oracle answer."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Ask Oracle to review the boundary.\r"),
        Scene.action.writeAfter("Parent accepted the Oracle answer.", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("The boundary is sound.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Oracle has spoken")
      expect(result.output).toContain("The boundary is sound.")
      expect(result.output).toContain("Parent accepted the Oracle answer.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  30_000,
)

test(
  "lets a child run use its narrowed workspace tools and shows the result",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("bash", { command: "printf child-workspace-marker > marker.txt" }, "write-marker"),
        ]),
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Read marker.txt." }, "workspace-child")]),
        Scene.model.turn([Scene.model.toolCall("read", { path: "marker.txt" }, "read-marker")]),
        Scene.model.text("Child read child-workspace-marker."),
        Scene.model.text("Parent received the workspace result."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Create a marker and delegate reading it.\r"),
        Scene.action.writeAfter("Parent received the workspace result.", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("Child read child-workspace-marker.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Child read child-workspace-marker.")
      expect(result.output).toContain("Parent received the workspace result.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  30_000,
)

test(
  "returns the child's final assistant text without issuing a structured report turn",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Summarize the workspace." }, "text-report-child")]),
        Scene.model.text("CHILD_TEXT_REPORT_OK"),
        Scene.model.text("PARENT_RELAYED_OK"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Delegate a text-only report.\r"),
        Scene.action.writeAfter("Subagent finished", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("CHILD_TEXT_REPORT_OK", "", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Subagent finished")
      expect(result.output).toContain("CHILD_TEXT_REPORT_OK")
      expect(result.output).toContain("PARENT_RELAYED_OK")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
