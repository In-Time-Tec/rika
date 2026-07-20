import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "presents ordered local tool families, grouped failures, and completed edits in the real TUI",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("write", { path: "alpha.txt", content: "alpha\n" }, "create-alpha"),
          Scene.model.toolCall("write", { path: "beta.txt", content: "beta\n" }, "create-beta"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("read", { path: "alpha.txt", read_range: [1, 1] }, "read-alpha"),
          Scene.model.toolCall("grep", { pattern: "alpha", regex: false }, "grep-alpha"),
          Scene.model.toolCall("find_files", { query: "beta" }, "find-beta"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("edit", { path: "alpha.txt", old_str: "alpha", new_str: "ALPHA" }, "edit-alpha"),
          Scene.model.toolCall("write", { path: "gamma.txt", content: "gamma\n" }, "create-gamma"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("bash", { command: "printf shell-output" }, "shell-pass"),
          Scene.model.toolCall("bash", { command: "printf shell-failure; exit 7" }, "shell-fail"),
        ]),
        Scene.model.text("DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Exercise local tool presentation.\r"),
        Scene.action.writeAfter("DONE", "\u0003", 1_000),
      ],
    }).then((result) => {
      const output = result.output
      expect(output).toContain("Created 2 files +2")
      expect(output).toContain("Explored 1 file, 2 searches")
      expect(output).toContain("2 files +2 -1")
      expect(output).toContain("Ran 2 commands, 1 failed")
      expect(output).not.toMatch(/write|read|find_files|edit/)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "expands and collapses completed groups without duplicating their tool rows",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("write", { path: "one.txt", content: "one\n" }, "create-one"),
          Scene.model.toolCall("write", { path: "two.txt", content: "two\n" }, "create-two"),
        ]),
        Scene.model.text("Expansion ready."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Create two files.\r"),
        Scene.action.writeAfter("Expansion ready.", "\t", 100),
        Scene.action.writeAfter("Created 2 files +2 ▸", "\r", 100),
        Scene.action.writeAfter("one.txt", "\r", 100),
        Scene.action.writeAfter("Created", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Created 2 files +2 ▾")
      expect(result.output).toContain("Create one.txt +1 ▸")
      expect(result.output).toContain("Create two.txt +1 ▸")
      expect(result.output.lastIndexOf("Created 2 files +2 ▸")).toBeGreaterThan(
        result.output.lastIndexOf("Created 2 files +2 ▾"),
      )
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
