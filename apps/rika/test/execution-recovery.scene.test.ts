import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "reopens a running turn after the TUI client restarts and shows its durable completion",
  () =>
    Scene.run({
      script: [Scene.model.text("RECOVERED_AFTER_RESTART", 1_000)],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "RECOVERY_PROMPT\r"),
        Scene.action.restartWhenTurn("RECOVERY_PROMPT", "running", "threads", "continue", "--last"),
        Scene.action.writeAfter("RECOVERED_AFTER_RESTART", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("RECOVERED_AFTER_RESTART")
      expect(result.output).not.toContain("No previous thread")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  20_000,
)

test(
  "replays from the stored cursor after restart between a completed tool and the final answer",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("shell", { command: "printf", args: ["DURABLE_TOOL_RESULT"] }, "recovery-tool"),
        ]),
        Scene.model.text("ANSWER_AFTER_TOOL_REPLAY", 1_000),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run the recovery marker.\r"),
        Scene.action.restartAfter("DURABLE_TOOL_RESULT", "threads", "continue", "--last"),
        Scene.action.writeAfter("ANSWER_AFTER_TOOL_REPLAY", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("DURABLE_TOOL_RESULT")
      expect(result.output).toContain("ANSWER_AFTER_TOOL_REPLAY")
      expect(result.output).not.toContain("Transcript event cursor did not advance")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  20_000,
)

test(
  "keeps a failed tool terminal while recovery continues to a successful answer",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "shell",
            { command: "sh", args: ["-c", "printf FAILED_TOOL_MARKER; exit 7"] },
            "failed-tool",
          ),
        ]),
        Scene.model.text("RECOVERED_FROM_FAILED_TOOL", 1_000),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Exercise failed tool recovery.\r"),
        Scene.action.restartAfter("FAILED_TOOL_MARKER", "threads", "continue", "--last"),
        Scene.action.writeAfter("RECOVERED_FROM_FAILED_TOOL", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("exit code: 7")
      expect(result.output).toContain("RECOVERED_FROM_FAILED_TOOL")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  15_000,
)

test(
  "settles cancelled subagent spinners durably so restart shows no working subagents",
  () =>
    Scene.run({
      script: [
        Scene.model.turn(
          ["alpha", "beta"].map((name) =>
            Scene.model.toolCall("task", { prompt: `Wait in ${name}.` }, `stuck-${name}`),
          ),
        ),
        ...["alpha", "beta"].map((name) => Scene.model.text(`LATE_${name.toUpperCase()}`, 20_000)),
        ...["alpha", "beta"].map((name) => Scene.model.object({ summary: `LATE_${name.toUpperCase()}`, files: [] })),
        Scene.model.text("Parent must not publish this response."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Start two slow checks.\r"),
        Scene.action.writeAfterChildExecutions("running", 2, "\u0003"),
        Scene.action.restartAfter("cancelled", "threads", "continue", "--last"),
        Scene.action.writeAfter("Subagent cancelled", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.childExecutions).toHaveLength(2)
      expect(result.output).toContain("Subagent cancelled")
      expect(result.output).not.toContain("Parent must not publish this response.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  60_000,
)

test(
  "keeps a completed turn terminal after restart and admits the next prompt",
  () =>
    Scene.run({
      script: [
        Scene.model.text("TERMINAL_BEFORE_RESTART"),
        Scene.model.text("Recovery title"),
        Scene.model.text("NEXT_TURN_AFTER_RESTART"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Complete before replacement.\r"),
        Scene.action.restartAfter("TERMINAL_BEFORE_RESTART", "threads", "continue", "--last"),
        Scene.action.writeAfter("TERMINAL_BEFORE_RESTART", "Start the next turn.\r"),
        Scene.action.writeAfter("NEXT_TURN_AFTER_RESTART", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("TERMINAL_BEFORE_RESTART")
      expect(result.output).toContain("NEXT_TURN_AFTER_RESTART")
      expect(result.output).not.toContain("Transcript event cursor did not advance")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  20_000,
)
