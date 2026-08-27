import { describe, expect, test } from "vitest"
import * as ContextMeter from "../../../src/state/context/meter"
import { glyphFallbacks } from "../../../src/state/context/glyph"

const reading = (inputTokens: number): ContextMeter.Reading => ({
  inputTokens,
  contextWindow: 1_050_000,
  reserveTokens: 128_000,
})

describe("ContextMeter", () => {
  test("measures pressure against usable input capacity", () => {
    expect(ContextMeter.usableTokens(reading(208_294))).toBe(922_000)
    expect(ContextMeter.meter(reading(208_294))).toMatchObject({ percent: 23, tone: "calm" })
    expect(ContextMeter.meter(reading(700_000))).toMatchObject({ percent: 76, tone: "warning" })
    expect(ContextMeter.meter(reading(900_000))).toMatchObject({ percent: 98, tone: "critical" })
  })

  test("renders the v0.1.7 line-weight meter and bouncing scanner", () => {
    const idle = ContextMeter.meter(reading(208_294))
    expect(idle.glyphs).toHaveLength(8)
    expect(idle.glyphs.join("")).toBe("━━╌╌╌╌╌╌")
    expect(ContextMeter.loadingMeter(0).join("")).toBe("╌╌╌╌╌╌╌━")
    expect(ContextMeter.loadingMeter(7).join("")).toBe("━╌╌╌╌╌╌╌")
    expect(ContextMeter.loadingMeter(8).join("")).toBe("╌━╌╌╌╌╌╌")
  })

  test("renders deterministic muncher, vacuum, flash, and fallback glyphs", () => {
    expect(ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 0, muncher: true }).join("")).toBe(
      "━ᗧ······",
    )
    expect(ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 1, muncher: true }).join("")).toBe(
      "━ᗤ······",
    )
    expect(ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 0, flashTicks: 2 }).join("")).toBe(
      "━✦╌╌╌╌╌╌",
    )
    expect(ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 0, compactFromPercent: 75 })).toContain("≪")
    expect(glyphFallbacks).toEqual({ muncherOpen: "C", muncherClosed: "c" })
  })

  test("caps the visual indicator while preserving over-budget pressure", () => {
    expect(ContextMeter.meter(reading(1_000_000))).toMatchObject({
      glyphs: ["━", "━", "━", "━", "━", "━", "━", "━"],
      percent: 100,
      tone: "critical",
    })
    expect(ContextMeter.meter(reading(1_000_000)).pressure).toBeGreaterThan(1)
  })
})
