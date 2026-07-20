import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "starts a long-running shell process and shows only new output on later polls",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "bash",
            {
              command: "printf PROCESS_STARTED; while [ ! -f release ]; do sleep 0.01; done; printf PROCESS_FINISHED",
              timeout_ms: 100,
            },
            "start-process",
          ),
        ]),
        Scene.model.turn([Scene.model.toolCall("bash", { command: "touch release" }, "release-process")]),
        Scene.model.turn([
          Scene.model.toolCall("shell_command_status", { processId: "1", waitMillis: 1_000 }, "poll-process"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("shell_command_status", { processId: "1", waitMillis: 0 }, "poll-completed-process"),
        ]),
        Scene.model.text("SHELL_LIFECYCLE_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Check a long-running shell process.\r"),
        Scene.action.writeAfter("SHELL_LIFECYCLE_DONE", "\u0003", 3_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("PROCESS_STARTED")
      expect(result.output).toContain("PROCESS_FINISHED")
      expect(result.clientLogs).toContain(":start-process:requested")
      expect(result.clientLogs).toContain(":poll-process:result")
      expect(result.clientLogs).toContain(":poll-completed-process:result")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "rejects a shell working directory outside the workspace without running the command",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("bash", { command: "printf ESCAPED_WORKSPACE", workdir: ".." }, "escaped-cwd"),
        ]),
        Scene.model.text("SHELL_CONTAINMENT_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Try an escaped shell directory.\r"),
        Scene.action.writeWhenTurnStatus("Try an escaped shell directory.", "completed", "\u0003", 1_000),
        Scene.action.writeAfterDelay("\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("$ printf ESCAPED_WORKSPACE (exit code: 1)")
      expect(result.clientLogs).toContain(":escaped-cwd:result")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
