import { describe, expect, it } from "@effect/vitest"
import { isInteractiveInvocation, openStartupPreview, startupFrame } from "../src/platform/client-entry-host"

describe("client startup preview", () => {
  it("paints only for invocations that enter the TUI", () => {
    expect(isInteractiveInvocation([])).toBe(true)
    expect(isInteractiveInvocation(["--workspace", "/repo", "--thread", "thread-1"])).toBe(true)
    expect(isInteractiveInvocation(["thread", "continue", "thread-1"])).toBe(true)
    expect(isInteractiveInvocation(["thread", "new"])).toBe(false)
    expect(isInteractiveInvocation(["--log-level", "debug", "auth", "status"])).toBe(false)
    expect(isInteractiveInvocation(["--no-tui", "--workspace", "/repo"])).toBe(false)
    expect(isInteractiveInvocation(["--help"])).toBe(false)
    expect(isInteractiveInvocation(["--completions", "bash"])).toBe(false)
    expect(isInteractiveInvocation(["--completions=bash"])).toBe(false)
  })

  it("emits one complete synchronized frame at bounded coordinates", () => {
    const frame = startupFrame({ columns: 80, rows: 24 })
    expect(frame).toContain("\u001b[?1049h")
    expect(frame).toContain("\u001b[12;33H")
    expect(frame).toContain("Welcome to Rika")
    expect(frame).toContain("\u001b[14;36H")
    expect(frame.endsWith("\u001b[?2026l")).toBe(true)
    expect(startupFrame({ columns: 1, rows: 1 })).toContain("\u001b[1;1H")
  })

  it("adopts a frame painted by the packaged launcher without painting it twice", () => {
    const originalWrite = process.stdout.write
    const output: string[] = []
    process.env.RIKA_STARTUP_PREVIEW = "native-v1"
    process.stdout.write = (chunk: string | Uint8Array) => {
      output.push(String(chunk))
      return true
    }
    try {
      const preview = openStartupPreview()
      expect(preview).toBeDefined()
      expect(process.env.RIKA_STARTUP_PREVIEW).toBeUndefined()
      expect(output).toEqual([])
      preview?.restore()
      expect(output).toEqual(["\u001b[?2026l\u001b[?25h\u001b[?1049l"])
    } finally {
      process.stdout.write = originalWrite
      delete process.env.RIKA_STARTUP_PREVIEW
    }
  })
})
