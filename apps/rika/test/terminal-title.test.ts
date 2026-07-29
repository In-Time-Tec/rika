import { expect, test } from "vitest"
import { terminalTitleSequence } from "../src/interactive-main"

test("formats safe terminal titles with the active thread and compact workspace", () => {
  expect(terminalTitleSequence("Prompt\u0007\u001b]0;spoof\n title", "/Users/rika/project")).toBe(
    "\u001b]0;Prompt ]0;spoof title - rika - ~/project\u0007",
  )
})

test("puts the working spinner before the active thread title", () => {
  expect(terminalTitleSequence("Prompt title", "/Users/rika/project", "⠭")).toBe(
    "\u001b]0;⠭ Prompt title - rika - ~/project\u0007",
  )
})
