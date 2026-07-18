import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "opens the exclusive command palette with searchable commands and accurate keybindings",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000f"),
        Scene.action.writeAfter("Command Palette", "\u0003"),
      ],
    }).then((result) => {
      expect(result.output).toContain("thread  New thread")
      expect(result.output).toContain("thread  switch")
      expect(result.output).toContain("mode  change mode")
      expect(result.output).toContain("rika  toggle fast mode")
      expect(result.output).toContain("rika  quit")
      expect(result.output).toContain("Ctrl+T")
      expect(result.output).toContain("Ctrl+S")
      expect(result.output).toContain("Ctrl+C")
      expect(result.output).not.toContain("Ctrl+C Ctrl+C")
    }),
  45_000,
)

test(
  "keeps an unmatched query open without acting and recovers through Escape",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "draft\u000f"),
        Scene.action.writeAfter("Command Palette", "no such command\r"),
        Scene.action.checkRunningAfter("> no such command", "\u001b"),
        Scene.action.writeAfter("draft", "recovered", 100),
        Scene.action.writeAfter("recovered", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.runningChecks).toEqual([true])
      expect(result.output).toContain("> no such command")
      expect(result.output).toContain("recovered")
    }),
  45_000,
)

test(
  "filters commands, moves the selection, and runs the selected quit action",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000frika"),
        Scene.action.writeAfter("> rika", "\u001b[B\r"),
      ],
    }).then((result) => {
      expect(result.output).toContain("toggle fast mode")
      expect(result.output).toContain("quit")
      expect(result.output).not.toContain("mode  change mode")
      expect(result.output).not.toContain("thread  switch")
    }),
  45_000,
)

test(
  "runs the mode command and applies keyboard selection",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000fmode\r"),
        Scene.action.writeAfter("Balanced intelligence", "\u001b[C\r", 100),
        Scene.action.writeAfter("workspace", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Balanced intelligence")
      expect(result.output).toContain("── high")
    }),
  45_000,
)

test(
  "toggles fast mode and restores keyboard control to the composer",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000ffast\r"),
        Scene.action.writeAfter("workspace", "palette recovered", 100),
        Scene.action.writeAfter("palette recovered", "\u0003"),
      ],
    }).then((result) => {
      expect(result.output).toContain("↯")
      expect(result.output).toContain("palette recovered")
    }),
  45_000,
)

test(
  "creates a thread and transitions from the palette to the thread switcher",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000fnew thread\r"),
        Scene.action.writeAfter("Welcome to Rika", "\u000fswitch\r"),
        Scene.action.checkRunningAfter("New thread", "\u001b"),
        Scene.action.writeAfter("Welcome to Rika", "\u0003"),
      ],
    }).then((result) => {
      expect(result.runningChecks).toEqual([true])
      expect(result.output).toContain("Switch Thread")
      expect(result.output).toContain("New thread")
    }),
  45_000,
)
