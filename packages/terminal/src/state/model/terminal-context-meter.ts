import { Function } from "effect"
import { meterGlyphs, muncherGlyphs } from "./terminal-context-meter-glyph"

export interface Reading {
  readonly inputTokens: number
  readonly contextWindow: number
  readonly reserveTokens: number
}

export type Tone = "calm" | "warning" | "critical"

export interface Meter {
  readonly glyphs: ReadonlyArray<string>
  readonly pressure: number
  readonly percent: number
  readonly tone: Tone
}

export const usableTokens = (reading: Reading): number => Math.max(0, reading.contextWindow - reading.reserveTokens)

const pressure = (reading: Reading): number => {
  const usable = usableTokens(reading)
  if (usable === 0) return reading.inputTokens > 0 ? 1 : 0
  return Math.max(0, reading.inputTokens / usable)
}

interface MeterOptions {
  readonly cells?: number
}

export const meter: {
  (reading: Reading, options?: MeterOptions): Meter
  (options?: MeterOptions): (reading: Reading) => Meter
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "inputTokens" in args[0],
  (reading: Reading, options: MeterOptions = {}): Meter => {
    const cells = Math.max(1, Math.floor(options.cells ?? 8))
    const value = pressure(reading)
    const bounded = Math.min(1, value)
    const filled = Math.max(value > 0 ? 1 : 0, Math.min(cells, Math.round(bounded * cells)))
    const glyphs = Array.from({ length: cells }, (_, index) => (index < filled ? meterGlyphs.fill : meterGlyphs.track))
    let tone: Tone = "calm"
    if (value >= 0.9) tone = "critical"
    else if (value >= 0.7) tone = "warning"
    return { glyphs, pressure: value, percent: Math.min(100, Math.round(value * 100)), tone }
  },
)

export const loadingMeter: {
  (phase: number, options?: { readonly cells?: number }): ReadonlyArray<string>
  (options?: { readonly cells?: number }): (phase: number) => ReadonlyArray<string>
} = Function.dual(
  (args) => typeof args[0] === "number",
  (phase: number, options: { readonly cells?: number } = {}): ReadonlyArray<string> => {
    const width = Math.max(1, Math.floor(options.cells ?? 8))
    const period = Math.max(1, width * 2 - 2)
    const position = width === 1 ? 0 : Math.abs((Math.abs(Math.floor(phase)) % period) - (width - 1))
    return Array.from({ length: width }, (_, index) => (index === position ? meterGlyphs.scanner : meterGlyphs.track))
  },
)

export interface AnimatedMeterOptions {
  readonly cells: number
  readonly tick: number
  readonly streaming?: boolean
  readonly compactFromPercent?: number
  readonly flashTicks?: number
}

export const animatedGlyphs: {
  (reading: Reading, options: AnimatedMeterOptions): ReadonlyArray<string>
  (options: AnimatedMeterOptions): (reading: Reading) => ReadonlyArray<string>
} = Function.dual(2, (reading: Reading, options: AnimatedMeterOptions): ReadonlyArray<string> => {
  const value = meter(reading, { cells: options.cells })
  const filled = value.glyphs.filter((glyph) => glyph === meterGlyphs.fill).length
  const compactFrom =
    options.compactFromPercent === undefined ? filled : Math.round((options.compactFromPercent / 100) * options.cells)
  const visibleFill =
    compactFrom > filled
      ? Math.max(filled, compactFrom - Math.max(1, Math.floor((Math.abs(options.tick) + 1) / 2)))
      : filled
  return Array.from({ length: options.cells }, (_, index) => {
    if (compactFrom > filled && index === visibleFill) return meterGlyphs.vacuum
    if (index === filled - 1 && options.flashTicks !== undefined && options.flashTicks > 0) return meterGlyphs.flash
    if (index === filled - 1 && options.streaming === true)
      return options.tick % 2 === 0 ? muncherGlyphs.open : muncherGlyphs.closed
    if (index < visibleFill) return meterGlyphs.fill
    return options.streaming === true ? meterGlyphs.pellet : meterGlyphs.track
  })
})
