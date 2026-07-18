import { expect, test } from "vitest"
import { Scene } from "./scene"

const quit = Scene.action.writeAfter("Welcome to Rika", "\u0003", 100)

test("renders every advertised shortcut without unreachable archive or double-quit bindings", () =>
  Scene.run({
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "?"),
      Scene.action.writeAfter("open selected thread", "\u0003", 100),
    ],
  }).then((result) => {
    for (const binding of [
      "Ctrl+O",
      "Ctrl+R",
      "Ctrl+V",
      "Shift+Enter",
      "Ctrl+S",
      "Ctrl+G",
      "Opt+T",
      "@ / @@",
      "Tab/Shift+Tab",
      "?",
      "Opt+S",
      "Enter",
    ])
      expect(result.output).toContain(binding)
    expect(result.output).not.toContain("Cmd+Shift+E")
    expect(result.output).not.toContain("Ctrl+C Ctrl+C")
  }))

test("renders the shortcut reference in a tiny terminal", () =>
  Scene.run({
    terminal: { columns: 40, rows: 12 },
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "?"),
      Scene.action.writeAfter("edit in $EDITOR", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).toContain("command palette")
    expect(result.output).toContain("edit in $EDITOR")
  }))

test("keeps editing the triggering draft and Escape returns it to the composer", () =>
  Scene.run({
    response: "DRAFT_ACCEPTED",
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "?"),
      Scene.action.writeAfter("toggle this help", "draft"),
      Scene.action.writeAfter("draft", "\u001b"),
      Scene.action.writeAfter("?draft", "\r"),
      Scene.action.writeAfter("DRAFT_ACCEPTED", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).toContain("?draft")
    expect(result.output).toContain("DRAFT_ACCEPTED")
  }))

test("does not trigger help from a non-empty draft", () =>
  Scene.run({
    response: "QUESTION_ACCEPTED",
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "draft?\r"),
      Scene.action.writeAfter("QUESTION_ACCEPTED", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).toContain("draft?")
    expect(result.output).not.toContain("toggle this help")
  }))

test("reaches the command palette and its rendered quit binding", () =>
  Scene.run({
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "\u000f"),
      Scene.action.writeAfter("toggle fast mode", "\u0003"),
    ],
  }).then((result) => {
    expect(result.output).toContain("Command Palette")
    expect(result.output).toContain("Ctrl+C")
    expect(result.output).not.toContain("Ctrl+C Ctrl+C")
  }))

test("reaches prompt history after a completed turn", () =>
  Scene.run({
    script: [Scene.model.text("HISTORY_READY")],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "remember this\r"),
      Scene.action.writeAfter("HISTORY_READY", "rem"),
      Scene.action.writeAfter("rem", "\u0012"),
      { write: "\u0003", delayMs: 300 },
    ],
  }).then((result) => {
    expect(result.output).toContain("remember this")
  }))

test("reaches image paste and external editor handling without external services", () =>
  Scene.run({
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "\u0016"),
      Scene.action.writeAfter("Clipboard does not contain a supported non-empty PNG image", "\u0007"),
      Scene.action.writeAfter("Set VISUAL or EDITOR to edit the prompt", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).toContain("Clipboard does not contain a supported non-empty PNG image")
    expect(result.output).toContain("Set VISUAL or EDITOR to edit the prompt")
  }))

test("reaches mode, file tree, and changed-files sidebar bindings", () =>
  Scene.run({
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "\u0013"),
      Scene.action.writeAfter("GPT-5.6 Sol", "\u001b"),
      Scene.action.writeAfter("Welcome to Rika", "\u001bt"),
      Scene.action.writeAfter("Files (0)", "\u001bs"),
      Scene.action.writeAfter("Changed files", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).toContain("GPT-5.6 Sol")
    expect(result.output).toContain("Files (0)")
    expect(result.output).toContain("Changed files")
  }))

test("reaches file and thread mention bindings", () =>
  Scene.run({
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "@"),
      Scene.action.writeAfter("Loading files", "\u001b"),
      Scene.action.writeAfter("Welcome to Rika", "@@"),
      Scene.action.writeAfter("Mention Thread", "\u001b"),
      quit,
    ],
  }).then((result) => {
    expect(result.output).toContain("Loading files")
    expect(result.output).toContain("Mention Thread")
  }))

test("reaches multiline input, help toggle, transcript navigation, and selected-thread open keys", () =>
  Scene.run({
    response: "KEYS_ACCEPTED",
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "first\u001b[13;2usecond\r"),
      Scene.action.writeAfter("KEYS_ACCEPTED", "\t\u001b[Z"),
      Scene.action.writeAfter("KEYS_ACCEPTED", "?"),
      Scene.action.writeAfter("toggle this help", "?"),
      Scene.action.writeAfter("KEYS_ACCEPTED", "\u001c"),
      Scene.action.writeAfterDelay("\u001c", 300),
      Scene.action.writeAfterDelay("\r", 300),
      Scene.action.writeAfterDelay("\u0003", 500),
    ],
  }).then((result) => {
    expect(result.output).toContain("first")
    expect(result.output).toContain("second")
    expect(result.output).toContain("KEYS_ACCEPTED")
  }))
