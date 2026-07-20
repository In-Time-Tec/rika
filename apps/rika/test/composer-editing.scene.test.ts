import { expect, test } from "vitest"
import { Scene } from "./scene"

const assertIsolatedModel = (diagnostics: string) =>
  expect(diagnostics).not.toContain('"rika.model.backend.kind":"provider"')

test(
  "edits at the cursor, recalls history, searches history, and preserves an in-progress draft",
  () =>
    Scene.runWarm({
      script: [
        Scene.model.text("EDIT_OK"),
        Scene.model.text("SECOND_OK"),
        Scene.model.text("HISTORY_OK"),
        Scene.model.text("SEARCH_OK"),
        Scene.model.text("DRAFT_OK"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\rac\u001b[Db\r"),
        Scene.action.writeAfter("EDIT_OK", "second\r"),
        Scene.action.writeAfter("SECOND_OK", "\u001b[A\r"),
        Scene.action.writeAfter("HISTORY_OK", "bc\u0012\r"),
        Scene.action.writeAfter("SEARCH_OK", "draft\u001b[A\u001b[B-kept\r"),
        Scene.action.writeAfter("DRAFT_OK", "\u0003", 1_500),
      ],
    }).then((result) => {
      expect(result.output).toContain("abc")
      expect(result.output).toContain("second")
      expect(result.output).toContain("draft-kept")
      expect(result.output).toContain("DRAFT_OK")
      assertIsolatedModel(result.diagnostics)
    }),
  45_000,
)

test("submits every multiline shortcut and keeps a wrapped draft through terminal resize", () => {
  const wrapped = `resize-${"wide".repeat(28)}-draft-end`
  return Scene.runWarm({
    script: [
      Scene.model.text("SHIFT_ENTER_OK"),
      Scene.model.text("CTRL_J_OK"),
      Scene.model.text("BACKSLASH_OK"),
      Scene.model.text("RESIZE_OK"),
    ],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "alpha\u001b[13;2ubeta\r"),
      Scene.action.writeAfter("SHIFT_ENTER_OK", "gamma\u001b[106;5udelta\r"),
      Scene.action.writeAfter("CTRL_J_OK", "epsilon\\\rzeta\r"),
      Scene.action.writeAfter("BACKSLASH_OK", wrapped),
      Scene.action.resizeAfter("draft-end", 54, 18, "\r"),
      Scene.action.writeAfter("RESIZE_OK", "\u0003", 1_500),
    ],
  }).then((result) => {
    for (const text of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", wrapped, "RESIZE_OK"])
      expect(result.output).toContain(text)
    assertIsolatedModel(result.diagnostics)
  })
}, 45_000)

test(
  "round-trips a multiline draft through the configured external editor",
  () =>
    Scene.runWarm({
      editorContent: "edited first line\nedited second line\n",
      script: [Scene.model.text("EDITOR_OK")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "discard this\u0007"),
        Scene.action.writeAfter("edited second line", "\r"),
        Scene.action.writeAfter("EDITOR_OK", "\u0003", 1_500),
      ],
    }).then((result) => {
      expect(result.output).toContain("edited first line")
      expect(result.output).toContain("edited second line")
      expect(result.output).toContain("EDITOR_OK")
      assertIsolatedModel(result.diagnostics)
    }),
  45_000,
)

test(
  "keeps the draft usable when no external editor is configured",
  () =>
    Scene.runWarm({
      environment: { EDITOR: null, VISUAL: null },
      script: [Scene.model.text("NO_EDITOR_RECOVERY_OK")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "keep this draft\u0007"),
        Scene.action.writeAfter("Set VISUAL or EDITOR", "\r"),
        Scene.action.writeAfter("NO_EDITOR_RECOVERY_OK", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Set VISUAL or EDITOR")
      expect(result.output).toContain("keep this draft")
      expect(result.output).toContain("NO_EDITOR_RECOVERY_OK")
      assertIsolatedModel(result.diagnostics)
    }),
  45_000,
)

test(
  "does not submit empty input and restores a locally rejected draft until the user recovers",
  () =>
    Scene.runWarm({
      script: [Scene.model.text("RECOVERY_OK")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\r/missing-composer-scene.png\r"),
        Scene.action.writeAfter("Execution failed", "\r"),
        Scene.action.writeAfter("Execution failed", "\u0015recovered prompt\r"),
        Scene.action.writeAfter("RECOVERY_OK", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output.match(/Execution failed/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(result.output).toContain("recovered prompt")
      expect(result.output).toContain("RECOVERY_OK")
      assertIsolatedModel(result.diagnostics)
    }),
  45_000,
)
