import { expect, test } from "vitest"
import { Scene } from "./scene"

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
        Scene.model.object({ answer: "The projection boundary is sound.", evidence: [] }),
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
        Scene.model.object({ summary: "Transcript order checked.", files: [] }),
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
        Scene.model.object({ answer: "Nested ownership is correct.", evidence: [] }),
        Scene.model.text("Coordinator incorporated the nested review."),
        Scene.model.object({ summary: "Nested review coordinated.", files: [] }),
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
          Scene.model.toolCall("read_file", { path: "missing-parent-file.ts", offset: 0, limit: 20 }, "parent-read"),
          Scene.model.toolCall("grep", { pattern: "owner", regex: false }, "parent-grep"),
          Scene.model.toolCall("task", { prompt: "Inspect one child file." }, "file-inspector"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("read_file", { path: "missing-child-file.ts", offset: 0, limit: 20 }, "child-read"),
        ]),
        Scene.model.text("## Child inspection\n\nThe missing file result was handled."),
        Scene.model.object({ summary: "Child file inspected.", files: [] }),
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
  "shows a failed subagent state before the parent turn finishes",
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
        Scene.action.checkRunningAfter("Subagent working", ""),
        Scene.action.writeAfter("FAILED_TURN_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("✕ Subagent failed")
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
        Scene.model.object({ summary: "Alpha inspected.", files: [] }),
        Scene.model.object({ summary: "Beta inspected.", files: [] }),
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
