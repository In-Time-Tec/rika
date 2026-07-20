import { expect, test } from "vitest"
import { Scene } from "./scene"

const readTargetScript = (path: string) =>
  [
    Scene.model.turn([Scene.model.toolCall("read", { path, read_range: [3, 3] }, `read-${path}`)]),
    Scene.model.text("OPEN TARGET"),
  ] as const

const assertScriptedModel = (diagnostics: string) =>
  expect(diagnostics).not.toContain('"rika.model.backend.kind":"provider"')

const defaultApplication =
  process.platform === "darwin" ? "open" : process.platform === "win32" ? "powershell.exe" : "xdg-open"

const clickTarget = (after: string) => [
  Scene.action.writeAfter("Welcome to Rika", "Read the target.\r"),
  Scene.action.clickAfter("TARGET", 17, 23),
  Scene.action.clickRowsAfter(
    "Read",
    11,
    Array.from({ length: 25 }, (_, index) => 25 - index),
  ),
  Scene.action.writeAfter(after, "\u0003", 1_000),
]

test(
  "opens a clicked transcript target at its line and column while suspending and resuming the TUI",
  () =>
    Scene.run({
      workspace: { "target.ts": "one\ntwo\nthree\nfour\n" },
      executable: { name: "code", waitForInput: true },
      environment: { EDITOR: "code" },
      script: readTargetScript("target.ts"),
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Read the target.\r"),
        Scene.action.clickAfter("TARGET", 17, 23),
        Scene.action.clickRowsAfter(
          "target.ts",
          11,
          Array.from({ length: 25 }, (_, index) => 25 - index),
        ),
        Scene.action.checkRunningAfter("EDITOR ACTIVE", "x\n"),
        Scene.action.writeAfter("▸", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.opens).toHaveLength(1)
      expect(result.opens[0]?.[0]).toBe("--goto")
      expect(result.opens[0]?.[1]).toMatch(/\/workspace\/target\.ts:3:1$/)
      expect(result.output).toContain("OPEN TARGET")
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)

for (const [path, label] of [
  ["../outside.ts", "traversal"],
  ["/etc/passwd", "absolute"],
  ["missing.ts", "missing"],
] as const)
  test(
    `rejects a ${path} target without invoking the configured editor (${label})`,
    () =>
      Scene.run({
        executable: { name: "code" },
        environment: { EDITOR: "code" },
        script: readTargetScript(path),
        actions: clickTarget("Refusing to open a path outside the workspace"),
      }).then((result) => {
        expect(result.opens).toEqual([])
        expect(result.output).toContain("Refusing to open a path outside the workspace")
        assertScriptedModel(result.diagnostics)
      }),
    35_000,
  )

test(
  "refuses an outside symlink",
  () =>
    Scene.run({
      outsideFiles: { "outside.ts": "outside\n" },
      symlinks: [{ path: "outside-link.ts", target: "outside.ts", outside: true }],
      executable: { name: "code" },
      environment: { EDITOR: "code" },
      script: readTargetScript("outside-link.ts"),
      actions: clickTarget("Refusing to open a path outside the workspace"),
    }).then((result) => {
      expect(result.opens).toEqual([])
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)

test(
  "opens an inside symlink at its canonical workspace target",
  () =>
    Scene.run({
      workspace: { "inside.ts": "one\ntwo\nthree\n" },
      symlinks: [{ path: "inside-link.ts", target: "inside.ts" }],
      executable: { name: "code" },
      environment: { EDITOR: "code" },
      script: readTargetScript("inside-link.ts"),
      actions: clickTarget("▸"),
    }).then((result) => {
      expect(result.opens.length).toBeGreaterThan(0)
      expect(result.opens.every((arguments_) => arguments_[1]?.endsWith("/workspace/inside.ts:3:1") === true)).toBe(
        true,
      )
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)

test(
  "keeps a malicious shell-like path as one clickable target and one editor argument",
  () =>
    Scene.run({
      workspace: { "-;$(touch pwned) name.ts": "one\ntwo\nthree\n" },
      executable: { name: "code" },
      environment: { EDITOR: "code" },
      script: readTargetScript("-;$(touch pwned) name.ts"),
      actions: clickTarget("▸"),
    }).then((result) => {
      expect(result.output).toContain("-;$(touch pwned) name.ts")
      expect(result.opens.length).toBeGreaterThan(0)
      expect(
        result.opens.every((arguments_) => arguments_[1]?.endsWith("/workspace/-;$(touch pwned) name.ts:3:1") === true),
      ).toBe(true)
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)

test(
  "resumes with a visible failure when the configured editor is missing",
  () =>
    Scene.run({
      workspace: { "target.ts": "one\ntwo\nthree\n" },
      environment: { EDITOR: "missing-editor" },
      script: readTargetScript("target.ts"),
      actions: clickTarget("Could not open the file in the configured editor"),
    }).then((result) => {
      expect(result.opens).toEqual([])
      expect(result.output).toContain("Could not open the file in the configured editor")
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)

test(
  "resumes with a visible failure when the configured editor exits unsuccessfully",
  () =>
    Scene.run({
      workspace: { "target.ts": "one\ntwo\nthree\n" },
      executable: { name: "code", exitCode: 7 },
      environment: { EDITOR: "code" },
      script: readTargetScript("target.ts"),
      actions: clickTarget("Could not open the file in the configured editor"),
    }).then((result) => {
      expect(result.opens.length).toBeGreaterThan(0)
      expect(result.output).toContain("Could not open the file in the configured editor")
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)

test(
  "uses the platform default application when no editor is configured",
  () =>
    Scene.run({
      workspace: { "target.ts": "one\ntwo\nthree\n" },
      executable: { name: defaultApplication },
      environment: { VISUAL: null, EDITOR: null },
      script: readTargetScript("target.ts"),
      actions: clickTarget("▸"),
    }).then((result) => {
      expect(result.opens.length).toBeGreaterThan(0)
      expect(result.opens.every((arguments_) => arguments_.at(-1)?.endsWith("/workspace/target.ts") === true)).toBe(
        true,
      )
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)

test(
  "reports a platform default application failure",
  () =>
    Scene.run({
      workspace: { "target.ts": "one\ntwo\nthree\n" },
      executable: { name: defaultApplication, exitCode: 9 },
      environment: { VISUAL: null, EDITOR: null },
      script: readTargetScript("target.ts"),
      actions: clickTarget("Could not open the file in the default application"),
    }).then((result) => {
      expect(result.opens.length).toBeGreaterThan(0)
      expect(result.output).toContain("Could not open the file in the default application")
      assertScriptedModel(result.diagnostics)
    }),
  35_000,
)
