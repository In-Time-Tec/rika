import { Function } from "effect"

/**
 * Every animated glyph in the surface resolves through `animationFrame`: give it an identity and
 * the elapsed milliseconds, get back the character to draw. Identity picks the family, the speed,
 * and the starting offset, so two rows animating at the same instant look different without any
 * per-row state, timer, or configuration. Reading elapsed time rather than counting ticks means a
 * late or dropped repaint self-corrects instead of permanently shifting the animation.
 */
export interface AnimationFamily {
  readonly frames: ReadonlyArray<string>
  readonly periodMillis: number
}

export const animationFamilies: ReadonlyArray<AnimationFamily> = [
  { frames: [...`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`], periodMillis: 80 },
  { frames: [...`∼≈≋≈`], periodMillis: 120 },
  { frames: [...`◜◝◞◟`], periodMillis: 110 },
  { frames: [...`▁▃▄▅▆▇▆▅▄▃`], periodMillis: 90 },
  { frames: [...`⣾⣽⣻⢿⡿⣟⣯⣷`], periodMillis: 70 },
  { frames: [...`◐◓◑◒`], periodMillis: 100 },
]

/** The repaint cadence. Frames are derived from elapsed time, so this only bounds smoothness. */
export const animationIntervalMillis = 60

/** The glyph drawn for a running row before the first repaint, and wherever animation is disabled. */
export const restingFrame = "⠭"

const seedOf = (key: string): number => {
  let seed = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    seed ^= key.charCodeAt(index)
    seed = Math.imul(seed, 16777619)
  }
  seed ^= seed >>> 15
  seed = Math.imul(seed, 2246822507)
  seed ^= seed >>> 13
  seed = Math.imul(seed, 3266489909)
  return (seed ^= seed >>> 16) >>> 0
}

const animationFrameImpl = (key: string, elapsedMillis: number): string => {
  const seed = seedOf(key)
  const family = animationFamilies[seed % animationFamilies.length]!
  const period = Math.max(40, family.periodMillis + ((seed >>> 8) % 50) - 25)
  const offset = (seed >>> 16) % family.frames.length
  const step = Math.floor(Math.max(0, elapsedMillis) / period) + offset
  return family.frames[step % family.frames.length]!
}

export const animationFrame: {
  (key: string, elapsedMillis: number): string
  (elapsedMillis: number): (key: string) => string
} = Function.dual(2, animationFrameImpl)
