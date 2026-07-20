import { expect, test } from "vitest"
import { Scene } from "./scene"

const ESC = String.fromCharCode(27)
const BELL = String.fromCharCode(7)
const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, value))

const finalTranscriptScreen = (raw: string): ReadonlyArray<string> => {
  const rows = 30
  const cols = 100
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "))
  let altScreenSnapshot: ReadonlyArray<string> | undefined
  let row = 0
  let col = 0
  const snapshot = () => grid.map((cells) => cells.join(""))
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
    if (character === ESC) {
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
          row = clamp((first ?? 1) - 1, rows)
          col = clamp((parameters[1] ?? 1) - 1, cols)
        } else if (final === "A") row = clamp(row - (first ?? 1), rows)
        else if (final === "B") row = clamp(row + (first ?? 1), rows)
        else if (final === "C") col = clamp(col + (first ?? 1), cols)
        else if (final === "D") col = clamp(col - (first ?? 1), cols)
        else if (final === "G") col = clamp((first ?? 1) - 1, cols)
        else if (final === "d") row = clamp((first ?? 1) - 1, rows)
        else if (final === "J") {
          if (first === undefined || first === 0)
            for (let target = row; target < rows; target += 1) grid[target]!.fill(" ", target === row ? col : 0)
          else if (first === 1)
            for (let target = 0; target <= row; target += 1) grid[target]!.fill(" ", 0, target === row ? col + 1 : cols)
          else clearAll()
        } else if (final === "K") {
          if (first === undefined || first === 0) grid[row]!.fill(" ", col)
          else if (first === 1) grid[row]!.fill(" ", 0, col + 1)
          else grid[row]!.fill(" ")
        } else if (final === "S") for (let count = 0; count < (first ?? 1); count += 1) scrollUp()
        else if (final === "h" || final === "l") {
          if (body.startsWith("?1049")) {
            if (final === "l") altScreenSnapshot = snapshot()
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
        while (end < raw.length && raw[end] !== BELL && !(raw[end] === ESC && raw[end + 1] === "\\")) end += 1
        index = raw[end] === BELL ? end + 1 : end + 2
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
  return altScreenSnapshot ?? snapshot()
}

const finalScreenShows = (raw: string, needle: string): boolean =>
  finalTranscriptScreen(raw).some((line) => line.includes(needle))

const finalScreenCount = (raw: string, needle: string): number =>
  finalTranscriptScreen(raw).reduce((total, line) => total + (line.includes(needle) ? 1 : 0), 0)

const expectScriptedModel = (result: Awaited<ReturnType<typeof Scene.run>>) => {
  expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
}

test(
  "updates one Oracle row from running to finished and expands its prompt and Markdown response",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("oracle", { prompt: "Review the projection boundary." }, "oracle-review"),
        ]),
        Scene.model.text("## Boundary review\n\n**No projection defects found.**", 300),
        Scene.model.text("ORACLE_TURN_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Ask Oracle to review the projection.\r"),
        Scene.action.checkRunningAfter("Oracle exploring", ""),
        Scene.action.writeAfter("ORACLE_TURN_COMPLETE", "\t", 100),
        Scene.action.writeAfter("Oracle has spoken ▸", "\r"),
        Scene.action.writeAfter("Boundary review", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Oracle exploring")
      expect(result.output).toContain("Oracle has spoken ▸")
      expect(result.output).toContain("Review the projection boundary.")
      expect(result.output).toContain("Boundary review")
      expect(result.output).toContain("No projection defects found.")
      expect(result.output).not.toContain("**No projection defects found.**")
      expectScriptedModel(result)
    }),
  45_000,
)

test(
  "presents general children as Subagent rows and expands their delegated task",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Inspect the transcript order." }, "task-order")]),
        Scene.model.text("## Order checked\n\nTranscript order is **stable**.\n\nGENERAL_DETAIL"),
        Scene.model.text("TASK_TURN_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Delegate an ordering check.\r"),
        Scene.action.checkRunningAfter("Subagent working", ""),
        Scene.action.writeAfter("_TURN_COMPLETE", "\t", 100),
        Scene.action.writeAfter("Subagent finished ▸", "\r"),
        Scene.action.writeAfter("Order checked", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Subagent working")
      expect(result.output).toContain("Subagent finished ▸")
      expect(result.output).toContain("Inspect the transcript order.")
      expect(result.output).toContain("Order checked")
      expect(result.output).not.toContain("**stable**")
      expectScriptedModel(result)
    }),
  45_000,
)

test(
  "nests specialist activity and its Markdown response beneath the owning subagent",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Coordinate a nested review." }, "coordinator")]),
        Scene.model.turn([Scene.model.toolCall("oracle", { prompt: "Check the nested projection." }, "nested-oracle")]),
        Scene.model.text("## Nested review\n\n**Ownership is correct.**"),
        Scene.model.text("Coordinator incorporated the nested review."),
        Scene.model.text("NESTED_TURN_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Coordinate a nested review.\r"),
        Scene.action.writeAfter("_TURN_COMPLETE", "\t", 100),
        Scene.action.writeAfter("Subagent finished ▸", "\r"),
        Scene.action.writeAfter("Oracle has spoken", "\t\r"),
        Scene.action.writeAfter("Nested review", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Coordinate a nested review.")
      expect(result.output).toContain("Oracle has spoken")
      expect(result.output).toContain("Check the nested projection.")
      expect(result.output).toContain("Nested review")
      expect(result.output).not.toContain("**Ownership is correct.**")
      expectScriptedModel(result)
    }),
  45_000,
)

test(
  "shows one nested tool call beneath its subagent and keeps the child response expandable",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("read", { path: "missing-parent-file.ts", read_range: [1, 20] }, "parent-read"),
          Scene.model.toolCall("grep", { pattern: "owner", regex: false }, "parent-grep"),
          Scene.model.toolCall("task", { prompt: "Inspect one child file." }, "file-inspector"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("read", { path: "missing-child-file.ts", read_range: [1, 20] }, "child-read"),
        ]),
        Scene.model.text("## Child inspection\n\nThe missing file result was handled."),
        Scene.model.text("CHILD_TOOL_TURN_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Inspect a child file.\r"),
        Scene.action.writeAfter("CHILD_TOOL_TURN_COMPLETE", "\t\t\r", 100),
        Scene.action.writeAfter("Child inspection", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Inspect one child file.")
      expect(result.output).toContain("missing-child-file.ts")
      expect(result.output).toContain("Child inspection")
      expect(result.output).toContain("✓ Subagent finished")
      expect(result.output).toContain("✓ Explored 1 file, 1 search")
      expect(result.output).toContain("✕ Read missing-child-file.ts")
      expect(result.childExecutions).toHaveLength(1)
      expect(result.childExecutions[0]?.status).toBe("completed")
      expectScriptedModel(result)
    }),
  45_000,
)

test(
  "expands a failed subagent to its terminal failure reason without an answer",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("task", { prompt: "Use an unavailable model.", model: "gpt-5.6-luna" }, "failed-task"),
        ]),
        Scene.model.text("FAILED_TURN_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Try an unavailable child model.\r"),
        Scene.action.writeAfter("Subagent failed", "\t", 100),
        Scene.action.writeAfter("Subagent failed ▸", "\r"),
        Scene.action.writeAfterDelay("\u0003", 800),
      ],
    }).then((result) => {
      const screen = finalTranscriptScreen(result.rawOutput).join("\n")
      expect(result.output).toContain("✕ Subagent failed")
      expect(finalScreenShows(result.rawOutput, "Language model not registered"), screen).toBe(true)
      expect(finalScreenShows(result.rawOutput, "Subagent finished"), screen).toBe(false)
      expectScriptedModel(result)
    }),
  45_000,
)

test(
  "expands a depth-two subagent to its nested tool and single failure terminal",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Coordinate the failing grandchild." }, "depth-one")]),
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Run the grandchild that fails." }, "depth-two")]),
        Scene.model.turn([
          Scene.model.toolCall("read", { path: "missing-grandchild-file.ts", read_range: [1, 20] }, "grandchild-read"),
        ]),
        Scene.model.failure("grandchild boundary failure"),
        Scene.model.text("Depth one reported the failed grandchild."),
        Scene.model.text("Parent received the nested failure."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Coordinate the failing grandchild.\r"),
        Scene.action.writeAfter("Parent received the nested failure.", "\t", 150),
        Scene.action.writeAfterDelay("\r", 150),
        Scene.action.writeAfter("Depth one reported the failed grandchild.", "\t", 150),
        Scene.action.writeAfterDelay("\r", 300),
        Scene.action.writeAfter("grandchild boundary failure", "\u0003", 300),
      ],
    }).then((result) => {
      const screen = finalTranscriptScreen(result.rawOutput).join("\n")
      expect(finalScreenShows(result.rawOutput, "✕ Read missing-grandchild-file.ts"), screen).toBe(true)
      expect(finalScreenShows(result.rawOutput, "grandchild boundary failure"), screen).toBe(true)
      expect(finalScreenCount(result.rawOutput, "grandchild boundary failure"), screen).toBe(1)
      expectScriptedModel(result)
    }),
  45_000,
)

test(
  "moves selection between parallel subagents and expands each response independently",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("task", { prompt: "Inspect parallel alpha." }, "parallel-alpha"),
          Scene.model.toolCall("task", { prompt: "Inspect parallel beta." }, "parallel-beta"),
        ]),
        Scene.model.text("## Alpha response\n\nALPHA_DETAIL", 100),
        Scene.model.text("## Beta response\n\nBETA_DETAIL", 100),
        Scene.model.text("PARALLEL_TURN_COMPLETE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Inspect alpha and beta in parallel.\r"),
        Scene.action.writeAfter("PARALLEL_TURN_COMPLETE", "\t", 100),
        Scene.action.writeAfter("Subagent finished ▸", "\r"),
        Scene.action.writeAfter("Alpha response", "\t"),
        Scene.action.writeAfter("Subagent finished ▸", "\r"),
        Scene.action.writeAfter("Beta response", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Inspect parallel alpha.")
      expect(result.output).toContain("Inspect parallel beta.")
      expect(result.output).toContain("ALPHA_DETAIL")
      expect(result.output).toContain("BETA_DETAIL")
      expectScriptedModel(result)
    }),
  45_000,
)
