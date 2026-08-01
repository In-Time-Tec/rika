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

  test("renders a fixed-width fractional bar with a deterministic active shimmer", () => {
    const idle = ContextMeter.meter(reading(208_294))
    const active = ContextMeter.meter(reading(208_294), { animated: true, phase: 1 })

    expect(idle.glyphs).toHaveLength(8)
    expect(idle.glyphs.join("")).toBe("█▊░░░░░░")
    expect(active.glyphs).toEqual(idle.glyphs)
    expect(active.highlight).toBe(1)
    expect(ContextMeter.loadingMeter(3).join("")).toBe("···◆····")
  })

  test("caps the visual indicator while preserving over-budget pressure", () => {
    expect(ContextMeter.meter(reading(1_000_000))).toMatchObject({
      glyphs: ["█", "█", "█", "█", "█", "█", "█", "█"],
      percent: 100,
      tone: "critical",
    })
    expect(ContextMeter.meter(reading(1_000_000)).pressure).toBeGreaterThan(1)
  })
})
