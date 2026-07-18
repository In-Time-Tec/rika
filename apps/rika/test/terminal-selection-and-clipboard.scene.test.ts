import { expect, test } from "vitest"
import { Scene } from "./scene"

const escape = String.fromCharCode(27)
const mouse = (button: number, column: number, row: number, release = false) =>
  `${escape}[<${button};${column};${row}${release ? "m" : "M"}`
const drag = (fromColumn: number, fromRow: number, toColumn: number, toRow: number) =>
  `${mouse(0, fromColumn, fromRow)}\0${mouse(32, toColumn, toRow, true)}\0${mouse(0, toColumn, toRow, true)}`
const click = (column: number, row: number) => `${mouse(0, column, row)}${mouse(0, column, row, true)}`

test(
  "copies a mouse selection from rendered content and confirms it without a provider",
  () =>
    Scene.run({
      response: "Selection scene target",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "show selection\r"),
        Scene.action.writeAfter("Selection scene target", drag(2, 25, 24, 25), 100),
        Scene.action.writeAfter("Selection copied to clipboard", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.clipboard).toHaveLength(1)
      expect(result.clipboard[0]).toContain("Selection scene target")
      expect(result.rawOutput).toContain("Selection copied to clipboard")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "does not copy or toast for an empty mouse selection",
  () =>
    Scene.run({
      actions: [Scene.action.writeAfter("Welcome to Rika", `${click(48, 10)}\u0003`, 100)],
    }).then((result) => {
      expect(result.clipboard).toEqual([])
      expect(result.output).not.toContain("Selection copied to clipboard")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "preserves the composer draft while selection copies rendered content",
  () =>
    Scene.run({
      response: "Draft survived selection.",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "render state target\r"),
        Scene.action.writeAfter("Draft survived selection.", "draft-before-"),
        Scene.action.writeAfter("draft-before-", drag(2, 25, 28, 25), 100),
        Scene.action.writeAfter("Selection copied to clipboard", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.clipboard).toHaveLength(1)
      expect(result.clipboard[0]).toContain("Draft survived selection.")
      expect(result.output).toContain("draft-before-")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "copies selected Unicode and protocol-looking transcript text as one OSC52 payload",
  () =>
    Scene.run({
      response: "Unicode café 漢字 🙂  ]52;c;not-an-escape\\  \n",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "show unicode\r"),
        Scene.action.writeAfter("Unicode café", drag(2, 25, 52, 25), 100),
        Scene.action.writeAfter("Selection copied to clipboard", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.clipboard).toHaveLength(1)
      expect(result.clipboard[0]).toContain("Unicode café 漢字 🙂")
      expect(result.clipboard[0]).toContain("]52;c;not-an-escape\\")
      expect(result.clipboard[0]).not.toMatch(/\s$/u)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
