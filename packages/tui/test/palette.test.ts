import { describe, expect, test } from "bun:test"
import { Keys, Palette } from "../src/index"

describe("palette.filter", () => {
  test("returns every command for an empty query", () => {
    expect(Palette.filter("")).toEqual(Palette.commands)
  })

  test("narrows by id, action, command, and hint, ignoring a leading slash", () => {
    expect(Palette.filter("/mode").map((command) => command.id)).toEqual(["mode-rush", "mode-smart", "mode-deep"])
    expect(Palette.filter("authenticate").map((command) => command.id)).toEqual(["mcp-authenticate"])
    expect(Palette.filter("ast-grep outline").map((command) => command.id)).toEqual(["ast-grep-outline-status"])
    expect(Palette.filter("switch threads").map((command) => command.id)).toEqual(["thread-switch"])
  })

  test("does not advertise IDE connection commands", () => {
    expect(Palette.commands.some((command) => command.command.startsWith("/ide"))).toBe(false)
    expect(Palette.filter("connect IDE")).toEqual([])
  })

  test("at clamps the selected index into range", () => {
    expect(Palette.at("/mode", 0)?.id).toBe("mode-rush")
    expect(Palette.at("/mode", 99)?.id).toBe("mode-deep")
    expect(Palette.at("definitely-not-a-command", 0)).toBeUndefined()
  })
})

describe("keys", () => {
  test("fromOpenTui keeps Command separate from Option", () => {
    expect(Keys.fromOpenTui({ name: "t", option: true, sequence: "t" }).alt).toBe(true)
    expect(Keys.fromOpenTui({ name: "t", meta: true, sequence: "t" }).alt).toBe(true)
    expect(Keys.fromOpenTui({ name: "t", meta: true, sequence: "t" }).meta).toBe(false)
    expect(Keys.fromOpenTui({ name: "t", super: true, sequence: "t" }).meta).toBe(true)
    expect(Keys.fromOpenTui({ name: "t", sequence: "t" }).alt).toBe(false)
  })

  test("isPrintable rejects control, option, and command combinations", () => {
    expect(Keys.isPrintable(Keys.make({ name: "a", sequence: "a" }))).toBe(true)
    expect(Keys.isPrintable(Keys.make({ name: "space", sequence: " " }))).toBe(true)
    expect(Keys.isPrintable(Keys.ctrl("a"))).toBe(false)
    expect(Keys.isPrintable(Keys.alt("a"))).toBe(false)
    expect(Keys.isPrintable(Keys.make({ name: "c", meta: true, sequence: "c" }))).toBe(false)
    expect(Keys.isPrintable(Keys.make({ name: "c", sequence: "c", eventType: "release" }))).toBe(false)
    expect(Keys.isPrintable(Keys.make({ name: "return", sequence: "\r" }))).toBe(false)
  })
})
