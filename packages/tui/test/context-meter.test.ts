import { describe, expect, test } from "vitest"
import * as ContextMeter from "../src/context-meter"

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

  test("renders a fixed-width whole-cell line-weight bar", () => {
    const value = ContextMeter.meter(reading(208_294))

    expect(value.glyphs).toHaveLength(8)
    expect(value.glyphs.join("")).toBe("━━╌╌╌╌╌╌")
    expect(ContextMeter.loadingMeter(0).join("")).toBe("╌╌╌╌╌╌╌━")
    expect(ContextMeter.loadingMeter(7).join("")).toBe("━╌╌╌╌╌╌╌")
  })

  test("uses deterministic scanner, muncher, vacuum, and flash glyphs", () => {
    expect(ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 0, streaming: true }).join("")).toBe(
      "━ᗧ······",
    )
    expect(ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 1, streaming: true }).join("")).toBe(
      "━ᗤ······",
    )
    expect(
      ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 0, compactFromPercent: 90 }).join(""),
    ).toContain("≪")
    expect(ContextMeter.animatedGlyphs(reading(208_294), { cells: 8, tick: 0, flashTicks: 2 }).join("")).toContain("✦")
  })

  test("exports the pinned ASCII muncher fallback", () => {
    expect(ContextMeter.glyphFallbacks).toEqual({ muncherOpen: "C", muncherClosed: "c" })
    expect(ContextMeter.muncherGlyphs).toEqual({ open: "ᗧ", closed: "ᗤ" })
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
