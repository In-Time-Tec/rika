import { expect, test } from "vitest"
import { Scene } from "./scene"

const askForShellPermission = { permissions: { shell: "ask" } }

test(
  "keeps empty shell prefixes in the composer and records completed shell input in history",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "$   \r"),
        Scene.action.writeAfter("$   ", "\u0015$   printf whitespace-$((20+1))\r"),
        Scene.action.writeAfter("whitespace-21", "\u001b[A"),
        Scene.action.writeAfter("$   printf whitespace-$((20+1))", "\u0003"),
      ],
    }).then((result) => {
      expect(result.output).toContain("whitespace-21")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "shows recorded shell output and preserves its composer history",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "$ printf recorded-$((20+2))\r"),
        Scene.action.writeAfter("recorded-22", "\u001b[A"),
        Scene.action.writeAfter("$ printf recorded-$((20+2))", "\u0003"),
      ],
    }).then((result) => {
      expect(result.output).toContain("recorded-22")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "shows incognito shell output and preserves its composer history",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "$$   printf incognito-$((20+3))\r"),
        Scene.action.writeAfter("incognito-23", "\u001b[A"),
        Scene.action.writeAfter("$$   printf incognito-$((20+3))", "\u0003"),
      ],
    }).then((result) => {
      expect(result.output).toContain("incognito-23")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "asks for shell permission, supports allow-once and always, and executes no model",
  () =>
    Scene.run({
      workspaceSettings: askForShellPermission,
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "$ printf allowed-$((20+1))\r"),
        Scene.action.writeAfter("Run shell command", "\r"),
        Scene.action.writeAfter("allowed-21", "$ printf always-$((20+2))\r"),
        Scene.action.writeAfter("Run shell command", "\u001b[C\r", 300),
        Scene.action.writeAfter("always-22", "$ printf remembered-$((20+3))\r"),
        Scene.action.writeAfter("remembered-23", "\u0003"),
      ],
    }).then((result) => {
      expect(result.output).toContain("Allow once")
      expect(result.output).toContain("Always")
      expect(result.output).toContain("remembered-23")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "denied and failed shell commands remain visible without invoking a model",
  () =>
    Scene.run({
      workspaceSettings: askForShellPermission,
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "$ printf should-not-run\r"),
        Scene.action.writeAfter("Run shell command", "\u001b[C\u001b[C\r"),
        Scene.action.writeAfter("[denied]", "$ printf failure-$((20+4)) >&2; exit 7\r"),
        Scene.action.writeAfter("failure-$((20+4)) >&2; exit 7", "\r", 300),
        Scene.action.writeAfter("failure-24", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Shell command denied")
      expect(result.output).toContain("failure-24")
      expect(result.output).toContain("exit 7")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
