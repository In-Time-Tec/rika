import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "runs the real TUI and tools inside an isolated workspace",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("shell", { command: "pwd", args: [] }, "workspace-pwd")]),
        Scene.model.text("Workspace checked."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Show the current workspace.\r"),
        Scene.action.writeAfter("Workspace checked.", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("rika-scene-")
      expect(result.output).not.toContain("Projects/rika/apps/rika")
    }),
  45_000,
)

test(
  "rejects when the TUI exits before every scripted action runs",
  () =>
    expect(
      Scene.run({
        actions: [
          Scene.action.writeAfter("Welcome to Rika", "\u0003"),
          Scene.action.writeAfter("This marker cannot appear", "\r"),
        ],
      }),
    ).rejects.toThrow(/completed 1 of 2 actions/),
  15_000,
)

test(
  "keeps a failed tool result and recovery prose in one deterministic transcript",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.reasoning("Checking the failing command."),
          Scene.model.toolCall(
            "shell",
            { command: "sh", args: ["-c", "printf deterministic-failure >&2; exit 7"] },
            "fail",
          ),
        ]),
        Scene.model.text("Recovered after the expected failure.", 100),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run the deterministic failing check.\r"),
        Scene.action.writeAfter("Recovered", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("exit code: 7")
      expect(result.output).toContain("Recovered")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
