import { describe, expect, it } from "bun:test"
import type { RikaConnectionInput } from "./connection"

const input = {
  url: "ws://127.0.0.1:23456/server",
  token: "a".repeat(64),
  identity: "canonical-identity",
} satisfies RikaConnectionInput

describe("Rika connection input", () => {
  it("accepts only the browser-safe descriptor", () => {
    expect(input).toEqual({
      url: "ws://127.0.0.1:23456/server",
      token: "a".repeat(64),
      identity: "canonical-identity",
    })
    expect(Object.keys(input).sort()).toEqual(["identity", "token", "url"])
  })
})
