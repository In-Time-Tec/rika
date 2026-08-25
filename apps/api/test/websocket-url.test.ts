import { describe, expect, it } from "@effect/vitest"
import { websocketUrl } from "../src/websocket-url"

describe("websocketUrl", () => {
  it("uses ws for local HTTP requests", () => {
    expect(websocketUrl("/api/v1/threads/socket", "http://127.0.0.1:3000/auth")).toBe(
      "ws://127.0.0.1:3000/api/v1/threads/socket",
    )
  })

  it("uses wss for HTTPS requests", () => {
    expect(websocketUrl("/api/v1/runners", "https://api.example.com/auth")).toBe("wss://api.example.com/api/v1/runners")
  })

  it("rejects non-HTTP request URLs", () => {
    expect(() => websocketUrl("/api/v1/runners", "file:///tmp/socket")).toThrow("Unsupported HTTP protocol: file:")
  })
})
