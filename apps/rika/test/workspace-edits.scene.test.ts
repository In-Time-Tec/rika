import { expect, test } from "vitest"
import { Scene } from "./scene"

const isolated = (result: Awaited<ReturnType<typeof Scene.run>>) => {
  expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
}

test(
  "creates and exactly edits UTF-8 through the real TUI",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("write", { path: "notes/utf8.txt", content: "café ☕\nsecond\n" }, "create"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("edit", { path: "notes/utf8.txt", old_str: "café ☕", new_str: "你好 🌍" }, "edit"),
        ]),
        Scene.model.text("WORKSPACE_UTF8_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Create and edit the UTF-8 note.\r"),
        Scene.action.writeAfter("WORKSPACE_UTF8_DONE", "\u0003", 1_000),
      ],
      inspectPaths: ["notes/utf8.txt"],
    }).then((result) => {
      expect(result.workspaceFiles["notes/utf8.txt"]).toBe("你好 🌍\nsecond\n")
      expect(result.output).toContain("notes/utf8.txt")
      expect(result.output).toContain("Edited notes/utf8.txt")
      isolated(result)
    }),
  45_000,
)

test(
  "shows overwritten files and failed stale or ambiguous edits",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("write", { path: "anchor.txt", content: "same\nunique\nsame\n" }, "seed"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("write", { path: "anchor.txt", content: "overwritten" }, "overwrite"),
          Scene.model.toolCall("edit", { path: "anchor.txt", old_str: "missing", new_str: "stale" }, "stale"),
          Scene.model.toolCall("edit", { path: "anchor.txt", old_str: "same", new_str: "ambiguous" }, "ambiguous"),
        ]),
        Scene.model.text("WORKSPACE_REJECTIONS_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Try unsafe exact edits.\r"),
        Scene.action.writeAfter("WORKSPACE_REJECTIONS_DONE", "\u0003", 1_000),
      ],
      inspectPaths: ["anchor.txt"],
    }).then((result) => {
      expect(result.workspaceFiles["anchor.txt"]).toBe("overwritten")
      expect(result.output.match(/✕/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(result.clientLogs.match(/"rika.event.type":"tool.result.received"/g)?.length ?? 0).toBeGreaterThanOrEqual(
        4,
      )
      isolated(result)
    }),
  45_000,
)

test(
  "streams an exact edit and replaces it with the completed diff",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("write", { path: "stream.txt", content: "before\n" }, "seed")]),
        Scene.model.turn(
          [
            Scene.model.toolCall(
              "edit",
              { path: "stream.txt", old_str: "before\n", new_str: "after 🌱\n" },
              "stream-edit",
            ),
          ],
          200,
        ),
        Scene.model.text("WORKSPACE_STREAM_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Stream the workspace edit.\r"),
        Scene.action.checkRunningAfter("after 🌱", ""),
        Scene.action.writeAfter("WORKSPACE_STREAM_DONE", "\u0003", 1_000),
      ],
      inspectPaths: ["stream.txt"],
    }).then((result) => {
      expect(result.workspaceFiles["stream.txt"]).toBe("after 🌱\n")
      expect(result.output).toContain("Editing stream.txt")
      expect(result.output).toContain("Edited stream.txt")
      expect(result.output).toContain("after")
      isolated(result)
    }),
  45_000,
)
