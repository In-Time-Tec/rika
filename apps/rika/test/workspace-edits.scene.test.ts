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
          Scene.model.toolCall("create_file", { path: "notes/utf8.txt", content: "café ☕\nsecond\n" }, "create"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("edit_file", { path: "notes/utf8.txt", oldText: "café ☕", newText: "你好 🌍" }, "edit"),
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
  "shows failed overwrite, stale, and ambiguous edits without changing files",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("create_file", { path: "anchor.txt", content: "same\nunique\nsame\n" }, "seed"),
        ]),
        Scene.model.turn([
          Scene.model.toolCall("create_file", { path: "anchor.txt", content: "overwritten" }, "overwrite"),
          Scene.model.toolCall("edit_file", { path: "anchor.txt", oldText: "missing", newText: "stale" }, "stale"),
          Scene.model.toolCall("edit_file", { path: "anchor.txt", oldText: "same", newText: "ambiguous" }, "ambiguous"),
        ]),
        Scene.model.text("WORKSPACE_REJECTIONS_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Try unsafe exact edits.\r"),
        Scene.action.writeAfter("WORKSPACE_REJECTIONS_DONE", "\u0003", 1_000),
      ],
      inspectPaths: ["anchor.txt"],
    }).then((result) => {
      expect(result.workspaceFiles["anchor.txt"]).toBe("same\nunique\nsame\n")
      expect(result.output.match(/✕/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(result.clientLogs.match(/"rika.event.type":"tool.result.received"/g)?.length ?? 0).toBeGreaterThanOrEqual(
        4,
      )
      isolated(result)
    }),
  45_000,
)

test(
  "keeps malformed and conflicting patches atomic in the real TUI stack",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("create_file", { path: "stable.txt", content: "stable\n" }, "seed")]),
        Scene.model.turn([
          Scene.model.toolCall(
            "apply_patch",
            {
              patchText:
                "*** Begin Patch\n*** Add File: transient.txt\n+created\n*** Update File: stable.txt\n@@\n-stale\n+changed\n*** End Patch",
            },
            "stale-patch",
          ),
        ]),
        Scene.model.turn([
          Scene.model.toolCall(
            "apply_patch",
            {
              patchText:
                "*** Begin Patch\n*** Add File: conflict.txt\n+created\n*** Delete File: ./conflict.txt\n*** End Patch",
            },
            "conflict-patch",
          ),
        ]),
        Scene.model.text("WORKSPACE_ATOMIC_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Try invalid atomic patches.\r"),
        Scene.action.writeAfter("WORKSPACE_ATOMIC_DONE", "\u0003", 1_000),
      ],
      inspectPaths: ["stable.txt", "transient.txt", "conflict.txt"],
    }).then((result) => {
      expect(result.workspaceFiles).toEqual({ "stable.txt": "stable\n", "transient.txt": null, "conflict.txt": null })
      expect(result.output.match(/✕/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      isolated(result)
    }),
  45_000,
)

test(
  "streams an apply-patch diff and replaces it with the completed edit",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("create_file", { path: "stream.txt", content: "before\n" }, "seed")]),
        Scene.model.turn(
          [
            Scene.model.toolCall(
              "apply_patch",
              {
                patchText: "*** Begin Patch\n*** Update File: stream.txt\n@@\n-before\n+after 🌱\n*** End Patch",
              },
              "stream-patch",
            ),
          ],
          200,
        ),
        Scene.model.text("WORKSPACE_STREAM_DONE"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Stream the workspace patch.\r"),
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
