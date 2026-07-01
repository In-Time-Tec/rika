import { describe, expect, test } from "bun:test"
import { Keys, Palette } from "../src/index"

describe("palette.filter", () => {
  test("returns every base command for an empty query in a non-fast mode", () => {
    expect(Palette.filter("", "smart", false)).toEqual(Palette.commands)
  })

  test("narrows by id, action, command, and hint, ignoring a leading slash", () => {
    expect(Palette.filter("/mode", "smart", false).map((command) => command.id)).toEqual([
      "mode-rush",
      "mode-smart",
      "mode-deep1",
      "mode-deep2",
      "mode-deep3",
    ])
    expect(Palette.filter("authenticate", "smart", false).map((command) => command.id)).toEqual(["mcp-authenticate"])
    expect(Palette.filter("ast-grep outline", "smart", false).map((command) => command.id)).toEqual([
      "ast-grep-outline-status",
    ])
    expect(Palette.filter("switch threads", "smart", false).map((command) => command.id)).toEqual(["thread-switch"])
  })

  test("does not advertise IDE connection commands", () => {
    expect(Palette.commands.some((command) => command.command.startsWith("/ide"))).toBe(false)
    expect(Palette.filter("connect IDE", "smart", false)).toEqual([])
  })

  test("at clamps the selected index into range", () => {
    expect(Palette.at("/mode", 0, "smart", false)?.id).toBe("mode-rush")
    expect(Palette.at("/mode", 99, "smart", false)?.id).toBe("mode-deep3")
    expect(Palette.at("definitely-not-a-command", 0, "smart", false)).toBeUndefined()
  })
})

describe("palette speed command", () => {
  test("is offered in rush and deep modes but hidden in smart mode", () => {
    for (const mode of ["rush", "deep1", "deep2", "deep3"] as const) {
      expect(Palette.commandsFor(mode, false).some((command) => command.id === "speed-fast")).toBe(true)
    }
    expect(Palette.commandsFor("smart", false).some((command) => command.id === "speed-fast")).toBe(false)
  })

  test("label reflects the current fast toggle", () => {
    const off = Palette.commandsFor("deep2", false).find((command) => command.id === "speed-fast")
    const on = Palette.commandsFor("deep2", true).find((command) => command.id === "speed-fast")
    expect(off?.action).toBe("use fast (2.5x cost)")
    expect(on?.action).toBe("use standard speed")
    expect(off?.command).toBe("/fast")
    expect(off?.key).toBe("Opt+R")
  })

  test("is reachable through filter in an eligible mode", () => {
    expect(Palette.filter("speed", "rush", false).map((command) => command.id)).toEqual(["speed-fast"])
    expect(Palette.filter("speed", "smart", false)).toEqual([])
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
