import { expect, test, vi } from "vitest"
import { Scene } from "./scene"

const settings = (shell: "allow" | "ask" | "deny") => ({ permissions: { shell } })
vi.setConfig({ testTimeout: 45_000 })

test("runs a user shell command immediately when shell permission is allow", () =>
  Scene.run({
    workspaceSettings: settings("allow"),
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "$ printf 'ALLOW%s' ED | tee allowed.txt\r"),
      Scene.action.writeAfter("ALLOWED", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).not.toContain("Run shell command")
    expect(result.workspaceContents["allowed.txt"]).toBe("ALLOWED")
  }))

test("asks before a user shell command and runs it after one-time approval", () =>
  Scene.run({
    workspaceSettings: settings("ask"),
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "$ printf 'APPROV%s' ED | tee approved.txt\r"),
      Scene.action.writeAfter("Run shell command", "\r", 100),
      Scene.action.writeAfter("APPROVED", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).toContain("Allow once")
    expect(result.output).toContain("Always")
    expect(result.output).toContain("Deny")
    expect(result.workspaceContents["approved.txt"]).toBe("APPROVED")
  }))

test("refuses a user shell command without starting it", () =>
  Scene.run({
    workspaceSettings: settings("ask"),
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "$ printf BYPASS > refused.txt\r"),
      Scene.action.writeAfter("Run shell command", "\t\t\r", 100),
      Scene.action.writeAfter("Shell command denied", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.workspaceContents).not.toHaveProperty("refused.txt")
  }))

test("denies a user shell command without offering an approval bypass", () =>
  Scene.run({
    workspaceSettings: settings("deny"),
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "$ printf BYPASS > denied.txt\r"),
      Scene.action.writeAfter("Shell command denied", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).not.toContain("Allow once")
    expect(result.workspaceContents).not.toHaveProperty("denied.txt")
  }))

test("cancelling a pending shell prompt does not grant permission or run the command", () =>
  Scene.run({
    workspaceSettings: settings("ask"),
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "$ printf BYPASS > cancelled.txt\r"),
      Scene.action.writeAfter("Run shell command", "\u0003", 250),
      Scene.action.writeAfter("Shell command denied", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.workspaceContents).not.toHaveProperty("cancelled.txt")
  }))

test("model-invoked built-in shell cannot bypass an ask policy", () =>
  Scene.run({
    workspaceSettings: settings("ask"),
    script: [
      Scene.model.turn([
        Scene.model.toolCall(
          "shell",
          { command: "sh", args: ["-lc", "printf MODEL_APPROVED > model-approved.txt"] },
          "model-shell",
        ),
      ]),
      Scene.model.text("Model shell completed."),
    ],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Use shell to create the marker.\r"),
      Scene.action.writeAfter("shell [pending]", "\r", 100),
      Scene.action.writeAfter("Model shell completed.", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.workspaceContents["model-approved.txt"]).toBe("MODEL_APPROVED")
    expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
  }))

test("model-invoked built-in shell cannot bypass a deny policy", () =>
  Scene.run({
    workspaceSettings: settings("deny"),
    script: [
      Scene.model.turn([
        Scene.model.toolCall(
          "shell",
          { command: "sh", args: ["-lc", "printf BYPASS > model-denied.txt"] },
          "denied-model-shell",
        ),
      ]),
      Scene.model.text("Denied model shell handled."),
    ],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Try shell despite denial.\r"),
      Scene.action.writeAfter("Denied model shell handled.", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).not.toContain("Allow once")
    expect(result.workspaceContents).not.toHaveProperty("model-denied.txt")
    expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
  }))

test("restarting at a durable shell wait does not approve or duplicate the command", () =>
  Scene.run({
    workspaceSettings: settings("ask"),
    script: [
      Scene.model.turn([
        Scene.model.toolCall(
          "shell",
          { command: "sh", args: ["-lc", "printf BYPASS > restarted.txt"] },
          "restarted-shell",
        ),
      ]),
      Scene.model.text("RESTART_REFUSED"),
    ],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Try shell across restart.\r"),
      Scene.action.restartAfter("shell [pending]", "threads", "continue", "--last"),
      Scene.action.writeAfter("shell [pending]", "\t\t\r", 100),
      Scene.action.writeAfter("REFUSED", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.workspaceContents).not.toHaveProperty("restarted.txt")
    expect(result.output).toContain("shell [pending]")
    expect(result.output).toContain("shell [denied]")
    expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
  }))

test("read-only specialists cannot acquire shell by asking or by naming it directly", () =>
  Scene.run({
    workspaceSettings: settings("allow"),
    script: [
      Scene.model.turn([Scene.model.toolCall("oracle", { prompt: "Try to run shell." }, "oracle-shell")]),
      Scene.model.turn([
        Scene.model.toolCall(
          "shell",
          { command: "sh", args: ["-lc", "printf BYPASS > specialist-bypass.txt"] },
          "specialist-shell",
        ),
      ]),
      Scene.model.object({ answer: "Shell was unavailable.", evidence: [] }),
      Scene.model.text("Specialist narrowing checked."),
    ],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Ask Oracle to try shell.\r"),
      Scene.action.writeWhenTurnStatus("Ask Oracle to try shell.", "completed", "\u0003", 500),
    ],
  }).then((result) => {
    expect(result.workspaceContents).not.toHaveProperty("specialist-bypass.txt")
    expect(result.output).not.toContain("Run shell command")
    expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
  }))
