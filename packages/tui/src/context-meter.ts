import { Function } from "effect"

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
  readonly highlight?: number
}

const partialGlyphs = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const

export const usableTokens = (reading: Reading): number => Math.max(0, reading.contextWindow - reading.reserveTokens)

export const pressure = (reading: Reading): number => {
  const usable = usableTokens(reading)
  if (usable === 0) return reading.inputTokens > 0 ? 1 : 0
  return Math.max(0, reading.inputTokens / usable)
}

interface MeterOptions {
  readonly cells?: number
  readonly phase?: number
  readonly animated?: boolean
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
    const scaled = bounded * cells
    const full = Math.floor(scaled)
    const fraction = scaled - full
    const partial = full < cells ? partialGlyphs[Math.floor(fraction * partialGlyphs.length)]! : ""
    const glyphs = Array.from({ length: cells }, (_, index) => {
      if (index < full) return "█"
      if (index === full && partial.length > 0) return partial
      return "░"
    })
    const filled = Math.min(cells, Math.max(1, full + (partial.length > 0 ? 1 : 0)))
    let tone: Tone = "calm"
    if (value >= 0.9) tone = "critical"
    else if (value >= 0.7) tone = "warning"
    return {
      glyphs,
      pressure: value,
      percent: Math.min(100, Math.round(value * 100)),
      tone,
      ...(options.animated === true ? { highlight: Math.abs(Math.floor(options.phase ?? 0)) % filled } : {}),
    }
  },
)

interface LoadingMeterOptions {
  readonly cells?: number
}

export const loadingMeter: {
  (phase: number, options?: LoadingMeterOptions): ReadonlyArray<string>
  (options?: LoadingMeterOptions): (phase: number) => ReadonlyArray<string>
} = Function.dual(
  (args) => typeof args[0] === "number",
  (phase: number, options: LoadingMeterOptions = {}): ReadonlyArray<string> => {
    const width = Math.max(1, Math.floor(options.cells ?? 8))
    const highlight = Math.abs(Math.floor(phase)) % width
    return Array.from({ length: width }, (_, index) => (index === highlight ? "◆" : "·"))
  },
)
