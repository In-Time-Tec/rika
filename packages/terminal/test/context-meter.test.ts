import { describe, expect, test } from "vitest"
<<<<<<< HEAD:packages/terminal/test/context-meter.test.ts
import * as ContextMeter from "../src/state/model/terminal-context-meter"
=======
import * as ContextMeter from "../src/context-meter"
import * as ViewState from "../src/view-state"
>>>>>>> origin/main:packages/tui/test/context-meter.test.ts

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
    expect(ContextMeter.meter(reading(4_400)).glyphs.join("")).toBe("━╌╌╌╌╌╌╌")
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

  test("renders each threshold flash once per turn and shrinks a vacuum from the retained fill", () => {
    const glyphs = (model: ViewState.Model) => {
      const context = model.contextUsage
      if (context?._tag !== "Available") return ContextMeter.loadingMeter(model.animationTick, { cells: 8 }).join("")
      return ContextMeter.animatedGlyphs(context, {
        cells: 8,
        tick: model.contextAnimation.compactTick ?? model.animationTick,
        ...(model.contextAnimation.compactFromPercent === undefined
          ? {}
          : { compactFromPercent: model.contextAnimation.compactFromPercent }),
        flashTicks: model.contextAnimation.flashTicks,
      }).join("")
    }
    const low = { _tag: "Available" as const, ...reading(600_000) }
    const at75 = { _tag: "Available" as const, ...reading(700_000) }
    const at90 = { _tag: "Available" as const, ...reading(850_000) }
    const compacted = { _tag: "Available" as const, ...reading(208_294) }
    let model: ViewState.Model = { ...ViewState.initial("/work"), busy: true, contextUsage: low }

    model = ViewState.update(model, { _tag: "ContextUsageReplaced", contextUsage: at75 })
    expect(glyphs(model)).toContain("✦")
    model = ViewState.update(model, { _tag: "AnimationTicked" })
    expect(glyphs(model)).toContain("✦")
    model = ViewState.update(model, { _tag: "AnimationTicked" })
    expect(glyphs(model)).not.toContain("✦")
    model = ViewState.update(model, { _tag: "ContextUsageReplaced", contextUsage: at75 })
    expect(glyphs(model)).not.toContain("✦")

    model = ViewState.update(model, { _tag: "ContextUsageReplaced", contextUsage: at90 })
    expect(glyphs(model)).toContain("✦")
    model = ViewState.update(model, { _tag: "AnimationTicked" })
    expect(glyphs(model)).toContain("✦")
    model = ViewState.update(model, { _tag: "AnimationTicked" })
    expect(glyphs(model)).not.toContain("✦")

    model = ViewState.update(model, { _tag: "TurnStarted", turnId: "next", prompt: "next" })
    model = ViewState.update(model, { _tag: "ContextUsageReplaced", contextUsage: low })
    model = ViewState.update(model, { _tag: "ContextUsageReplaced", contextUsage: at75 })
    expect(glyphs(model)).toContain("✦")

    model = ViewState.update(model, { _tag: "ContextUsageReplaced", contextUsage: at90 })
    model = ViewState.update(model, { _tag: "ContextUsageReplaced", contextUsage: compacted })
    const frames = [glyphs(model)]
    for (let tick = 0; tick < 5; tick += 1) {
      model = ViewState.update(model, { _tag: "AnimationTicked" })
      frames.push(glyphs(model))
    }
    expect(frames[0]).toContain("≪")
    expect(frames.some((frame) => frame !== frames[0] && frame.includes("≪"))).toBe(true)
    expect(frames.filter((frame) => frame.includes("≪")).length).toBeGreaterThan(1)
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
