import { expect, test } from "vitest"
import { Scene } from "./scene"

const longTitle = `### "${"Concurrent Sanitized Title ".repeat(5)}"\nignored`
const sanitizedTitle = [..."Concurrent Sanitized Title ".repeat(5).trim()].slice(0, 80).join("")

test(
  "titles the first Turn of an explicitly created Thread in the real TUI",
  () =>
    Scene.run({
      script: [Scene.model.text("FIRST_TURN_DONE"), Scene.model.text("Focused Thread Titles")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000f"),
        Scene.action.writeAfter("New thread", "\r"),
        Scene.action.writeAfter("Loading Thread", "Build automatic thread titles.\r"),
        Scene.action.writeAfter("FIRST_TURN_DONE", "\u0014", 500),
        Scene.action.writeAfter("Focused Thread Titles", "\u0003"),
      ],
    }).then((result) => {
      expect(result.output).toContain("Focused Thread Titles")
      expect(result.diagnostics).not.toContain("provider.request.started")
    }),
  40_000,
)

test(
  "sanitizes and bounds a delayed title while the real TUI switches Threads",
  () =>
    Scene.run({
      script: [Scene.model.text("SWITCH_READY"), Scene.model.text(longTitle, 700)],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Investigate concurrent title delivery.\r"),
        Scene.action.writeAfter("SWITCH_READY", "\u000f"),
        Scene.action.writeAfter("New thread", "\r"),
        Scene.action.writeAfter("Loading Thread", "\u0014", 1_000),
        Scene.action.writeAfter("Concurrent Sanitized Title", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Concurrent Sanitized Title")
      expect(sanitizedTitle).toHaveLength(80)
      expect(result.output).not.toContain("ignored")
      expect(result.diagnostics).not.toContain("provider.request.started")
    }),
  40_000,
)

test(
  "keeps the first-prompt title when the scripted title response sanitizes to empty",
  () =>
    Scene.run({
      script: [Scene.model.text("EMPTY_TITLE_READY"), Scene.model.text('### ""\nignored')],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Keep This Temporary Title\r"),
        Scene.action.writeAfter("EMPTY_TITLE_READY", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Keep This Temporary Title")
      expect(result.output).not.toContain("ignored")
      expect(result.diagnostics).not.toContain("provider.request.started")
    }),
  40_000,
)
