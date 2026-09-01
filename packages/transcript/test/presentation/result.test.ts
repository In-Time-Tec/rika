import { expect, test } from "vitest"
import { formatResult } from "../../src/presentation/result"

test("result formatting keeps scalars compact", () => {
  expect(formatResult(null)).toBe("null")
  expect(formatResult(true)).toBe("true")
  expect(formatResult(42)).toBe("42")
  expect(formatResult("done")).toBe('"done"')
  expect(formatResult("first\nsecond")).toBe("first\nsecond")
})

test("result formatting expands arrays and records", () => {
  expect(formatResult([])).toBe("[]")
  expect(formatResult({})).toBe("{}")
  expect(formatResult({ status: "complete", count: 2 })).toBe(`{
  "status": "complete",
  "count": 2
}`)
  expect(formatResult(["read", "edit", "bash", "status"])).toBe(`[
  "read",
  "edit",
  "bash",
  "status"
]`)
})
