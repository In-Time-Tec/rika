import { describe, expect, test } from "bun:test"
import { directoryPickerKind } from "./directory-picker-policy"

const local = {
  type: "rika",
  http: { url: "http://localhost:4096" },
  rika: { url: "ws://localhost:4096/server", token: "token", identity: "desktop" },
} as const
const remote = {
  type: "ssh",
  host: "example.test",
  http: { url: "http://localhost:4096" },
} as const

describe("directoryPickerKind", () => {
  test("uses the native picker only for local desktop projects", () => {
    expect(directoryPickerKind("desktop", local)).toBe("native")
    expect(directoryPickerKind("desktop", remote)).toBe("unavailable")
    expect(directoryPickerKind("web", local)).toBe("unavailable")
  })
})
